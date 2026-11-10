// Scheduled notification dispatcher.
//
// Duplicate prevention is layered:
//  1. DB: a UNIQUE(user_id, dedupe_key) row is claimed with INSERT OR IGNORE
//     *before* any send, so concurrent or repeated job runs cannot double-send.
//  2. Push service: the Topic header collapses an undelivered re-send.
//  3. Device: the service worker shows notifications with tag = dedupe key,
//     so a duplicate replaces rather than stacks.
import { localDate, localTime, startOfLocalDay, addDays } from '../lib/time.js';
import { topicFor } from './push.js';
import { presentEvent } from './calendar.js';

export const ALERTS = [
  { kind: 't30', minutes: 30, pref: 'alert_30', label: 'in 30 minutes' },
  { kind: 't15', minutes: 15, pref: 'alert_15', label: 'in 15 minutes' },
  { kind: 'release', minutes: 0, pref: 'alert_release', label: 'now (scheduled release time)' },
];
export const GRACE_MS = 5 * 60 * 1000;          // an alert is only sent within 5 min of its due time
export const EVENT_FRESH_MS = 24 * 3600 * 1000;  // only alert on events the provider confirmed recently
const MAX_ATTEMPTS = 4;
const BRIEFING_WINDOW_MS = 3 * 3600 * 1000;

export const DEFAULT_PREFS = {
  enabled: 1, impact_high: 1, impact_medium: 1, impact_low: 0,
  alert_30: 1, alert_15: 1, alert_release: 1, daily_briefing: 1, briefing_time: '07:30',
  currencies: 'USD,EUR,GBP,JPY,CHF,CAD,AUD,NZD',
};
export const SUPPORTED_CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD'];

export function getPrefs(db, userId) {
  const p = db.prepare('SELECT * FROM notification_prefs WHERE user_id = ?').get(userId);
  return p ? { ...p } : { user_id: userId, ...DEFAULT_PREFS };
}

export function prefImpacts(p) {
  return [p.impact_high && 'high', p.impact_medium && 'medium', p.impact_low && 'low'].filter(Boolean);
}
export function prefCurrencies(p) {
  return String(p.currencies || '').split(',').map(s => s.trim()).filter(Boolean);
}

function impactLabel(i) { return i[0].toUpperCase() + i.slice(1); }

/** Claim a notification row. Returns the row id if newly claimed, null if it already existed. */
function claim(db, n) {
  const r = db.prepare(`INSERT OR IGNORE INTO notifications(user_id, dedupe_key, kind, event_id, title, body, due_at, status)
                        VALUES (?,?,?,?,?,?,?, 'pending')`)
    .run(n.userId, n.dedupeKey, n.kind, n.eventId ?? null, n.title, n.body, n.dueAt);
  return r.changes === 1 ? Number(r.lastInsertRowid) : null;
}

