// Timezone helpers. All storage is UTC; conversion to Africa/Casablanca (or the
// user's zone) always goes through the IANA database via Intl — never a fixed
// offset, because Morocco's offset has changed several times (Ramadan
// switches, and the return to permanent UTC+0 on 2026-09-20 in tzdata 2026).

export const DEFAULT_TZ = 'Africa/Casablanca';

const fmtCache = new Map();
function partsFmt(tz) {
  if (!fmtCache.has(tz)) {
    fmtCache.set(tz, new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }));
  }
  return fmtCache.get(tz);
}

/** Wall-clock parts of an instant in a zone. */
export function zonedParts(date, tz = DEFAULT_TZ) {
  const p = Object.fromEntries(partsFmt(tz).formatToParts(date).map(x => [x.type, x.value]));
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour, minute: +p.minute, second: +p.second };
}

/** Offset of a zone from UTC at a given instant, in minutes (e.g. +60 for UTC+1). */
export function tzOffsetMinutes(date, tz = DEFAULT_TZ) {
  const p = zonedParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}

/** YYYY-MM-DD of an instant in a zone. */
export function localDate(date, tz = DEFAULT_TZ) {
  const p = zonedParts(date, tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** HH:MM of an instant in a zone. */
export function localTime(date, tz = DEFAULT_TZ) {
  const p = zonedParts(date, tz);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

/**
 * Convert a wall-clock time in a zone to a UTC Date. Iterates to handle offset
 * changes; for nonexistent local times (spring-forward gap) returns the later instant.
 */
export function zonedToUtc(y, mo, d, h = 0, mi = 0, s = 0, tz = DEFAULT_TZ) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  let t = guess - tzOffsetMinutes(new Date(guess), tz) * 60000;
  const off2 = tzOffsetMinutes(new Date(t), tz);
  t = guess - off2 * 60000;
  return new Date(t);
}

/** UTC instant for the start of a local day (YYYY-MM-DD) in a zone. */
export function startOfLocalDay(ymd, tz = DEFAULT_TZ) {
  const [y, m, d] = ymd.split('-').map(Number);
  return zonedToUtc(y, m, d, 0, 0, 0, tz);
}

export function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

/** Monday of the ISO week containing ymd. */
export function weekStart(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  return addDays(ymd, dow === 0 ? -6 : 1 - dow);
}

export function isValidYmd(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = new Date(s + 'T00:00:00Z');
  return !isNaN(t) && t.toISOString().slice(0, 10) === s;
}

export function isValidTz(tz) {
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; }
}
