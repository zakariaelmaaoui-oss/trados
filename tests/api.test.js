import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, client, registerUser } from './helpers.js';

let app;
before(async () => { app = await startApp(); });
after(async () => { await app.close(); });

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

test('account creation, login, logout, bad credentials, duplicate email', async () => {
  const c = client(app.base);
  const reg = await c.post('/api/auth/register', { email: 'Trader@Example.com', password: 'longenough1', displayName: 'Trader' });
  assert.equal(reg.status, 201);
  assert.equal(reg.data.user.email, 'trader@example.com');
  assert.equal(reg.data.user.defaultRiskPct, 1, 'risk default is 1%');
  assert.equal(reg.data.user.timezone, 'Africa/Casablanca');
  assert.equal((await c.get('/api/me')).status, 200);
  assert.equal((await c.post('/api/auth/logout')).status, 200);
  assert.equal((await c.get('/api/me')).status, 401);
  assert.equal((await c.post('/api/auth/login', { email: 'trader@example.com', password: 'wrong-password' })).status, 401);
  const ok = await c.post('/api/auth/login', { email: 'TRADER@example.com', password: 'longenough1' });
  assert.equal(ok.status, 200);
  assert.equal((await c.get('/api/me')).data.user.displayName, 'Trader');
  assert.equal((await client(app.base).post('/api/auth/register', { email: 'trader@example.com', password: 'longenough1' })).status, 409);
  assert.equal((await client(app.base).post('/api/auth/register', { email: 'x@y.z', password: 'short' })).status, 400);
  // risk default is customisable
  const r = await c.patch('/api/me', { defaultRiskPct: 0.5 });
  assert.equal(r.data.user.defaultRiskPct, 0.5);
  assert.equal((await c.patch('/api/me', { defaultRiskPct: 0 })).status, 400);
});

test('state-changing requests without the CSRF header are rejected', async () => {
  const { c } = await registerUser(app.base, 'csrf@example.com');
  const r = await c.post('/api/accounts', { name: 'X', type: 'live' }, { noCsrf: true });
  assert.equal(r.status, 403);
});

test('create and edit a daily plan, checklist, rules adherence and post-session review', async () => {
  const { c } = await registerUser(app.base, 'planner@example.com');
  const empty = (await c.get('/api/plans/2026-11-10')).data;
  assert.equal(empty.plan, null);
  assert.ok(empty.checklist.length > 0 && empty.rules.length > 0, 'starter checklist and rules exist');
  const created = await c.put('/api/plans/2026-11-10', { marketBias: 'USD strong into CPI', maxTrades: 3, maxDailyLossPct: 2, mentalState: 4 });
  assert.equal(created.status, 200);
  assert.equal(created.data.plan.marketBias, 'USD strong into CPI');
  const edited = await c.put('/api/plans/2026-11-10', { marketBias: 'Neutral until CPI', keyLevels: '1.0850 / 1.0800' });
  assert.equal(edited.data.plan.marketBias, 'Neutral until CPI');
  assert.equal(edited.data.plan.maxTrades, 3, 'untouched fields kept');
  const item = empty.checklist[0];
  const chk = await c.put(`/api/checklist/2026-11-10/${item.id}`, { checked: true });
  assert.equal(chk.data.checklist.find((i) => i.id === item.id).checked, true);
  const rule = empty.rules[0];
  const rev = await c.put('/api/plans/2026-11-10', { review: { followedPlan: true, wentWell: 'Waited for CPI', rating: 4, rules: { [rule.id]: true, [empty.rules[1].id]: false }, complete: true } });
  assert.ok(rev.data.plan.review.reviewedAt);
  assert.equal(rev.data.rules.find((r) => r.id === rule.id).followed, true);
  assert.equal(rev.data.rules.find((r) => r.id === empty.rules[1].id).followed, false);
  // weekly review
  assert.equal((await c.put('/api/weekly/2026-11-11', { whatWorked: 'x' })).status, 400, 'week must start Monday');
  const wk = await c.put('/api/weekly/2026-11-09', { whatWorked: 'Patience', rating: 4 });
  assert.equal(wk.data.review.whatWorked, 'Patience');
  // discipline uses these records
  const disc = (await c.get('/api/discipline?mode=demo&from=2026-11-10&to=2026-11-10')).data;
  const comp = Object.fromEntries(disc.days[0].components.map((x) => [x.key, x.score]));
  assert.equal(comp.plan, 1);
  assert.equal(comp.review, 1);
  assert.equal(comp.rules, 0.5);
  assert.equal(comp.checklist, 1 / empty.checklist.length);
  // validation
  assert.equal((await c.put('/api/plans/2026-02-30', {})).status, 400);
  assert.equal((await c.put('/api/plans/2026-11-10', { maxTrades: -1 })).status, 400);
});

