import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localDate, localTime, tzOffsetMinutes, startOfLocalDay, zonedToUtc, weekStart } from '../server/lib/time.js';
import { normalise } from '../server/services/providers/forexfactory.js';
import { presentEvent } from '../server/services/calendar.js';

const TZ = 'Africa/Casablanca';

test('Casablanca offset follows the IANA database, not a hard-coded +1', () => {
  // Summer 2026: UTC+1
  assert.equal(tzOffsetMinutes(new Date('2026-07-15T12:00:00Z'), TZ), 60);
  // Ramadan 2026 (15 Feb – 22 Mar): UTC+0
  assert.equal(tzOffsetMinutes(new Date('2026-02-20T12:00:00Z'), TZ), 0);
  // Morocco returned to permanent UTC+0 on 2026-09-20 01:00 UTC (tzdata 2026)
  assert.equal(tzOffsetMinutes(new Date('2026-09-20T00:59:00Z'), TZ), 60);
  assert.equal(tzOffsetMinutes(new Date('2026-09-20T01:00:00Z'), TZ), 0);
  assert.equal(tzOffsetMinutes(new Date('2026-11-10T12:00:00Z'), TZ), 0);
});

test('provider timestamps (US Eastern, explicit offset) convert to Casablanca wall-clock', () => {
  const { events } = normalise([
    { title: 'CPI m/m', country: 'USD', date: '2026-11-10T08:30:00-05:00', impact: 'High', forecast: '0.3%', previous: '0.6%' },
    { title: 'Retail Sales m/m', country: 'USD', date: '2026-07-15T08:30:00-04:00', impact: 'High', forecast: '', previous: '' },
  ]);
  const nov = presentEvent(events[0], TZ);
  assert.equal(nov.scheduledAtUtc, '2026-11-10T13:30:00.000Z');
  assert.equal(nov.localTime, '13:30');
  assert.equal(nov.utcOffset, 'UTC+00:00');
  const jul = presentEvent(events[1], TZ);
  assert.equal(jul.scheduledAtUtc, '2026-07-15T12:30:00.000Z');
  assert.equal(jul.localTime, '13:30'); // UTC+1 in July
  assert.equal(jul.utcOffset, 'UTC+01:00');
});

test('local day boundaries and wall-clock → UTC across the September 2026 change', () => {
  assert.equal(startOfLocalDay('2026-07-15', TZ).toISOString(), '2026-07-14T23:00:00.000Z');
  assert.equal(startOfLocalDay('2026-11-10', TZ).toISOString(), '2026-11-10T00:00:00.000Z');
  assert.equal(zonedToUtc(2026, 9, 21, 9, 0, 0, TZ).toISOString(), '2026-09-21T09:00:00.000Z');
  assert.equal(zonedToUtc(2026, 9, 19, 9, 0, 0, TZ).toISOString(), '2026-09-19T08:00:00.000Z');
  assert.equal(localDate(new Date('2026-07-14T23:30:00Z'), TZ), '2026-07-15');
  assert.equal(localTime(new Date('2026-07-14T23:30:00Z'), TZ), '00:30');
  assert.equal(weekStart('2026-11-15'), '2026-11-09');
  assert.equal(weekStart('2026-11-09'), '2026-11-09');
});
