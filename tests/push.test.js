// End-to-end Web Push delivery: real VAPID signing + aes128gcm encryption by the
// app, verified and decrypted by a local push service. Events come from the
// recorded real provider response; only the clock is simulated.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, startMockPushService, recordedProviderFetch, registerUser } from './helpers.js';
import { syncCalendar } from '../server/services/calendar.js';
import { runNotificationTick } from '../server/services/notifications.js';

// UK GDP m/m (High) and Prelim GDP q/q (Medium), both 2026-11-12 02:00 New York = 07:00 UTC = 07:00 Casablanca.
const T = Date.parse('2026-11-12T07:00:00Z');
const at = (minFromEvent, sec = 0) => new Date(T + minFromEvent * 60000 + sec * 1000);

let push;
before(async () => { push = await startMockPushService(); });
after(async () => { await push.close(); });

async function setup() {
  const app = await startApp({ agent: push.agent, now: () => at(-120) });
  push.setVapidKey(app.vapid.publicKey);
  await syncCalendar(app.db, { fetchImpl: recordedProviderFetch(), now: at(-120) });
  const tick = (d) => runNotificationTick(app.db, { now: d, send: app.sender });
  const user = async (email, prefs) => {
    const { c } = await registerUser(app.base, email);
    if (prefs) assert.equal((await c.put('/api/notifications/prefs', prefs)).status, 200);
    const sub = push.newSubscription();
    assert.equal((await c.post('/api/push/subscribe', { subscription: sub.json })).status, 201);
    return { c, sub, got: () => push.received.filter((r) => r.id === sub.id).map((r) => r.payload) };
  };
  return { app, tick, user };
}

test('30-min, 15-min and release alerts are delivered once each, encrypted and VAPID-signed', async () => {
  const { app, tick, user } = await setup();
  try {
    const u = await user('alerts@example.com', { dailyBriefing: false });
    await tick(at(-31));
    assert.equal(u.got().length, 0, 'nothing before T-30');

    await tick(at(-30));
    const t30 = u.got();
    assert.equal(t30.length, 2, 'High + Medium GBP events');
    assert.deepEqual(t30.map((p) => p.kind), ['t30', 't30']);
    assert.ok(t30.some((p) => p.title === 'GBP GDP m/m in 30 minutes'));
    assert.ok(t30.some((p) => p.title === 'GBP Prelim GDP q/q in 30 minutes'));
    assert.match(t30[0].body, /07:00 Casablanca \(UTC\+00:00\)/);
    const rec = push.received.filter((r) => r.id === u.sub.id);
    assert.ok(rec.every((r) => r.ttl > 0 && r.ttl <= 35 * 60 && r.topic && r.urgency === 'high'));

    // Repeated and concurrent scheduler runs inside the grace window: no duplicates.
    await tick(at(-29));
    await Promise.all([tick(at(-28)), tick(at(-28)), tick(at(-27))]);
    assert.equal(u.got().length, 2);

    await tick(at(-15));
    assert.equal(u.got().filter((p) => p.kind === 't15').length, 2);
    await tick(at(-14, 30));
    assert.equal(u.got().filter((p) => p.kind === 't15').length, 2, 't15 not duplicated');

    await tick(at(0));
    const rel = u.got().filter((p) => p.kind === 'release');
    assert.equal(rel.length, 2);
    assert.match(rel[0].body, /not verified/);
    await tick(at(1));
    await tick(at(6));
    assert.equal(u.got().length, 6, 'exactly 3 alerts × 2 events');

    const hist = (await u.c.get('/api/notifications/history')).data.notifications;
    assert.equal(hist.length, 6);
    assert.ok(hist.every((n) => n.status === 'sent' && n.attempts === 1));
    assert.equal(new Set(push.received.filter((r) => r.id === u.sub.id).map((r) => r.payload.tag)).size, 6, 'unique tag per alert');
  } finally { await app.close(); }
});