test('register and edit trades; Demo and Live are separated everywhere', async () => {
  const { c } = await registerUser(app.base, 'sep@example.com');
  const demo = (await c.get('/api/accounts')).data.accounts.find((a) => a.type === 'demo');
  const live = (await c.post('/api/accounts', { name: 'Live ICM', type: 'live', startingBalance: 5000 })).data.account;
  const mk = (accountId, profit, symbol = 'EURUSD') => c.post('/api/trades', {
    accountId, symbol, direction: 'buy', volume: 0.5, openTime: '2026-11-10T09:00:00Z', closeTime: '2026-11-10T10:00:00Z',
    openPrice: 1.08, closePrice: 1.081, profit, commission: -2, swap: 0, notes: 'test',
  });
  const t1 = await mk(demo.id, 100);
  assert.equal(t1.status, 201);
  assert.equal(t1.data.trade.riskPct, 1);
  assert.equal(t1.data.trade.riskAmount, 100, '1% of 10,000 demo balance');
  assert.equal(t1.data.trade.rMultiple, 0.98);
  await mk(demo.id, -50, 'GBPUSD');
  const tl = await mk(live.id, 300, 'XAUUSD');
  assert.equal(tl.data.trade.riskAmount, 50, '1% of 5,000 live balance');

  // edit + notes correction
  const ed = await c.patch(`/api/trades/${t1.data.trade.id}`, { notes: 'Late entry', planFollowed: false, emotion: 'FOMO' });
  assert.equal(ed.data.trade.notes, 'Late entry');
  assert.equal(ed.data.trade.planFollowed, false);
  const ed2 = await c.patch(`/api/trades/${t1.data.trade.id}`, { profit: 120 });
  assert.equal(ed2.data.trade.netProfit, 118);
  assert.equal(ed2.data.trade.corrected, false, 'manual trades are not flagged as MT5 corrections');

  // separation
  const dTrades = (await c.get('/api/trades?mode=demo')).data.trades;
  const lTrades = (await c.get('/api/trades?mode=live')).data.trades;
  assert.deepEqual(dTrades.map((t) => t.symbol).sort(), ['EURUSD', 'GBPUSD']);
  assert.deepEqual(lTrades.map((t) => t.symbol), ['XAUUSD']);
  assert.ok(dTrades.every((t) => t.accountType === 'demo') && lTrades.every((t) => t.accountType === 'live'));
  const dStats = (await c.get('/api/stats?mode=demo')).data.stats;
  const lStats = (await c.get('/api/stats?mode=live')).data.stats;
  assert.equal(dStats.netPnl, 118 + -52);
  assert.equal(lStats.netPnl, 298);
  assert.equal((await c.patch(`/api/trades/${t1.data.trade.id}`, { accountId: live.id })).status, 400, 'cannot move demo trade into live');
  assert.equal((await c.get(`/api/trades?mode=demo&account=${live.id}`)).status, 404, 'live account not visible in demo mode');
  assert.equal((await c.patch(`/api/accounts/${live.id}`, { type: 'demo' })).status, 400, 'cannot flip account type with trades');

  // dashboard reflects stored records exactly
  const dash = (await c.get('/api/dashboard?mode=demo')).data;
  assert.equal(dash.stats.trades, 2);
  assert.equal(dash.stats.netPnl, 66);
  assert.equal(dash.stats.winRate, 50);
  assert.equal(dash.stats.profitFactor, Math.round((118 / 52) * 100) / 100);
  assert.equal(dash.balance.current, 10066);
  const liveDash = (await c.get('/api/dashboard?mode=live')).data;
  assert.equal(liveDash.stats.trades, 1);
  assert.equal(liveDash.stats.netPnl, 298);
  // and changes when records change
  await c.del(`/api/trades/${tl.data.trade.id}`);
  assert.equal((await c.get('/api/dashboard?mode=live')).data.stats.trades, 0);

  // validation
  assert.equal((await c.post('/api/trades', { accountId: demo.id, symbol: 'EURUSD', direction: 'long', volume: 1, openTime: '2026-11-10T09:00:00Z', openPrice: 1 })).status, 400);
  assert.equal((await c.post('/api/trades', { accountId: demo.id, symbol: 'EURUSD', direction: 'buy', volume: 1, openTime: '2026-11-10T09:00:00Z', closeTime: '2026-11-10T08:00:00Z', openPrice: 1, closePrice: 1, profit: 1 })).status, 400);
  const open = await c.post('/api/trades', { accountId: demo.id, symbol: 'USDJPY', direction: 'sell', volume: 1, openTime: '2026-11-10T09:00:00Z', openPrice: 150 });
  assert.equal(open.status, 201);
  assert.equal(open.data.trade.closeTime, null);
});

