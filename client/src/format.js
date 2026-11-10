export const TZ_DEFAULT = 'Africa/Casablanca';

export function money(n, ccy = 'USD', { sign = false } = {}) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  const s = new Intl.NumberFormat('en-US', { style: 'currency', currency: ccy, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(n));
  if (n < 0) return `−${s}`;
  return sign && n > 0 ? `+${s}` : s;
}
export const pct = (n, d = 1) => (n === null || n === undefined ? '—' : `${n.toFixed(d)}%`);
export const numf = (n, d = 2) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: d }));
export const signClass = (n) => (n > 0 ? 'pos' : n < 0 ? 'neg' : '');

export function fmtDateTime(iso, tz = TZ_DEFAULT) {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
}
export function fmtDay(ymd, opts = { weekday: 'long', day: 'numeric', month: 'long' }) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', ...opts }).format(new Date(Date.UTC(y, m - 1, d)));
}
export function todayIn(tz = TZ_DEFAULT) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
export function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
export function weekStartOf(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return addDays(ymd, dow === 0 ? -6 : 1 - dow);
}
export function relTime(iso) {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

/** Convert a UTC ISO string to the value of a datetime-local input in tz. */
export function isoToLocalInput(iso, tz = TZ_DEFAULT) {
  if (!iso) return '';
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
function offsetMin(date, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(date).map((x) => [x.type, x.value]));
  return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(date.getTime() / 1000) * 1000) / 60000;
}
/** Interpret a datetime-local value as wall-clock time in tz and return UTC ISO. */
export function localInputToIso(v, tz = TZ_DEFAULT) {
  if (!v) return null;
  const [d, t] = v.split('T');
  const [y, m, day] = d.split('-').map(Number);
  const [hh, mm] = t.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, day, hh, mm);
  let ts = guess - offsetMin(new Date(guess), tz) * 60000;
  ts = guess - offsetMin(new Date(ts), tz) * 60000;
  return new Date(ts).toISOString();
}
