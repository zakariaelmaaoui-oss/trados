import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, kvGet } from '../server/db.js';
import { syncCalendar, calendarStatus, queryEvents, releaseStatus } from '../server/services/calendar.js';
import { normalise } from '../server/services/providers/forexfactory.js';
import { recordedProviderFetch, startApp, registerUser } from './helpers.js';

test('normalise de-duplicates identical provider rows and drops malformed rows instead of guessing', () => {
  const row = { title: 'CPI m/m', country: 'USD', date: '2026-11-10T08:30:00-05:00', impact: 'High', forecast: '0.3%', previous: '0.6%' };
  const { events, rejected } = normalise([row, { ...row }, { ...row, date: '2026-11-10 08:30' }, { ...row, impact: 'Unknown' }, { title: '', country: 'USD', date: row.date, impact: 'High' }]);
  assert.equal(events.length, 1);
  assert.equal(rejected, 3);
});

test('sync stores the recorded real provider data once; re-sync creates no duplicates', async () => {
  const db = openDb(':memory:');
  const f1 = await syncCalendar(db, { fetchImpl: recordedProviderFetch(), now: new Date('2026-11-10T16:00:00Z') });
  assert.equal(f1.ok, 1);
  assert.equal(f1.events_received, 105);
  assert.equal(f1.events_new, 105);
  const f2 = await syncCalendar(db, { fetchImpl: recordedProviderFetch(), now: new Date('2026-11-10T17:00:00Z') });
  assert.equal(f2.events_new, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM econ_events').get().c, 105);
});

test('rescheduled/removed events are deactivated, not duplicated', async () => {
  const db = openDb(':memory:');
  await syncCalendar(db, { fetchImpl: recordedProviderFetch(), now: new Date('2026-11-10T16:00:00Z') });
  // Provider moves UK GDP by 30 minutes.
  await syncCalendar(db, {
    now: new Date('2026-11-10T17:00:00Z'),
    fetchImpl: recordedProviderFetch((d) => d.map((e) => (e.title === 'GDP m/m' && e.country === 'GBP' ? { ...e, date: '2026-11-12T02:30:00-05:00' } : e))),
  });
  const gdp = db.prepare("SELECT scheduled_at, active FROM econ_events WHERE title='GDP m/m' AND currency='GBP' ORDER BY scheduled_at").all();
  assert.deepEqual(gdp.map((r) => ({ ...r })), [{ scheduled_at: '2026-11-12T07:00:00.000Z', active: 0 }, { scheduled_at: '2026-11-12T07:30:00.000Z', active: 1 }]);
  const visible = queryEvents(db, { from: '2026-11-12T00:00:00Z', to: '2026-11-13T00:00:00Z', impacts: ['high'] }).filter((e) => e.title === 'GDP m/m');
  assert.equal(visible.length, 1);
});

test('HTTP 429 from provider: error recorded, Retry-After honoured, old data kept and flagged stale later', async () => {
  const db = openDb(':memory:');
  await syncCalendar(db, { fetchImpl: recordedProviderFetch(), now: new Date('2026-11-10T08:00:00Z') });
  const t = new Date('2026-11-10T09:00:00Z');
  const fail = await syncCalendar(db, { now: t, fetchImpl: async () => new Response('slow down', { status: 429, headers: { 'retry-after': '900' } }) });
  assert.equal(fail.ok, 0);
  assert.equal(fail.http_status, 429);
  assert.equal(kvGet(db, 'calendar.next_sync_at'), new Date(t.getTime() + 900e3).toISOString());
  assert.equal(db.prepare('SELECT COUNT(*) c FROM econ_events WHERE active=1').get().c, 105, 'existing data untouched');
  const fresh = calendarStatus(db, new Date(t.getTime() + 60e3));
  assert.equal(fresh.stale, false);
  assert.equal(fresh.lastAttemptOk, false);
  assert.match(fresh.lastError, /429/);
  const later = calendarStatus(db, new Date(Date.parse('2026-11-10T08:00:00Z') + 7 * 3600e3));
  assert.equal(later.stale, true);
  // network failure + invalid JSON also handled
  const net = await syncCalendar(db, { now: t, fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  assert.match(net.error, /Network error/);
  const bad = await syncCalendar(db, { now: t, fetchImpl: async () => new Response('<html>', { status: 200 }) });
  assert.match(bad.error, /invalid JSON/);
});

test('release status distinguishes schedule from verified release', () => {
  const now = new Date('2026-11-10T14:00:00Z');
  assert.equal(releaseStatus({ scheduled_at: '2026-11-10T15:00:00.000Z', actual: null }, now), 'scheduled');
  assert.equal(releaseStatus({ scheduled_at: '2026-11-10T13:30:00.000Z', actual: null }, now), 'time_passed_unverified');
  assert.equal(releaseStatus({ scheduled_at: '2026-11-10T13:30:00.000Z', actual: '0.4%' }, now), 'released_verified');
});

test('API: impact filters (high/medium default, low opt-in), currency filters, provider + last update shown', async () => {
  const app = await startApp({ fetchImpl: recordedProviderFetch(), now: () => new Date('2026-11-09T00:00:00Z') });
  try {
    await syncCalendar(app.db, { fetchImpl: recordedProviderFetch() });
    const { c } = await registerUser(app.base, 'cal@example.com');
    const def = (await c.get('/api/calendar?from=2026-11-08&to=2026-11-14')).data;
    assert.equal(def.timezone, 'Africa/Casablanca');
    assert.match(def.status.provider, /Forex Factory/);
    assert.ok(def.status.lastSuccessfulUpdate);
    assert.ok(def.events.length > 0);
    assert.ok(def.events.every((e) => e.impact === 'high' || e.impact === 'medium'), 'default = high + medium only');
    const high = (await c.get('/api/calendar?from=2026-11-08&to=2026-11-14&impacts=high')).data.events;
    assert.ok(high.length > 0 && high.every((e) => e.impact === 'high'));
    const med = (await c.get('/api/calendar?from=2026-11-08&to=2026-11-14&impacts=medium')).data.events;
    assert.ok(med.length > 0 && med.every((e) => e.impact === 'medium'));
    assert.equal(def.events.length, high.length + med.length);
    const low = (await c.get('/api/calendar?from=2026-11-08&to=2026-11-14&impacts=low')).data.events;
    assert.ok(low.length > 0 && low.every((e) => e.impact === 'low'));
    const gbp = (await c.get('/api/calendar?from=2026-11-08&to=2026-11-14&impacts=high,medium&currencies=GBP')).data.events;
    assert.ok(gbp.length > 0 && gbp.every((e) => e.currency === 'GBP'));
    const cpi = def.events.find((e) => e.title === 'CPI m/m' && e.currency === 'USD');
    assert.equal(cpi.localTime, '13:30');
    assert.equal(cpi.localDate, '2026-11-10');
    assert.equal(cpi.status, 'scheduled');
    assert.equal((await c.get('/api/calendar?impacts=extreme')).status, 400);
  } finally { await app.close(); }
});