test('screenshots: before/after upload, magic-byte validation, owner-only access', async () => {
  const { c } = await registerUser(app.base, 'shots@example.com');
  const acc = (await c.get('/api/accounts')).data.accounts[0];
  const t = (await c.post('/api/trades', { accountId: acc.id, symbol: 'EURUSD', direction: 'buy', volume: 1, openTime: '2026-11-10T09:00:00Z', openPrice: 1.1 })).data.trade;
  const up = await c.post(`/api/trades/${t.id}/screenshots?kind=before`, PNG, { raw: true, headers: { 'Content-Type': 'image/png' } });
  assert.equal(up.status, 201);
  const up2 = await c.post(`/api/trades/${t.id}/screenshots?kind=after`, PNG, { raw: true, headers: { 'Content-Type': 'image/png' } });
  assert.equal(up2.status, 201);
  const fake = await c.post(`/api/trades/${t.id}/screenshots?kind=before`, Buffer.from('<script>alert(1)</script>........'), { raw: true, headers: { 'Content-Type': 'image/png' } });
  assert.equal(fake.status, 400);
  const full = (await c.get(`/api/trades/${t.id}`)).data.trade;
  assert.deepEqual(full.screenshots.map((s) => s.kind), ['before', 'after']);
  const img = await c.get(`/api/screenshots/${up.data.screenshot.id}`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  const { c: other } = await registerUser(app.base, 'shots-intruder@example.com');
  assert.equal((await other.get(`/api/screenshots/${up.data.screenshot.id}`)).status, 404);
  assert.equal((await other.del(`/api/screenshots/${up.data.screenshot.id}`)).status, 404);
  assert.equal((await other.post(`/api/trades/${t.id}/screenshots?kind=before`, PNG, { raw: true, headers: { 'Content-Type': 'image/png' } })).status, 404);
});

const CSV = [
  'Time,Position,Symbol,Type,Volume,Price,S / L,T / P,Time,Price,Commission,Swap,Profit',
  '2026.11.02 10:15:02,9001,EURUSD,buy,0.50,1.08120,1.07900,1.08600,2026.11.02 14:40:10,1.08410,-3.50,0.00,145.00',
  '2026.11.03 09:00:00,9002,GBPUSD,sell,0.20,1.27500,1.27800,1.27000,2026.11.03 11:30:00,1.27800,-1.40,0.00,-60.00',
  '2026.11.03 09:00:00,9003,GBPUSD,sell,abc,1.27500,,,2026.11.03 11:30:00,1.27800,0,0,-60.00',
].join('\n');

test('MT5 CSV import: preview validates, commit imports, re-import is deduplicated, stays in its mode', async () => {
  const { c } = await registerUser(app.base, 'mt5@example.com');
  const demo = (await c.get('/api/accounts')).data.accounts[0];
  const live = (await c.post('/api/accounts', { name: 'Live', type: 'live', startingBalance: 2000, serverUtcOffsetMin: 120 })).data.account;
  const pv = await c.post(`/api/imports/preview?account=${live.id}`, Buffer.from(CSV), { raw: true, headers: { 'Content-Type': 'text/csv' } });
  assert.equal(pv.status, 200);
  assert.deepEqual(pv.data.summary, { total: 3, valid: 2, invalid: 1, duplicates: 0, toImport: 2 });
  assert.equal((await c.get('/api/trades?mode=live')).data.trades.length, 0, 'preview writes nothing');
  const cm = await c.post(`/api/imports/commit?account=${live.id}`, Buffer.from(CSV), { raw: true, headers: { 'Content-Type': 'text/csv', 'X-File-Name': 'history.csv' } });
  assert.equal(cm.status, 201);
  assert.equal(cm.data.imported, 2);
  const lt = (await c.get('/api/trades?mode=live')).data.trades;
  assert.equal(lt.length, 2);
  assert.ok(lt.every((t) => t.source === 'mt5_csv' && t.accountType === 'live'));
  const eu = lt.find((t) => t.ticket === '9001');
  assert.equal(eu.openTime, '2026-11-02T08:15:02.000Z');
  assert.equal(eu.riskPct, 1);
  assert.equal((await c.get('/api/trades?mode=demo')).data.trades.length, 0, 'demo untouched');
  // re-import: duplicates detected and nothing new written
  const pv2 = await c.post(`/api/imports/preview?account=${live.id}`, Buffer.from(CSV), { raw: true });
  assert.equal(pv2.data.summary.duplicates, 2);
  assert.equal(pv2.data.summary.toImport, 0);
  assert.equal((await c.post(`/api/imports/commit?account=${live.id}`, Buffer.from(CSV), { raw: true })).status, 400);
  assert.equal((await c.get('/api/trades?mode=live')).data.trades.length, 2);
  // same tickets into the demo account are a separate set
  assert.equal((await c.post(`/api/imports/commit?account=${demo.id}`, Buffer.from(CSV), { raw: true })).data.imported, 2);
  // manual correction of an imported trade is flagged
  const corr = await c.patch(`/api/trades/${eu.id}`, { profit: 140 });
  assert.equal(corr.data.trade.corrected, true);
  // bad files
  assert.equal((await c.post(`/api/imports/preview?account=${live.id}`, Buffer.from('a,b\n1,2'), { raw: true })).status, 400);
  assert.equal((await c.post(`/api/imports/preview?account=${live.id}`, Buffer.alloc(0), { raw: true })).status, 400);
  assert.equal((await c.get('/api/imports')).data.imports.length, 2);
});

test('privacy: users cannot read or modify another user\'s records', async () => {
  const { c: a } = await registerUser(app.base, 'alice@example.com');
  const { c: b } = await registerUser(app.base, 'bob@example.com');
  const accA = (await a.get('/api/accounts')).data.accounts[0];
  const tA = (await a.post('/api/trades', { accountId: accA.id, symbol: 'EURUSD', direction: 'buy', volume: 1, openTime: '2026-11-10T09:00:00Z', closeTime: '2026-11-10T10:00:00Z', openPrice: 1.1, closePrice: 1.2, profit: 999, notes: 'secret' })).data.trade;
  await a.put('/api/plans/2026-11-10', { marketBias: 'alice private bias' });

  assert.equal((await b.get(`/api/trades/${tA.id}`)).status, 404);
  assert.equal((await b.patch(`/api/trades/${tA.id}`, { notes: 'hacked' })).status, 404);
  assert.equal((await b.del(`/api/trades/${tA.id}`)).status, 404);
  assert.equal((await b.post('/api/trades', { accountId: accA.id, symbol: 'EURUSD', direction: 'buy', volume: 1, openTime: '2026-11-10T09:00:00Z', openPrice: 1 })).status, 404, 'cannot write into another user\'s account');
  assert.equal((await b.patch(`/api/accounts/${accA.id}`, { name: 'x' })).status, 404);
  assert.equal((await b.del(`/api/accounts/${accA.id}`)).status, 404);
  assert.equal((await b.post(`/api/imports/preview?account=${accA.id}`, Buffer.from(CSV), { raw: true })).status, 404);
  assert.equal((await b.get(`/api/trades?mode=demo&account=${accA.id}`)).status, 404);
  const bTrades = (await b.get('/api/trades?mode=demo')).data.trades;
  assert.equal(bTrades.length, 0);
  assert.equal((await b.get('/api/stats?mode=demo')).data.stats.netPnl, 0);
  assert.equal((await b.get('/api/dashboard?mode=demo')).data.stats.trades, 0);
  assert.equal((await b.get('/api/plans/2026-11-10')).data.plan, null);
  assert.ok(!JSON.stringify((await b.get('/api/reports/daily/2026-11-10')).data).includes('alice private bias'));
  assert.equal((await b.get('/api/accounts')).data.accounts.some((x) => x.id === accA.id), false);
  const rulesA = (await a.get('/api/rules')).data.rules;
  assert.equal((await b.patch(`/api/rules/${rulesA[0].id}`, { rule: 'x' })).status, 404);
  assert.equal((await b.put('/api/plans/2026-11-10', { review: { rules: { [rulesA[0].id]: true } } })).status, 400);
  const itemsA = (await a.get('/api/checklist/items')).data.items;
  assert.equal((await b.put(`/api/checklist/2026-11-10/${itemsA[0].id}`, { checked: true })).status, 404);
  // unauthenticated
  const anon = client(app.base);
  for (const u of ['/api/trades', `/api/trades/${tA.id}`, '/api/dashboard', '/api/plans/2026-11-10', '/api/calendar', '/api/notifications/history']) {
    assert.equal((await anon.get(u)).status, 401, u);
  }
  // A's data intact
  assert.equal((await a.get(`/api/trades/${tA.id}`)).data.trade.notes, 'secret');
});
