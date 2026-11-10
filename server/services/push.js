// Web Push transport: VAPID key management and encrypted delivery (RFC 8030/8291/8292).
import * as webpush from 'web-push';
import crypto from 'node:crypto';
import { kvGet, kvSet } from '../db.js';

/**
 * VAPID keys come from env (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY) in production.
 * If absent they are generated once and persisted in the database so existing
 * browser subscriptions stay valid across restarts.
 */
export async function loadVapid(db, env = process.env) {
  let publicKey = env.VAPID_PUBLIC_KEY;
  let privateKey = env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) {
    publicKey = await kvGet(db, 'vapid.public');
    privateKey = await kvGet(db, 'vapid.private');
    if (!publicKey || !privateKey) {
      ({ publicKey, privateKey } = webpush.generateVAPIDKeys());
      await kvSet(db, 'vapid.public', publicKey);
      await kvSet(db, 'vapid.private', privateKey);
    }
  }
  const subject = env.VAPID_SUBJECT || 'mailto:admin@tradeos.invalid';
  return { publicKey, privateKey, subject };
}

/** Push-service "Topic" header: lets the push service collapse a re-send of the same alert. */
export function topicFor(dedupeKey) {
  return crypto.createHash('sha256').update(dedupeKey).digest('base64url').slice(0, 32);
}

/**
 * Returns a sender(subscription, payload, opts) -> { ok, status, expired, error }.
 * `agent` is only overridden by tests (local HTTPS mock push service).
 */
export function createSender(vapid, { agent, proxy } = {}) {
  return async (sub, payload, { ttl = 3600, topic, urgency = 'high' } = {}) => {
    try {
      const res = await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify(payload),
        {
          vapidDetails: vapid, TTL: Math.max(0, Math.floor(ttl)), urgency, topic,
          contentEncoding: 'aes128gcm', timeout: 15000,
          ...(agent ? { agent } : {}), ...(proxy ? { proxy } : {}),
        },
      );
      return { ok: true, status: res.statusCode };
    } catch (e) {
      const status = e.statusCode ?? null;
      return {
        ok: false, status,
        // 404/410 = subscription no longer exists at the push service.
        expired: status === 404 || status === 410,
        error: (e.body || e.message || String(e)).toString().slice(0, 300),
      };
    }
  };
}

export function isValidSubscription(s) {
  try {
    const u = new URL(s?.endpoint);
    if (u.protocol !== 'https:') return false;
    const p = Buffer.from(String(s.keys?.p256dh), 'base64url');
    const a = Buffer.from(String(s.keys?.auth), 'base64url');
    return p.length === 65 && p[0] === 0x04 && a.length >= 16;
  } catch { return false; }
}
