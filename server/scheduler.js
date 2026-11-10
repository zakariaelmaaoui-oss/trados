// Background jobs: calendar sync (hourly, with backoff) and notification dispatch
// (every 30 s). Ticks never overlap; errors are logged and never crash the process.
import { isSyncDue, syncCalendar } from './services/calendar.js';
import { runNotificationTick } from './services/notifications.js';

export function startScheduler(db, { send, tickMs = 30000, fetchImpl = fetch, log = console } = {}) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      if (isSyncDue(db)) {
        const f = await syncCalendar(db, { fetchImpl });
        log.log(f.ok ? `[calendar] synced ${f.events_received} events (${f.events_new} new)` : `[calendar] sync failed: ${f.error}`);
      }
      const s = await runNotificationTick(db, { send });
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
