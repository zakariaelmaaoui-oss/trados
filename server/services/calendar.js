// Economic calendar ingest + query. Only events returned by the real provider are
// ever stored; there is no seeding or fallback generation of events.
import * as forexfactory from './providers/forexfactory.js';
import { kvGet, kvSet } from '../db.js';
import { localDate, localTime, tzOffsetMinutes, DEFAULT_TZ } from '../lib/time.js';

export const providers = { forexfactory };

export const SYNC_INTERVAL_MS = 60 * 60 * 1000;   // normal refresh cadence
export const STALE_AFTER_MS = 6 * 60 * 60 * 1000;  // data older than this is flagged stale
const MAX_BACKOFF_MS = 2 * 60 * 60 * 1000;

export async function isSyncDue(db, now = new Date()) {
  const next = await kvGet(db, 'calendar.next_sync_at');
  return !next || now.getTime() >= Date.parse(next);
}

/**
 * Fetch from the provider and upsert. Returns the fetch log row.
 * fetchImpl is injectable for tests; production uses global fetch.
 */
export async function syncCalendar(db, { provider = forexfactory, fetchImpl = fetch, now = new Date() } = {}) {
  const startedAt = now.toISOString();
  const fetchId = (await db.get('INSERT INTO calendar_fetches(provider, started_at) VALUES(?,?) RETURNING id', provider.id, startedAt)).id;
  try {
    const { events, windowStart, windowEnd } = await provider.fetchEvents(fetchImpl);
    const seenAt = now.toISOString();
    let created = 0;
    await db.tx(async (t) => {
      for (const e of events) {
        const r = await t.get(`
          INSERT INTO econ_events(uid, provider, title, currency, impact, scheduled_at, all_day, forecast, previous, actual, first_seen_at, last_seen_at, last_seen_fetch_id, active)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1)
          ON CONFLICT(uid) DO UPDATE SET
            impact=excluded.impact, forecast=excluded.forecast, previous=excluded.previous,
            actual=COALESCE(excluded.actual, econ_events.actual),
            last_seen_at=excluded.last_seen_at, last_seen_fetch_id=excluded.last_seen_fetch_id, active=1
          RETURNING (xmax = 0) AS inserted`,
        e.uid, provider.id, e.title, e.currency, e.impact, e.scheduled_at, e.all_day,
        e.forecast, e.previous, e.actual, seenAt, seenAt, fetchId);
        if (r.inserted) created++;
      }
      // Events inside the covered window that the provider no longer lists were
      // rescheduled or removed: hide them so they are neither shown nor alerted.
      await t.run(`UPDATE econ_events SET active = 0
                   WHERE provider = ? AND scheduled_at BETWEEN ? AND ? AND (last_seen_fetch_id IS NULL OR last_seen_fetch_id <> ?)`,
      provider.id, windowStart, windowEnd, fetchId);
      await t.run(`UPDATE calendar_fetches SET finished_at=?, ok=1, http_status=200, events_received=?, events_new=?, window_start=?, window_end=? WHERE id=?`,
        seenAt, events.length, created, windowStart, windowEnd, fetchId);
    });
    await kvSet(db, 'calendar.failures', '0');
    await kvSet(db, 'calendar.next_sync_at', new Date(now.getTime() + SYNC_INTERVAL_MS).toISOString());
    return db.get('SELECT * FROM calendar_fetches WHERE id = ?', fetchId);
  } catch (err) {
    const failures = Number((await kvGet(db, 'calendar.failures')) || 0) + 1;
    await kvSet(db, 'calendar.failures', String(failures));
    // Exponential backoff (5, 10, 20 … min, capped), never sooner than Retry-After.
    let delay = Math.min(5 * 60 * 1000 * 2 ** (failures - 1), MAX_BACKOFF_MS);
    if (err.retryAfterSec) delay = Math.max(delay, err.retryAfterSec * 1000);
    await kvSet(db, 'calendar.next_sync_at', new Date(now.getTime() + delay).toISOString());
    await db.run('UPDATE calendar_fetches SET finished_at=?, ok=0, http_status=?, error=? WHERE id=?',
      now.toISOString(), err.status ?? null, String(err.message).slice(0, 500), fetchId);
    return db.get('SELECT * FROM calendar_fetches WHERE id = ?', fetchId);
  }
}

export async function calendarStatus(db, now = new Date()) {
  const last = await db.get('SELECT * FROM calendar_fetches WHERE ok = 1 ORDER BY id DESC LIMIT 1');
  const lastAttempt = await db.get('SELECT * FROM calendar_fetches ORDER BY id DESC LIMIT 1');
  const lastOk = last ? last.finished_at : null;
  const ageMs = lastOk ? now.getTime() - Date.parse(lastOk) : null;
  return {
    provider: forexfactory.displayName,
    providerId: forexfactory.id,
    lastSuccessfulUpdate: lastOk,
    lastAttemptAt: lastAttempt?.started_at ?? null,
    lastAttemptOk: lastAttempt ? !!lastAttempt.ok : null,
    lastError: lastAttempt && !lastAttempt.ok ? lastAttempt.error : null,
    nextSyncAt: await kvGet(db, 'calendar.next_sync_at'),
    coverage: last ? { start: last.window_start, end: last.window_end } : null,
    stale: lastOk === null || ageMs > STALE_AFTER_MS,
    hasData: !!last,
  };
}

/**
 * Release status. The provider publishes schedule data; a release is only
 * "verified" when the provider itself reports an actual value.
 */
export function releaseStatus(ev, now = new Date()) {
  if (ev.actual) return 'released_verified';
  if (Date.parse(ev.scheduled_at) > now.getTime()) return 'scheduled';
  return 'time_passed_unverified';
}

export function presentEvent(ev, tz = DEFAULT_TZ, now = new Date()) {
  const d = new Date(ev.scheduled_at);
  const off = tzOffsetMinutes(d, tz);
  return {
    id: ev.id, title: ev.title, currency: ev.currency, impact: ev.impact,
    provider: ev.provider, allDay: !!ev.all_day,
    scheduledAtUtc: ev.scheduled_at,
    localDate: localDate(d, tz), localTime: ev.all_day ? 'All day' : localTime(d, tz),
    utcOffset: `UTC${off >= 0 ? '+' : '-'}${String(Math.floor(Math.abs(off) / 60)).padStart(2, '0')}:${String(Math.abs(off) % 60).padStart(2, '0')}`,
    timezone: tz,
    forecast: ev.forecast, previous: ev.previous, actual: ev.actual,
    status: releaseStatus(ev, now),
    lastSeenAt: ev.last_seen_at,
  };
}

export function queryEvents(db, { from, to, impacts, currencies }) {
  const where = ['active = 1', 'scheduled_at >= ?', 'scheduled_at < ?'];
  const args = [from, to];
  if (impacts?.length) { where.push(`impact IN (${impacts.map(() => '?').join(',')})`); args.push(...impacts); }
  if (currencies?.length) { where.push(`currency IN (${currencies.map(() => '?').join(',')})`); args.push(...currencies); }
  return db.all(`SELECT * FROM econ_events WHERE ${where.join(' AND ')} ORDER BY scheduled_at, currency, title`, ...args);
}
