// Background jobs: calendar sync (hourly, with backoff) and notification dispatch.
//  * Local/VPS: startScheduler() runs a tick every 30 s in-process.
//  * Vercel: an external cron calls GET /api/cron/tick every minute (see README).
import { isSyncDue, syncCalendar } from './services/calendar.js';
import { runNotificationTick } from './services/notifications.js';

/** One scheduler run. Safe to call concurrently: alerts are claimed atomically in the DB. */
export async function runScheduledJobs(db, { send, fetchImpl = fetch, now = new Date() } = {}) {
  const out = { calendar: null, notifications: null };
  if (await isSyncDue(db, now)) {
    const f = await syncCalendar(db, { fetchImpl, now });
    out.calendar = f.ok ? { ok: true, received: f.events_received, new: f.events_new } : { ok: false, error: f.error };
  }
  out.notifications = await runNotificationTick(db, { now, send });
  return out;
}

export function startScheduler(db, { send, tickMs = 30000, fetchImpl = fetch, log = console } = {}) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const r = await runScheduledJobs(db, { send, fetchImpl });
      if (r.calendar) log.log(r.calendar.ok ? `[calendar] synced ${r.calendar.received} events (${r.calendar.new} new)` : `[calendar] sync failed: ${r.calendar.error}`);
      const s = r.notifications;
      if (s.claimed || s.retried) log.log(`[notify] claimed=${s.claimed} sent=${s.sent} failed=${s.failed} retried=${s.retried}`);
    } catch (e) {
      log.error('[scheduler] tick error', e);
    } finally {
      running = false;
    }
  };
  tick();
  const h = setInterval(tick, tickMs);
  return { stop: () => clearInterval(h), tick };
}