async function deliver(db, notificationId, send, now, { ttlSec }) {
  const n = db.prepare('SELECT * FROM notifications WHERE id = ?').get(notificationId);
  const subs = db.prepare(`SELECT * FROM push_subscriptions WHERE user_id = ? AND active = 1
                           AND id NOT IN (SELECT subscription_id FROM notification_deliveries WHERE notification_id = ? AND status = 'sent')`)
    .all(n.user_id, n.id);
  const alreadySent = db.prepare(`SELECT COUNT(*) c FROM notification_deliveries WHERE notification_id = ? AND status='sent'`).get(n.id).c;
  if (subs.length === 0 && alreadySent === 0) {
    db.prepare(`UPDATE notifications SET status='no_subscription', attempts=attempts+1, next_attempt_at=NULL WHERE id=?`).run(n.id);
    return { sent: 0, failed: 0 };
  }
  const payload = { title: n.title, body: n.body, tag: n.dedupe_key, notificationId: n.id, kind: n.kind, url: n.kind === 'briefing' || n.event_id ? '/calendar' : '/' };
  let sent = 0, failed = 0, lastError = null;
  for (const s of subs) {
    const r = await send(s, payload, { ttl: ttlSec, topic: topicFor(n.dedupe_key) });
    const at = new Date().toISOString();
    if (r.ok) {
      sent++;
      db.prepare(`UPDATE push_subscriptions SET failure_count=0, last_success_at=? WHERE id=?`).run(at, s.id);
      db.prepare(`INSERT OR IGNORE INTO notification_deliveries(notification_id, subscription_id, status, http_status, attempted_at) VALUES (?,?,?,?,?)`).run(n.id, s.id, 'sent', r.status, at);
    } else {
      failed++;
      lastError = `HTTP ${r.status ?? '-'}: ${r.error}`;
      if (r.expired) {
        db.prepare(`UPDATE push_subscriptions SET active=0, last_failure_at=?, last_error=? WHERE id=?`).run(at, 'Subscription expired at push service', s.id);
      } else {
        db.prepare(`UPDATE push_subscriptions SET failure_count=failure_count+1, last_failure_at=?, last_error=?,
                    active = CASE WHEN failure_count+1 >= 10 THEN 0 ELSE active END WHERE id=?`).run(at, lastError, s.id);
      }
      db.prepare(`INSERT OR IGNORE INTO notification_deliveries(notification_id, subscription_id, status, http_status, error, attempted_at) VALUES (?,?,?,?,?,?)`)
        .run(n.id, s.id, r.expired ? 'expired' : 'failed', r.status, r.error, at);
    }
  }
  const totalSent = alreadySent + sent;
  const attempts = n.attempts + 1;
  // Retry only transient failures on still-active subscriptions.
  const retryable = db.prepare(`SELECT COUNT(*) c FROM push_subscriptions WHERE user_id=? AND active=1
                                AND id NOT IN (SELECT subscription_id FROM notification_deliveries WHERE notification_id=? AND status='sent')`).get(n.user_id, n.id).c;
  let status, nextAt = null;
  if (retryable === 0) status = totalSent > 0 ? 'sent' : 'failed';
  else {
    status = totalSent > 0 ? 'partial' : 'failed';
    if (attempts < MAX_ATTEMPTS) nextAt = new Date(now.getTime() + 60000 * 2 ** (attempts - 1)).toISOString();
  }
  db.prepare(`UPDATE notifications SET status=?, attempts=?, next_attempt_at=?, last_error=?, sent_at=COALESCE(sent_at, ?) WHERE id=?`)
    .run(status, attempts, nextAt, lastError, totalSent > 0 ? new Date().toISOString() : null, n.id);
  return { sent, failed };
}

function eventAlertText(ev, alert, tz) {
  const pe = presentEvent(ev, tz);
  const title = alert.kind === 'release'
    ? `${ev.currency} ${ev.title} — scheduled release time`
    : `${ev.currency} ${ev.title} ${alert.label}`;
  const parts = [`${impactLabel(ev.impact)} impact`, `${pe.localTime} ${tz === 'Africa/Casablanca' ? 'Casablanca' : tz} (${pe.utcOffset})`];
  if (ev.forecast) parts.push(`Fcst ${ev.forecast}`);
  if (ev.previous) parts.push(`Prev ${ev.previous}`);
  if (alert.kind === 'release') parts.push('Actual figure not verified by TradeOS');
  return { title, body: parts.join(' · ') };
}

function usersToProcess(db) {
  return db.prepare(`SELECT u.id, u.timezone FROM users u
                     WHERE EXISTS (SELECT 1 FROM push_subscriptions s WHERE s.user_id=u.id AND s.active=1)
                       AND COALESCE((SELECT enabled FROM notification_prefs p WHERE p.user_id=u.id), 1) = 1`).all();
}

