import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, registerUser, client } from './helpers.js';

let app;
before(async () => { app = await startApp(); });
after(async () => { await app.close(); });

// What the EA sends: MQL5 datetimes are broker server time (here UTC+2).
const SERVER_OFFSET = 7200;
const srv = (iso) => Date.parse(iso) / 1000 + SERVER_OFFSET;
const pos = (ticket, over = {}) => ({
  ticket: String(ticket), symbol: 'EURUSD', type: 'buy', volume: 0.5,
  open_time: srv('2026-11-10T09:15:00Z'), close_time: srv('2026-11-10T10:30:00Z'),
  open_price: 1.081, close_price: 1.085, sl: 1.079, tp: 0, commission: -3.5, swap: 0, profit: 200, ...over,
});
const payload = (positions, account = {}) => ({ account: { login: '51234567', server: 'Broker-Demo', currency: 'USD', trade_mode: 'demo', server_gmt_offset_sec: SERVER_OFFSET + 3, ...account }, positions });
const ea = (key, body) => fetch(`${app.base}/api/mt5/positions`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, data: await r.json() }));

test('sync key lifecycle: created once, listed by hint, revocable; EA ping works with it', async () => {
  const { c } = await registerUser(app.base, 'keys@example.com');
  const acc = (await c.get('/api/accounts')).data.accounts[0];
  const k = await c.post(`/api/accounts/${acc.id}/sync-keys`);
  assert.equal(k.status, 201);
  assert.match(k.data.key, /^tos_[\w-]{30,}$/);
  const list = (await c.get(`/api/accounts/${acc.id}/sync-keys`)).data.keys;
  assert.equal(list.length, 1);
  assert.equal(list[0].hint, k.data.key.slice(-4));
  assert.ok(!JSON.stringify(list).includes(k.data.key), 'full key never listed again');
  const ping = await fetch(`${app.base}/api/mt5/ping`, { headers: { Authorization: `Bearer ${k.data.key}` } });
  assert.equal(ping.status, 200);
  assert.deepEqual(await ping.json(), { ok: true, account: 'Demo account', type: 'demo' });
  assert.equal((await c.del(`/api/sync-keys/${list[0].id}`)).status, 200);
  assert.equal((await fetch(`${app.base}/api/mt5/ping`, { headers: { Authorization: `Bearer ${k.data.key}` } })).status, 401);
});

test('EA push: closed positions imported with UTC times, duplicates ignored, invalid rows reported', async () => {
  const { c } = await registerUser(app.base, 'ea@example.com');
  const acc = (await c.get('/api/accounts')).data.accounts[0];
  const key = (await c.post(`/api/accounts/${acc.id}/sync-keys`)).data.key;
  assert.equal((await ea(null, payload([pos(1)]))).status, 401);
  assert.equal((await ea('tos_wrongwrongwrongwrongwrongwrong', payload([pos(1)]))).status, 401);

  const r = await ea(key, payload([pos(1001), pos(1002, { symbol: 'XAUUSD', type: 'sell', profit: -40, close_price: 2651 }), pos(1003, { volume: 0 })]));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.imported, 2);
  assert.equal(r.data.invalid.length, 1);
  assert.deepEqual(r.data.invalid[0].errors, ['volume']);
  const trades = (await c.get('/api/trades?mode=demo')).data.trades;
  assert.equal(trades.length, 2);
  const t = trades.find((x) => x.ticket === '1001');
  assert.equal(t.source, 'mt5_sync');
  assert.equal(t.openTime, '2026-11-10T09:15:00.000Z', 'server time UTC+2 converted to UTC');
  assert.equal(t.closeTime, '2026-11-10T10:30:00.000Z');
  assert.equal(t.netProfit, 196.5);
  assert.equal(t.riskPct, 1);
  assert.equal(t.riskAmount, 100);
  assert.equal(t.stopLoss, 1.079);
  assert.equal(t.takeProfit, null);

  // EA re-sends the same history every minute: nothing is duplicated.
  const again = await ea(key, payload([pos(1001), pos(1002, { symbol: 'XAUUSD', type: 'sell', profit: -40, close_price: 2651 })]));
  assert.equal(again.data.imported, 0);
  assert.equal(again.data.duplicates, 2);
  assert.equal((await c.get('/api/trades?mode=demo')).data.trades.length, 2);

  // A user's manual corrections/notes are never overwritten by later syncs.
  await c.patch(`/api/trades/${t.id}`, { notes: 'Clean entry', profit: 210 });
  await ea(key, payload([pos(1001)]));
  const after1 = (await c.get(`/api/trades/${t.id}`)).data.trade;
  assert.equal(after1.notes, 'Clean entry');
  assert.equal(after1.profit, 210);
  assert.equal(after1.corrected, true);

  // CSV import and live sync share position tickets: no double counting.
  const csv = 'Time,Position,Symbol,Type,Volume,Price,S / L,T / P,Time,Price,Commission,Swap,Profit\n2026.11.10 11:15:00,1001,EURUSD,buy,0.5,1.081,,,2026.11.10 12:30:00,1.085,-3.5,0,200\n';
  const pv = await c.post(`/api/imports/preview?account=${acc.id}`, Buffer.from(csv), { raw: true });
  assert.equal(pv.data.summary.duplicates, 1);

  // Sync status shown in Settings
  const keys = (await c.get(`/api/accounts/${acc.id}/sync-keys`)).data.keys;
  assert.ok(keys[0].lastUsedAt);
  assert.equal(keys[0].mt5Login, '51234567');
});