test('impact filters: High-only users get no Medium alerts; Low is off by default and opt-in', async () => {
  const { app, tick, user } = await setup();
  try {
    const highOnly = await user('high@example.com', { impacts: { medium: false }, dailyBriefing: false });
    const deflt = await user('default@example.com', { dailyBriefing: false });
    await tick(at(-30));
    assert.deepEqual(highOnly.got().map((p) => p.title), ['GBP GDP m/m in 30 minutes']);
    assert.equal(deflt.got().length, 2);

    // Low-impact events: pick a real one from the provider data and alert on it only after opting in.
    const low = await app.db.get("SELECT * FROM econ_events WHERE impact='low' AND all_day=0 AND currency IN ('USD','EUR','GBP','JPY','CHF','CAD','AUD','NZD') AND scheduled_at > ? ORDER BY scheduled_at LIMIT 1", new Date(T + 3600e3).toISOString());
    assert.ok(low, 'recorded provider data has a low-impact event');
    const lowAt = Date.parse(low.scheduled_at) - 30 * 60000;
    await syncCalendar(app.db, { fetchImpl: recordedProviderFetch(), now: new Date(lowAt - 3600e3) });
    const before = deflt.got().length;
    await tick(new Date(lowAt));
    assert.equal(deflt.got().filter((p) => p.title.includes(low.title)).length, 0, 'low disabled by default');
    await deflt.c.put('/api/notifications/prefs', { impacts: { low: true } });
    await tick(new Date(lowAt + 60000));
    assert.ok(deflt.got().length > before && deflt.got().some((p) => p.title === `${low.currency} ${low.title} in 30 minutes`), 'low delivered after opt-in');
  } finally { await app.close(); }
});

test('currency filter and per-alert schedule preferences are respected', async () => {
  const { app, tick, user } = await setup();
  try {
    const usdOnly = await user('usd@example.com', { currencies: ['USD'], dailyBriefing: false });
    const only15 = await user('only15@example.com', { alerts: { t30: false, release: false }, dailyBriefing: false });
    await tick(at(-30)); await tick(at(-15)); await tick(at(0));
    assert.equal(usdOnly.got().length, 0, 'GBP events filtered out');
    assert.deepEqual(only15.got().map((p) => p.kind), ['t15', 't15']);
  } finally { await app.close(); }
});

test('users can disable notifications (master switch, per device, unsubscribe)', async () => {
  const { app, tick, user } = await setup();
  try {
    const off = await user('off@example.com', { enabled: false });
    const unsub = await user('unsub@example.com', { dailyBriefing: false });
    const dev = await user('device@example.com', { dailyBriefing: false });
    assert.equal((await unsub.c.post('/api/push/unsubscribe', { endpoint: unsub.sub.json.endpoint })).data.removed, 1);
    const subs = (await dev.c.get('/api/push/subscriptions')).data.subscriptions;
    assert.equal((await dev.c.del(`/api/push/subscriptions/${subs[0].id}`)).status, 200);
    await tick(at(-30)); await tick(at(-15)); await tick(at(0));
    assert.equal(off.got().length + unsub.got().length + dev.got().length, 0);
    // turning back on resumes alerts
    await off.c.put('/api/notifications/prefs', { enabled: true, dailyBriefing: false });
    await tick(at(0, 30));
    assert.equal(off.got().filter((p) => p.kind === 'release').length, 2);
  } finally { await app.close(); }
});