/** One scheduler tick. `now` and `send` are injectable for deterministic tests. */
export async function runNotificationTick(db, { now = new Date(), send }) {
  const stats = { claimed: 0, sent: 0, failed: 0, retried: 0 };
  const freshSince = new Date(now.getTime() - EVENT_FRESH_MS).toISOString();
  const lo = new Date(now.getTime() - GRACE_MS).toISOString();
  const hi = new Date(now.getTime() + 31 * 60000).toISOString();

  for (const u of usersToProcess(db)) {
    const p = getPrefs(db, u.id);
    const impacts = prefImpacts(p);
    const ccys = prefCurrencies(p);
    if (impacts.length && ccys.length) {
      const events = db.prepare(`SELECT * FROM econ_events WHERE active=1 AND all_day=0 AND last_seen_at >= ?
                                 AND scheduled_at BETWEEN ? AND ?
                                 AND impact IN (${impacts.map(() => '?').join(',')})
                                 AND currency IN (${ccys.map(() => '?').join(',')})`)
        .all(freshSince, lo, hi, ...impacts, ...ccys);
      for (const ev of events) {
        for (const a of ALERTS) {
          if (!p[a.pref]) continue;
          const due = Date.parse(ev.scheduled_at) - a.minutes * 60000;
          if (now.getTime() < due || now.getTime() - due > GRACE_MS) continue;
          const t = eventAlertText(ev, a, u.timezone);
          const id = claim(db, { userId: u.id, dedupeKey: `event:${ev.uid}:${a.kind}`, kind: a.kind, eventId: ev.id, ...t, dueAt: new Date(due).toISOString() });
          if (id) {
            stats.claimed++;
            const ttl = Math.max(60, (Date.parse(ev.scheduled_at) + GRACE_MS - now.getTime()) / 1000);
            const r = await deliver(db, id, send, now, { ttlSec: ttl });
            stats.sent += r.sent; stats.failed += r.failed;
          }
        }
      }
    }
    // Daily upcoming-news briefing at the user's chosen local time.
    if (p.daily_briefing && /^\d{2}:\d{2}$/.test(p.briefing_time)) {
      const today = localDate(now, u.timezone);
      const [hh, mm] = p.briefing_time.split(':').map(Number);
      const due = startOfLocalDay(today, u.timezone).getTime() + (hh * 60 + mm) * 60000;
      if (now.getTime() >= due && now.getTime() - due <= BRIEFING_WINDOW_MS) {
        const b = buildBriefing(db, u, p, today, now);
        const id = claim(db, { userId: u.id, dedupeKey: `briefing:${today}`, kind: 'briefing', ...b, dueAt: new Date(due).toISOString() });
        if (id) {
          stats.claimed++;
          const r = await deliver(db, id, send, now, { ttlSec: 3 * 3600 });
          stats.sent += r.sent; stats.failed += r.failed;
        }
      }
    }
  }

  // Retries for transient failures, only while the alert is still relevant.
  const retry = db.prepare(`SELECT id, kind, due_at FROM notifications WHERE status IN ('failed','partial') AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?`).all(now.toISOString());
  for (const n of retry) {
    const deadline = Date.parse(n.due_at) + (n.kind === 'briefing' ? BRIEFING_WINDOW_MS : n.kind === 'release' ? GRACE_MS : n.kind === 't30' ? 15 * 60000 : 10 * 60000);
    if (now.getTime() > deadline) { db.prepare(`UPDATE notifications SET next_attempt_at=NULL WHERE id=?`).run(n.id); continue; }
    stats.retried++;
    const r = await deliver(db, n.id, send, now, { ttlSec: Math.max(60, (deadline - now.getTime()) / 1000) });
    stats.sent += r.sent; stats.failed += r.failed;
  }
  return stats;
}

export function buildBriefing(db, user, prefs, ymd, now = new Date()) {
  const impacts = prefImpacts(prefs);
  const ccys = prefCurrencies(prefs);
  const from = startOfLocalDay(ymd, user.timezone).toISOString();
  const to = startOfLocalDay(addDays(ymd, 1), user.timezone).toISOString();
  const evs = impacts.length && ccys.length ? db.prepare(`SELECT * FROM econ_events WHERE active=1 AND scheduled_at >= ? AND scheduled_at < ?
      AND impact IN (${impacts.map(() => '?').join(',')}) AND currency IN (${ccys.map(() => '?').join(',')}) ORDER BY scheduled_at`)
    .all(from, to, ...impacts, ...ccys) : [];
  const title = `Today's news briefing — ${ymd}`;
  if (!evs.length) return { title, body: `No ${impacts.join('/')} impact events for your currencies today (per provider data).` };
  const lines = evs.slice(0, 6).map(e => `${e.all_day ? 'All day' : localTime(new Date(e.scheduled_at), user.timezone)} ${e.currency} ${e.title} (${e.impact})`);
  if (evs.length > 6) lines.push(`+${evs.length - 6} more`);
  return { title: `${title} · ${evs.length} event${evs.length > 1 ? 's' : ''}`, body: lines.join('\n') };
}

/** Send an immediate test notification so users can verify their device. */
export async function sendTestNotification(db, userId, send, now = new Date()) {
  const key = `test:${now.toISOString()}`;
  const id = claim(db, { userId, dedupeKey: key, kind: 'test', title: 'TradeOS notifications are working', body: 'You will receive economic news alerts on this device.', dueAt: now.toISOString() });
  return deliver(db, id, send, now, { ttlSec: 600 });
}