test('Demo/Live protection: a real MT5 account cannot push into a demo TradeOS account, and vice versa', async () => {
  const { c } = await registerUser(app.base, 'guard@example.com');
  const demo = (await c.get('/api/accounts')).data.accounts[0];
  const live = (await c.post('/api/accounts', { name: 'Live', type: 'live', startingBalance: 1000 })).data.account;
  const dKey = (await c.post(`/api/accounts/${demo.id}/sync-keys`)).data.key;
  const lKey = (await c.post(`/api/accounts/${live.id}/sync-keys`)).data.key;
  const r1 = await ea(dKey, payload([pos(1)], { trade_mode: 'real' }));
  assert.equal(r1.status, 409);
  assert.match(r1.data.error, /LIVE account/);
  const r2 = await ea(lKey, payload([pos(2)], { trade_mode: 'demo', login: '999' }));
  assert.equal(r2.status, 409);
  assert.equal((await ea(lKey, payload([pos(3)], { trade_mode: 'real', login: '999' }))).data.imported, 1);
  assert.equal((await c.get('/api/trades?mode=demo')).data.trades.length, 0);
  assert.deepEqual((await c.get('/api/trades?mode=live')).data.trades.map((t) => t.ticket), ['3']);
  // the key is now bound to MT5 login 999
  const other = await ea(lKey, payload([pos(4)], { trade_mode: 'real', login: '1234' }));
  assert.equal(other.status, 409);
  assert.match(other.data.error, /already linked to MT5 account 999/);
});

test('privacy: keys are per user/account; another user cannot see or create keys for my account', async () => {
  const { c: a } = await registerUser(app.base, 'kowner@example.com');
  const { c: b } = await registerUser(app.base, 'kintruder@example.com');
  const acc = (await a.get('/api/accounts')).data.accounts[0];
  const k = (await a.post(`/api/accounts/${acc.id}/sync-keys`)).data;
  assert.equal((await b.get(`/api/accounts/${acc.id}/sync-keys`)).status, 404);
  assert.equal((await b.post(`/api/accounts/${acc.id}/sync-keys`)).status, 404);
  assert.equal((await b.del(`/api/sync-keys/${k.info.id}`)).status, 404);
  // a key only ever writes to its own account
  await ea(k.key, payload([pos(77)]));
  assert.equal((await b.get('/api/trades?mode=demo')).data.trades.length, 0);
  assert.equal((await a.get('/api/trades?mode=demo')).data.trades.length, 1);
  assert.equal((await client(app.base).get(`/api/accounts/${acc.id}/sync-keys`)).status, 401);
});