test('failed delivery: transient 5xx retried with backoff; 410 Gone deactivates the subscription', async () => {
  const { app, tick, user } = await setup();
  try {
    const flaky = await user('flaky@example.com', { dailyBriefing: false });
    const gone = await user('gone@example.com', { dailyBriefing: false });
    push.failNext(flaky.sub.id, 503, 503);
    push.failNext(gone.sub.id, 410);
    await tick(at(-30));
    let h = (await flaky.c.get('/api/notifications/history')).data.notifications;
    assert.ok(h.length === 2 && h.every((n) => n.status === 'failed' && /503/.test(n.last_error)));
    await tick(at(-30, 30));
    assert.equal(flaky.got().length, 0, 'retry waits for backoff (1 min)');
    await tick(at(-29));
    h = (await flaky.c.get('/api/notifications/history')).data.notifications;
    assert.ok(h.every((n) => n.status === 'sent' && n.attempts === 2), JSON.stringify(h));
    assert.equal(flaky.got().filter((p) => p.kind === 't30').length, 2, 'each delivered exactly once after retry');

    const gsubs = (await gone.c.get('/api/push/subscriptions')).data.subscriptions;
    assert.equal(gsubs[0].active, 0);
    assert.match(gsubs[0].last_error, /expired/);
    const gh = (await gone.c.get('/api/notifications/history')).data.notifications;
    assert.ok(gh.some((n) => n.status === 'failed' && /410/.test(n.last_error)), 'the 410 attempt is recorded as failed');
    assert.ok(gh.every((n) => ['failed', 'no_subscription'].includes(n.status)), 'later alerts know there is no active device');
    await tick(at(-15));
    assert.equal(gone.got().length, 0, 'no further sends to an expired subscription');
  } finally { await app.close(); }
});

test('alerts missed by more than the grace window are skipped, not sent late', async () => {
  const { app, tick, user } = await setup();
  try {
    const u = await user('late@example.com', { dailyBriefing: false });
    await tick(at(-24)); // T-30 was 6 minutes ago (> 5 min grace)
    assert.equal(u.got().length, 0);
    await tick(at(-15));
    assert.equal(u.got().filter((p) => p.kind === 't15').length, 2);
  } finally { await app.close(); }
});

test('daily upcoming-news briefing is sent once at the chosen Casablanca time', async () => {
  const { app, tick, user } = await setup();
  try {
    const u = await user('brief@example.com', { briefingTime: '06:00', alerts: { t30: false, t15: false, release: false } });
    await tick(new Date('2026-11-12T05:59:00Z'));
    assert.equal(u.got().length, 0);
    await tick(new Date('2026-11-12T06:00:10Z')); // 06:00 Casablanca (UTC+0 in November 2026)
    await tick(new Date('2026-11-12T06:05:00Z'));
    const b = u.got().filter((p) => p.kind === 'briefing');
    assert.equal(b.length, 1);
    assert.match(b[0].title, /2026-11-12/);
    assert.match(b[0].body, /07:00 GBP GDP m\/m \(high\)/);
  } finally { await app.close(); }
});

test('test notification endpoint and subscription validation', async () => {
  const { app, user } = await setup();
  try {
    const u = await user('test@example.com');
    const r = await u.c.post('/api/notifications/test');
    assert.equal(r.data.sent, 1);
    assert.equal(u.got()[0].title, 'TradeOS notifications are working');
    assert.equal((await u.c.post('/api/push/subscribe', { subscription: { endpoint: 'http://insecure/x', keys: { p256dh: 'a', auth: 'b' } } })).status, 400);
    const { c: nosub } = await registerUser(app.base, 'nosub@example.com');
    assert.equal((await nosub.post('/api/notifications/test')).status, 400);
    // a browser endpoint moves to whoever signs in on that browser
    const { c: other } = await registerUser(app.base, 'switch@example.com');
    await other.post('/api/push/subscribe', { subscription: u.sub.json });
    assert.equal((await u.c.get('/api/push/subscriptions')).data.subscriptions.length, 0);
  } finally { await app.close(); }
});

test('cron endpoint (used by cron-job.org on Vercel) requires the secret and runs the jobs', async () => {
  const { app, user } = await setup();
  try {
    const u = await user('cron@example.com', { dailyBriefing: false });
    assert.equal((await fetch(`${app.base}/api/cron/tick`)).status, 401);
    assert.equal((await fetch(`${app.base}/api/cron/tick`, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
    const r = await fetch(`${app.base}/api/cron/tick`, { headers: { Authorization: 'Bearer test-cron-secret' } });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(body.notifications && typeof body.notifications.claimed === 'number');
    const q = await fetch(`${app.base}/api/cron/tick?key=test-cron-secret`);
    assert.equal(q.status, 200);
    assert.equal(u.got().length, 0, 'real clock: no alerts due for these recorded events');
  } finally { await app.close(); }
});
