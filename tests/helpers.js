// Test harness: an isolated app instance (temp DB + data dir) on a random port,
// a cookie-aware client, and a local RFC 8030 mock push service that verifies
// VAPID JWTs and decrypts aes128gcm payloads like a real browser would.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { openDb } from '../server/db.js';
import { createApp } from '../server/app.js';
import { loadVapid, createSender } from '../server/services/push.js';

export function tmpDir(prefix = 'tradeos-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Fresh database per test. Default: in-memory embedded Postgres (PGlite).
 * With TEST_DATABASE_URL (e.g. postgres://postgres@127.0.0.1:55432/postgres) a
 * throwaway database is created on that real server and used via the `pg` driver.
 */
export async function testDb() {
  const admin = process.env.TEST_DATABASE_URL;
  if (!admin) return openDb({ url: null });
  const { default: pg } = await import('pg');
  const name = `tradeos_test_${crypto.randomBytes(6).toString('hex')}`;
  const c = new pg.Client({ connectionString: admin });
  await c.connect(); await c.query(`CREATE DATABASE ${name}`); await c.end();
  const u = new URL(admin); u.pathname = `/${name}`;
  return openDb({ url: u.toString() });
}

export async function startApp({ fetchImpl, now, agent } = {}) {
  const db = await testDb();
  const vapid = await loadVapid(db, {});
  const sender = createSender(vapid, { agent });
  const app = createApp(db, { vapid, sender, fetchImpl, now, cronSecret: 'test-cron-secret' });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { db, vapid, sender, base, close: async () => { await new Promise((r) => server.close(r)); await db.close(); } };
}

export function client(base) {
  let cookie = '';
  const call = async (method, url, body, { raw, headers = {}, noCsrf } = {}) => {
    const h = { ...headers };
    if (!noCsrf) h['X-TradeOS-Request'] = '1';
    if (cookie) h.Cookie = cookie;
    let payload;
    if (body !== undefined) {
      if (raw) payload = body;
      else { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    }
    const res = await fetch(base + url, { method, headers: h, body: payload });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0].endsWith('=') ? '' : sc.split(';')[0];
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json() : await res.arrayBuffer();
    return { status: res.status, data, headers: res.headers };
  };
  return {
    get: (u, o) => call('GET', u, undefined, o),
    post: (u, b, o) => call('POST', u, b ?? {}, o),
    put: (u, b, o) => call('PUT', u, b ?? {}, o),
    patch: (u, b, o) => call('PATCH', u, b ?? {}, o),
    del: (u, o) => call('DELETE', u, undefined, o),
    get cookie() { return cookie; },
  };
}

export async function registerUser(base, email, password = 'correct-horse-1') {
  const c = client(base);
  const r = await c.post('/api/auth/register', { email, password, displayName: email.split('@')[0] });
  if (r.status !== 201) throw new Error(`register failed ${r.status} ${JSON.stringify(r.data)}`);
  return { c, user: r.data.user };
}

// ---- mock push service --------------------------------------------------------

/** A browser-side subscription keypair (what PushManager.subscribe creates). */
export function makeSubscriberKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return { ecdh, p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url'), authBuf: auth };
}

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

/** RFC 8291 / RFC 8188 aes128gcm decryption, performed with the subscriber's private key. */
export function decryptAes128gcm(body, keys) {
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);
  if (ciphertext.length > rs) throw new Error('multi-record payloads not expected');
  const uaPublic = keys.ecdh.getPublicKey();
  const ecdhSecret = keys.ecdh.computeSecret(asPublic);
  const prkKey = hmac(keys.authBuf, ecdhSecret);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = hmac(prkKey, Buffer.concat([keyInfo, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const pt = Buffer.concat([d.update(ciphertext.subarray(0, ciphertext.length - 16)), d.final()]);
  let end = pt.length - 1;
  while (end >= 0 && pt[end] === 0) end--;
  if (pt[end] !== 2) throw new Error('bad padding delimiter');
  return pt.subarray(0, end).toString('utf8');
}

/** Verify the VAPID Authorization header (RFC 8292): ES256 JWT signed by the app's key. */
export function verifyVapid(header, expectedPublicKey, audience) {
  const m = /^vapid t=([^,]+),\s*k=(.+)$/.exec(header || '');
  if (!m) throw new Error('missing vapid authorization');
  const [, jwt, k] = m;
  if (k !== expectedPublicKey) throw new Error('vapid key mismatch');
  const [h, p, s] = jwt.split('.');
  const pub = Buffer.from(k, 'base64url');
  const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33, 65).toString('base64url') }, format: 'jwk' });
  const ok = crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'));
  if (!ok) throw new Error('vapid signature invalid');
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
  if (claims.aud !== audience) throw new Error(`vapid aud ${claims.aud} != ${audience}`);
  if (claims.exp * 1000 < Date.now()) throw new Error('vapid token expired');
  return claims;
}

export async function startMockPushService({ vapidPublicKey } = {}) {
  const cfg = { vapidPublicKey };
  const dir = tmpDir('tradeos-push-');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost', '-days', '1', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')], { stdio: 'ignore' });
  const cert = fs.readFileSync(path.join(dir, 'cert.pem'));
  const subscribers = new Map(); // id -> keys
  const received = [];
  const behaviour = new Map(); // id -> array of status codes to return next
  const server = https.createServer({ key: fs.readFileSync(path.join(dir, 'key.pem')), cert }, (req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const id = req.url.split('/').pop();
      const queued = behaviour.get(id);
      if (queued?.length) { const code = queued.shift(); res.writeHead(code); return res.end(`mock ${code}`); }
      const keys = subscribers.get(id);
      if (!keys) { res.writeHead(404); return res.end('unknown subscription'); }
      try {
        const origin = `https://localhost:${server.address().port}`;
        verifyVapid(req.headers.authorization, cfg.vapidPublicKey, origin);
        if (req.headers['content-encoding'] !== 'aes128gcm') throw new Error('wrong content-encoding');
        const payload = JSON.parse(decryptAes128gcm(Buffer.concat(chunks), keys));
        received.push({ id, payload, ttl: Number(req.headers.ttl), topic: req.headers.topic, urgency: req.headers.urgency, at: Date.now() });
        res.writeHead(201); res.end();
      } catch (e) {
        res.writeHead(400); res.end(String(e.message));
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return {
    agent: new https.Agent({ ca: cert, keepAlive: false }),
    setVapidKey(k) { cfg.vapidPublicKey = k; },
    received,
    newSubscription() {
      const id = crypto.randomBytes(8).toString('hex');
      const keys = makeSubscriberKeys();
      subscribers.set(id, keys);
      return { id, json: { endpoint: `https://localhost:${port}/push/${id}`, keys: { p256dh: keys.p256dh, auth: keys.authBuf.toString('base64url') } } };
    },
    failNext(id, ...codes) { behaviour.set(id, codes); },
    forget(id) { subscribers.delete(id); },
    close: () => new Promise((r) => server.close(r)),
  };
}

/** Replays the recorded real provider response (captured from nfs.faireconomy.media on 2026-11-10). */
export function recordedProviderFetch(extraMutate) {
  const file = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures', 'forexfactory-recorded-2026-11-10.json');
  return async () => {
    let data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (extraMutate) data = extraMutate(data);
    return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}