test('payload validation: missing offset, too many positions, bad JSON', async () => {
  const { c } = await registerUser(app.base, 'val@example.com');
  const acc = (await c.get('/api/accounts')).data.accounts[0];
  const key = (await c.post(`/api/accounts/${acc.id}/sync-keys`)).data.key;
  assert.equal((await ea(key, { account: {}, positions: [] })).status, 400);
  assert.equal((await ea(key, payload(Array.from({ length: 501 }, (_, i) => pos(i + 1))))).status, 400);
  const bad = await fetch(`${app.base}/api/mt5/positions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: '{oops' });
  assert.equal(bad.status, 400);
  assert.equal((await ea(key, payload([]))).status, 200);
});

test('Connect MT5 key: account created automatically from the terminal (name, Demo/Live, balance)', async () => {
  const { c } = await registerUser(app.base, 'auto@example.com');
  const k = await c.post('/api/sync-keys');
  assert.equal(k.status, 201);
  const key = k.data.key;
  const ping = await (await fetch(`${app.base}/api/mt5/ping`, { headers: { Authorization: `Bearer ${key}` } })).json();
  assert.equal(ping.type, 'auto');

  // Demo terminal, balance 10 196.50 after one +196.50 trade.
  const demoAcct = { login: '61000001', server: 'ICMarketsSC-Demo', company: 'Raw Trading Ltd', currency: 'USD', trade_mode: 'demo', balance: 10196.5 };
  const r = await ea(key, payload([pos(5001)], demoAcct));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.imported, 1);
  assert.equal(r.data.account, 'Raw Trading Ltd 61000001');
  let accounts = (await c.get('/api/accounts')).data.accounts;
  const auto = accounts.find((a) => a.mt5Login === '61000001');
  assert.equal(auto.type, 'demo');
  assert.equal(auto.broker, 'Raw Trading Ltd');
  assert.equal(auto.startingBalance, 10000);
  assert.equal(auto.autoBalance, true);
  assert.equal(auto.serverUtcOffsetMin, 120);
  const t = (await c.get(`/api/trades?mode=demo&account=${auto.id}`)).data.trades[0];
  assert.equal(t.riskAmount, 100, '1% of the balance before the trade');
  let dash = (await c.get('/api/dashboard?mode=demo')).data;

  // Same key, real terminal → a separate LIVE account, never mixed with demo.
  const liveAcct = { login: '72000002', server: 'ICMarketsSC-Live07', company: 'Raw Trading Ltd', currency: 'EUR', trade_mode: 'real', balance: 2500 };
  assert.equal((await ea(key, payload([pos(9001, { profit: -40 })], liveAcct))).data.imported, 1);
  accounts = (await c.get('/api/accounts')).data.accounts;
  const live = accounts.find((a) => a.mt5Login === '72000002');
  assert.equal(live.type, 'live');
  assert.equal(live.currency, 'EUR');
  assert.deepEqual((await c.get('/api/trades?mode=live')).data.trades.map((x) => x.ticket), ['9001']);
  assert.ok(!(await c.get('/api/trades?mode=demo')).data.trades.some((x) => x.ticket === '9001'));

  // Re-sync: no duplicate account, no duplicate trades; balance follows MT5 (e.g. after a deposit).
  await ea(key, payload([pos(5001)], { ...demoAcct, balance: 11196.5 }));
  accounts = (await c.get('/api/accounts')).data.accounts;
  assert.equal(accounts.filter((a) => a.mt5Login === '61000001').length, 1);
  assert.equal(accounts.find((a) => a.mt5Login === '61000001').startingBalance, 11000);
  dash = (await c.get(`/api/dashboard?mode=demo`)).data;
  assert.ok(dash.balance.current >= 11196.5, 'dashboard shows the real MT5 balance');

  // Editing the starting balance by hand stops auto-follow; Demo/Live can't be flipped.
  assert.equal((await c.patch(`/api/accounts/${auto.id}`, { startingBalance: 5000 })).data.account.autoBalance, false);
  await ea(key, payload([], { ...demoAcct, balance: 99999 }));
  assert.equal((await c.get('/api/accounts')).data.accounts.find((a) => a.id === auto.id).startingBalance, 5000);
  assert.equal((await c.patch(`/api/accounts/${auto.id}`, { type: 'live' })).status, 400);

  // Empty heartbeat from a brand-new terminal still creates its account.
  await ea(key, payload([], { ...demoAcct, login: '61000009', balance: 500 }));
  assert.ok((await c.get('/api/accounts')).data.accounts.some((a) => a.mt5Login === '61000009' && a.startingBalance === 500));

  // Old EA without login/trade_mode can't use a connect key.
  assert.equal((await ea(key, { account: { server_gmt_offset_sec: 7200 }, positions: [] })).status, 400);
  // Keys listed (without the secret) and revocable
  const list = (await c.get('/api/sync-keys')).data.keys;
  assert.equal(list.length, 1);
  assert.equal(list[0].auto, true);
  assert.ok(!JSON.stringify(list).includes(key));
});

test('Connect MT5 key privacy: the same MT5 login under two TradeOS users stays separate', async () => {
  const { c: a } = await registerUser(app.base, 'autoA@example.com');
  const { c: b } = await registerUser(app.base, 'autoB@example.com');
  const ka = (await a.post('/api/sync-keys')).data.key;
  const kb = (await b.post('/api/sync-keys')).data.key;
  const acct = { login: '123', server: 'S', company: 'B', trade_mode: 'demo', balance: 1000 };
  await ea(ka, payload([pos(1)], acct));
  await ea(kb, payload([pos(2)], acct));
  assert.deepEqual((await a.get('/api/trades?mode=demo')).data.trades.map((t) => t.ticket), ['1']);
  assert.deepEqual((await b.get('/api/trades?mode=demo')).data.trades.map((t) => t.ticket), ['2']);
  assert.equal((await b.get('/api/sync-keys')).data.keys.length, 1);
});

test('a trade typed in on the phone is completed by the later MT5 sync, not duplicated', async () => {
  const { c } = await registerUser(app.base, 'phone@example.com');
  const key = (await c.post('/api/sync-keys')).data.key;
  const acct = { login: '7001', server: 'B-Demo', company: 'B', trade_mode: 'demo', balance: 10196.5 };
  await ea(key, payload([], acct)); // PC connected once → account exists
  const acc = (await c.get('/api/accounts')).data.accounts.find((a) => a.mt5Login === '7001');
  // On the phone: approximate times, estimated profit, notes.
  const manual = (await c.post('/api/trades', { accountId: acc.id, symbol: 'EURUSD', direction: 'buy', volume: 0.5, openTime: '2026-11-10T09:05:00Z', closeTime: '2026-11-10T10:40:00Z', openPrice: 1.081, closePrice: 1.085, profit: 200, notes: 'from phone', planFollowed: true })).data.trade;
  // Unrelated manual trade (different lots) must stay separate.
  await c.post('/api/trades', { accountId: acc.id, symbol: 'EURUSD', direction: 'buy', volume: 1, openTime: '2026-11-10T09:05:00Z', closeTime: '2026-11-10T10:40:00Z', openPrice: 1.081, closePrice: 1.085, profit: 400 });
  // Later the PC syncs the real position (broker symbol suffix, exact times, commission).
  const r = await ea(key, payload([pos(4242, { symbol: 'EURUSD.r' })], acct));
  assert.equal(r.data.matched, 1);
  assert.equal(r.data.imported, 0);
  const trades = (await c.get(`/api/trades?mode=demo&account=${acc.id}`)).data.trades;
  assert.equal(trades.length, 2, 'no duplicate');
  const t = trades.find((x) => x.id === manual.id);
  assert.equal(t.ticket, '4242');
  assert.equal(t.source, 'mt5_sync');
  assert.equal(t.openTime, '2026-11-10T09:15:00.000Z', 'exact MT5 times replace the estimate');
  assert.equal(t.commission, -3.5);
  assert.equal(t.notes, 'from phone', 'notes kept');
  assert.equal(t.planFollowed, true);
  // Re-sync: already linked by ticket.
  assert.equal((await ea(key, payload([pos(4242, { symbol: 'EURUSD.r' })], acct))).data.duplicates, 1);
});
