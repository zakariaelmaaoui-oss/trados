// Forex Factory weekly calendar feed (published by Fair Economy).
// Public JSON, no API key. The feed covers the current week only and enforces
// a strict rate limit, so the ingest job fetches at most once per interval and
// honours Retry-After on HTTP 429.
import crypto from 'node:crypto';

export const id = 'forexfactory';
export const displayName = 'Forex Factory (faireconomy.media weekly feed)';
export const FEEDS = ['https://nfs.faireconomy.media/ff_calendar_thisweek.json'];

const IMPACTS = { high: 'high', medium: 'medium', low: 'low', holiday: 'holiday', 'non-economic': 'low' };

export class ProviderError extends Error {
  constructor(message, { status, retryAfterSec } = {}) {
    super(message);
    this.status = status;
    this.retryAfterSec = retryAfterSec;
  }
}

/** Stable dedupe key: same provider + currency + title + instant = same event. */
export function eventUid(e) {
  return crypto.createHash('sha1')
    .update(`${id}|${e.currency}|${e.title.trim().toLowerCase()}|${e.scheduled_at}`)
    .digest('hex');
}

/** Validate & normalise raw feed rows. Rows that fail validation are dropped, never guessed. */
export function normalise(raw) {
  if (!Array.isArray(raw)) throw new ProviderError('Provider returned unexpected payload (not an array)');
  const out = new Map();
  let rejected = 0;
  for (const r of raw) {
    const title = typeof r?.title === 'string' ? r.title.trim() : '';
    const currency = typeof r?.country === 'string' ? r.country.trim().toUpperCase() : '';
    const impact = IMPACTS[String(r?.impact || '').toLowerCase()];
    // Dates come with an explicit UTC offset, e.g. 2026-11-10T08:30:00-05:00
    const d = typeof r?.date === 'string' && /[+-]\d{2}:\d{2}$|Z$/.test(r.date) ? new Date(r.date) : null;
    if (!title || !currency || !impact || !d || isNaN(d)) { rejected++; continue; }
    const scheduled_at = d.toISOString();
    const ev = {
      title, currency, impact, scheduled_at,
      all_day: impact === 'holiday' ? 1 : 0,
      forecast: r.forecast ? String(r.forecast) : null,
      previous: r.previous ? String(r.previous) : null,
      actual: r.actual ? String(r.actual) : null, // not in this feed today; kept if it ever appears
    };
    ev.uid = eventUid(ev);
    out.set(ev.uid, ev); // duplicate rows within the feed collapse here
  }
  return { events: [...out.values()], rejected };
}

export async function fetchEvents(fetchImpl = fetch) {
  const all = [];
  let rejected = 0;
  for (const url of FEEDS) {
    let res;
    try {
      res = await fetchImpl(url, { headers: { Accept: 'application/json', 'User-Agent': 'TradeOS/1.0 (economic calendar sync)' }, signal: AbortSignal.timeout(20000) });
    } catch (e) {
      throw new ProviderError(`Network error contacting provider: ${e.cause?.code || e.message}`);
    }
    if (!res.ok) {
      const ra = Number(res.headers.get('retry-after'));
      throw new ProviderError(`Provider responded HTTP ${res.status}`, { status: res.status, retryAfterSec: Number.isFinite(ra) && ra > 0 ? ra : undefined });
    }
    let json;
    try { json = await res.json(); } catch { throw new ProviderError('Provider returned invalid JSON', { status: res.status }); }
    const n = normalise(json);
    all.push(...n.events);
    rejected += n.rejected;
  }
  if (all.length === 0) throw new ProviderError('Provider returned no events');
  const times = all.map(e => e.scheduled_at).sort();
  return { events: all, rejected, windowStart: times[0], windowEnd: times[times.length - 1] };
}
