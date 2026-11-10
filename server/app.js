import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  hashPassword, verifyPassword, createSession, destroySession, sessionCookie,
  loadUser, requireUser, csrfGuard, rateLimit, COOKIE,
} from './auth.js';
import { tx } from './db.js';
import { isValidYmd, isValidTz, startOfLocalDay, addDays, weekStart, localDate, DEFAULT_TZ } from './lib/time.js';
import { tradesFor, computeStats, disciplineForDay, disciplineRange, net } from './services/stats.js';
import { parseMt5Csv } from './services/mt5.js';
import { calendarStatus, presentEvent, queryEvents, syncCalendar } from './services/calendar.js';
import { getPrefs, SUPPORTED_CURRENCIES, sendTestNotification, prefImpacts, prefCurrencies } from './services/notifications.js';
import { isValidSubscription } from './services/push.js';

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = msg => new HttpError(400, msg);
const notFound = (what = 'Not found') => new HttpError(404, what);

// ---- small validators -------------------------------------------------------
const str = (v, { max = 2000, required = false, name = 'field' } = {}) => {
  if (v === undefined || v === null || v === '') { if (required) throw bad(`${name} is required`); return null; }
  if (typeof v !== 'string') throw bad(`${name} must be text`);
  if (v.length > max) throw bad(`${name} is too long (max ${max})`);
  return v.trim();
};
const num = (v, { min = -Infinity, max = Infinity, required = false, name = 'field', int = false } = {}) => {
  if (v === undefined || v === null || v === '') { if (required) throw bad(`${name} is required`); return null; }
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max || (int && !Number.isInteger(n))) throw bad(`${name} is out of range`);
  return n;
};
const bool01 = (v, name) => {
  if (v === undefined || v === null || v === '') return null;
  if (v === true || v === 1 || v === '1') return 1;
  if (v === false || v === 0 || v === '0') return 0;
  throw bad(`${name} must be true/false`);
};
const iso = (v, { required = false, name = 'time' } = {}) => {
  if (v === undefined || v === null || v === '') { if (required) throw bad(`${name} is required`); return null; }
  const d = new Date(v);
  if (typeof v !== 'string' || isNaN(d)) throw bad(`${name} is not a valid date/time`);
  return d.toISOString();
};
const ymd = (v, name = 'date') => { if (!isValidYmd(v)) throw bad(`${name} must be YYYY-MM-DD`); return v; };
const mode = (v, user) => {
  const m = v || user.active_mode;
  if (m !== 'demo' && m !== 'live') throw bad('mode must be demo or live');
  return m;
};
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const IMAGE_SIGS = [
  { mime: 'image/png', ext: 'png', test: b => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: 'image/jpeg', ext: 'jpg', test: b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/webp', ext: 'webp', test: b => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP' },
  { mime: 'image/gif', ext: 'gif', test: b => b.subarray(0, 4).toString() === 'GIF8' },
];

const STARTER_CHECKLIST = [
  'Checked the economic calendar for high/medium impact news',
  'Marked key levels on my watchlist pairs',
  'Defined my bias and invalidation for each setup',
  'Position size calculated from my risk % before entry',
  'Mentally ready — not trading to recover losses',
];
const STARTER_RULES = [
  ['Risk no more than my default risk % per trade', 'risk'],
  ['Every trade has a stop loss at entry', 'risk'],
  ['No new entries 15 minutes before high-impact news', 'news'],
  ['Stop trading after hitting the daily loss limit', 'risk'],
  ['Only take setups defined in my plan', 'execution'],
];

export function createApp(db, { dataDir, publicDir, vapid, sender, fetchImpl, secureCookies = false, now = () => new Date() } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  const uploadDir = path.join(dataDir, 'uploads');
  fs.mkdirSync(uploadDir, { recursive: true });

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'X-Frame-Options': 'DENY',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self'; script-src 'self'; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    });
    next();
  });
  app.use('/api', express.json({ limit: '200kb' }));
  app.use('/api', loadUser(db));
  app.use('/api', csrfGuard);
  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  const ownAccount = (userId, id) => db.prepare('SELECT * FROM accounts WHERE id=? AND user_id=?').get(id, userId);
  const ownTrade = (userId, id) => db.prepare('SELECT * FROM trades WHERE id=? AND user_id=?').get(id, userId);

  // ---- auth --------------------------------------------------------------------
  const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });
  const publicUser = u => ({ id: u.id, email: u.email, displayName: u.display_name, defaultRiskPct: u.default_risk_pct, timezone: u.timezone, activeMode: u.active_mode });

  app.post('/api/auth/register', authLimiter, wrap((req, res) => {
    const email = str(req.body.email, { required: true, max: 200, name: 'Email' }).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad('Enter a valid email address');
    const pw = req.body.password;
    if (typeof pw !== 'string' || pw.length < 8 || pw.length > 200) throw bad('Password must be at least 8 characters');
    const name = str(req.body.displayName, { max: 80, name: 'Name' }) || email.split('@')[0];
    if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) throw new HttpError(409, 'An account with this email already exists');
    const userId = tx(db, () => {
      const id = Number(db.prepare('INSERT INTO users(email,password_hash,display_name) VALUES(?,?,?)').run(email, hashPassword(pw), name).lastInsertRowid);
      db.prepare(`INSERT INTO accounts(user_id,name,type,starting_balance) VALUES (?,?,?,?)`).run(id, 'Demo account', 'demo', 10000);
      STARTER_CHECKLIST.forEach((l, i) => db.prepare('INSERT INTO checklist_items(user_id,label,position) VALUES(?,?,?)').run(id, l, i));
      STARTER_RULES.forEach(([r, c], i) => db.prepare('INSERT INTO trading_rules(user_id,rule,category,position) VALUES(?,?,?,?)').run(id, r, c, i));
      db.prepare('INSERT INTO notification_prefs(user_id) VALUES(?)').run(id);
      return id;
    });
    const s = createSession(db, userId);
    res.set('Set-Cookie', sessionCookie(s.token, s.maxAge, secureCookies));
    res.status(201).json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(userId)) });
  }));

  app.post('/api/auth/login', authLimiter, wrap((req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const u = db.prepare('SELECT * FROM users WHERE email=?').get(email);
    const ok = u && typeof req.body.password === 'string' && verifyPassword(req.body.password, u.password_hash);
    if (!ok) throw new HttpError(401, 'Incorrect email or password');
    const s = createSession(db, u.id);
    res.set('Set-Cookie', sessionCookie(s.token, s.maxAge, secureCookies));
    res.json({ user: publicUser(u) });
  }));

  app.post('/api/auth/logout', (req, res) => {
    destroySession(db, req.sessionToken);
    res.set('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    res.json({ ok: true });
  });

  app.get('/api/me', requireUser, (req, res) => res.json({ user: publicUser(req.user) }));
  app.patch('/api/me', requireUser, wrap((req, res) => {
    const b = req.body;
    const cur = req.user;
    const name = b.displayName !== undefined ? str(b.displayName, { required: true, max: 80, name: 'Name' }) : cur.display_name;
    const risk = b.defaultRiskPct !== undefined ? num(b.defaultRiskPct, { min: 0.01, max: 100, required: true, name: 'Default risk %' }) : cur.default_risk_pct;
    const tz = b.timezone !== undefined ? b.timezone : cur.timezone;
    if (!isValidTz(tz)) throw bad('Unknown timezone');
    const m = b.activeMode !== undefined ? mode(b.activeMode, cur) : cur.active_mode;
    db.prepare('UPDATE users SET display_name=?, default_risk_pct=?, timezone=?, active_mode=? WHERE id=?').run(name, risk, tz, m, cur.id);
    res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(cur.id)) });
  }));

  app.use('/api', (req, res, next) => (req.path.startsWith('/push/vapid') || req.path === '/health') ? next() : requireUser(req, res, next));

  // ---- accounts -----------------------------------------------------------------
  const accountView = a => ({ id: a.id, name: a.name, type: a.type, broker: a.broker, currency: a.currency, startingBalance: a.starting_balance, serverUtcOffsetMin: a.server_utc_offset_min });
  const readAccount = (b, cur = {}) => ({
    name: b.name !== undefined ? str(b.name, { required: true, max: 80, name: 'Account name' }) : cur.name,
    type: b.type !== undefined ? (['demo', 'live'].includes(b.type) ? b.type : (() => { throw bad('Account type must be demo or live'); })()) : cur.type,
    broker: b.broker !== undefined ? str(b.broker, { max: 80, name: 'Broker' }) : (cur.broker ?? null),
    currency: b.currency !== undefined ? (/^[A-Z]{3}$/.test(b.currency) ? b.currency : (() => { throw bad('Currency must be a 3-letter code'); })()) : (cur.currency || 'USD'),
    starting_balance: b.startingBalance !== undefined ? num(b.startingBalance, { min: 0, max: 1e12, required: true, name: 'Starting balance' }) : (cur.starting_balance ?? 0),
    server_utc_offset_min: b.serverUtcOffsetMin !== undefined ? num(b.serverUtcOffsetMin, { min: -720, max: 840, int: true, required: true, name: 'Server UTC offset' }) : (cur.server_utc_offset_min ?? 120),
  });
  app.get('/api/accounts', (req, res) => {
    res.json({ accounts: db.prepare('SELECT * FROM accounts WHERE user_id=? ORDER BY type, name').all(req.user.id).map(accountView) });
  });
  app.post('/api/accounts', wrap((req, res) => {
    const a = readAccount(req.body);
    if (!a.type) throw bad('Account type must be demo or live');
    const id = db.prepare('INSERT INTO accounts(user_id,name,type,broker,currency,starting_balance,server_utc_offset_min) VALUES(?,?,?,?,?,?,?)')
      .run(req.user.id, a.name, a.type, a.broker, a.currency, a.starting_balance, a.server_utc_offset_min).lastInsertRowid;
    res.status(201).json({ account: accountView(ownAccount(req.user.id, id)) });
  }));
  app.patch('/api/accounts/:id', wrap((req, res) => {
    const cur = ownAccount(req.user.id, req.params.id);
    if (!cur) throw notFound('Account not found');
    const a = readAccount(req.body, cur);
    if (a.type !== cur.type && db.prepare('SELECT COUNT(*) c FROM trades WHERE account_id=?').get(cur.id).c > 0)
      throw bad('Cannot change Demo/Live type of an account that has trades — create a new account instead');
    db.prepare('UPDATE accounts SET name=?, type=?, broker=?, currency=?, starting_balance=?, server_utc_offset_min=? WHERE id=? AND user_id=?')
      .run(a.name, a.type, a.broker, a.currency, a.starting_balance, a.server_utc_offset_min, cur.id, req.user.id);
    res.json({ account: accountView(ownAccount(req.user.id, cur.id)) });
  }));
  app.delete('/api/accounts/:id', wrap((req, res) => {
    const cur = ownAccount(req.user.id, req.params.id);
    if (!cur) throw notFound('Account not found');
    const shots = db.prepare('SELECT s.file_name FROM trade_screenshots s JOIN trades t ON t.id=s.trade_id WHERE t.account_id=?').all(cur.id);
    db.prepare('DELETE FROM accounts WHERE id=? AND user_id=?').run(cur.id, req.user.id);
    for (const s of shots) fs.rm(path.join(uploadDir, s.file_name), { force: true }, () => {});
    res.json({ ok: true });
  }));

  // ---- trades -----------------------------------------------------------------
  const shotsFor = tradeId => db.prepare('SELECT id, kind, mime, size, created_at FROM trade_screenshots WHERE trade_id=? ORDER BY id').all(tradeId);
  const tradeView = t => ({
    id: t.id, accountId: t.account_id, accountName: t.account_name, accountType: t.account_type, ticket: t.ticket, source: t.source,
    symbol: t.symbol, direction: t.direction, volume: t.volume, openTime: t.open_time, closeTime: t.close_time,
    openPrice: t.open_price, closePrice: t.close_price, stopLoss: t.stop_loss, takeProfit: t.take_profit,
    commission: t.commission, swap: t.swap, profit: t.profit, netProfit: t.profit === null ? null : Math.round(net(t) * 100) / 100,
    riskPct: t.risk_pct, riskAmount: t.risk_amount,
    rMultiple: t.risk_amount > 0 && t.profit !== null ? Math.round((net(t) / t.risk_amount) * 100) / 100 : null,
    setup: t.setup, planFollowed: t.plan_followed === null ? null : !!t.plan_followed, emotion: t.emotion, notes: t.notes,
    corrected: !!t.corrected, createdAt: t.created_at, updatedAt: t.updated_at,
  });
  const fullTrade = (userId, id) => db.prepare(`SELECT t.*, a.name account_name, a.type account_type FROM trades t JOIN accounts a ON a.id=t.account_id WHERE t.id=? AND t.user_id=?`).get(id, userId);

  /** Risk amount = risk % of the account balance at entry (starting balance + realised P&L before the trade). */
  const riskAmountFor = (account, riskPct, openTime, excludeId = null) => {
    const prior = db.prepare(`SELECT COALESCE(SUM(COALESCE(profit,0)+commission+swap),0) s FROM trades WHERE account_id=? AND close_time IS NOT NULL AND close_time <= ? AND id IS NOT ?`).get(account.id, openTime, excludeId).s;
    const bal = account.starting_balance + prior;
    return bal > 0 ? Math.round(bal * riskPct) / 100 : null;
  };

  const readTrade = (b, cur, user) => {
    const t = {
      symbol: b.symbol !== undefined ? str(b.symbol, { required: true, max: 20, name: 'Symbol' })?.toUpperCase() : cur?.symbol,
      direction: b.direction !== undefined ? b.direction : cur?.direction,
      volume: b.volume !== undefined ? num(b.volume, { min: 0.0000001, max: 1e7, required: true, name: 'Volume' }) : cur?.volume,
      open_time: b.openTime !== undefined ? iso(b.openTime, { required: true, name: 'Open time' }) : cur?.open_time,
      close_time: b.closeTime !== undefined ? iso(b.closeTime, { name: 'Close time' }) : cur?.close_time ?? null,
      open_price: b.openPrice !== undefined ? num(b.openPrice, { min: 0.0000001, required: true, name: 'Open price' }) : cur?.open_price,
      close_price: b.closePrice !== undefined ? num(b.closePrice, { min: 0.0000001, name: 'Close price' }) : cur?.close_price ?? null,
      stop_loss: b.stopLoss !== undefined ? num(b.stopLoss, { min: 0, name: 'Stop loss' }) : cur?.stop_loss ?? null,
      take_profit: b.takeProfit !== undefined ? num(b.takeProfit, { min: 0, name: 'Take profit' }) : cur?.take_profit ?? null,
      commission: b.commission !== undefined ? num(b.commission, { name: 'Commission' }) ?? 0 : cur?.commission ?? 0,
      swap: b.swap !== undefined ? num(b.swap, { name: 'Swap' }) ?? 0 : cur?.swap ?? 0,
      profit: b.profit !== undefined ? num(b.profit, { name: 'Profit' }) : cur?.profit ?? null,
      risk_pct: b.riskPct !== undefined ? num(b.riskPct, { min: 0.01, max: 100, required: true, name: 'Risk %' }) : cur?.risk_pct ?? user.default_risk_pct,
      setup: b.setup !== undefined ? str(b.setup, { max: 120, name: 'Setup' }) : cur?.setup ?? null,
      plan_followed: b.planFollowed !== undefined ? bool01(b.planFollowed, 'Plan followed') : cur?.plan_followed ?? null,
      emotion: b.emotion !== undefined ? str(b.emotion, { max: 60, name: 'Emotion' }) : cur?.emotion ?? null,
      notes: b.notes !== undefined ? str(b.notes, { max: 10000, name: 'Notes' }) : cur?.notes ?? null,
      ticket: b.ticket !== undefined ? str(b.ticket, { max: 40, name: 'Ticket' }) : cur?.ticket ?? null,
    };
    if (!['buy', 'sell'].includes(t.direction)) throw bad('Direction must be buy or sell');
    if (!/^[A-Z0-9._#\-+]{2,20}$/.test(t.symbol || '')) throw bad('Symbol is invalid');
    if (t.close_time && t.close_time < t.open_time) throw bad('Close time cannot be before open time');
    if (t.close_time && (t.close_price === null || t.profit === null)) throw bad('A closed trade needs a close price and profit');
    if (!t.close_time && t.profit !== null && b.profit !== undefined) throw bad('Set a close time for a trade with a result');
    return t;
  };

  app.get('/api/trades', wrap((req, res) => {
    const m = mode(req.query.mode, req.user);
    const accountId = req.query.account ? num(req.query.account, { int: true, name: 'account' }) : null;
    if (accountId) { const a = ownAccount(req.user.id, accountId); if (!a || a.type !== m) throw notFound('Account not found in this mode'); }
    const tz = req.user.timezone;
    const from = req.query.from ? startOfLocalDay(ymd(req.query.from, 'from'), tz).toISOString() : null;
    const to = req.query.to ? startOfLocalDay(addDays(ymd(req.query.to, 'to'), 1), tz).toISOString() : null;
    let rows = tradesFor(db, req.user.id, { mode: m, accountId, from, to }).reverse();
    if (req.query.symbol) rows = rows.filter(t => t.symbol === String(req.query.symbol).toUpperCase());
    res.json({ mode: m, trades: rows.map(tradeView) });
  }));

  app.post('/api/trades', wrap((req, res) => {
    const acc = ownAccount(req.user.id, req.body.accountId);
    if (!acc) throw notFound('Account not found');
    const t = readTrade(req.body, null, req.user);
    const risk = req.body.riskAmount !== undefined && req.body.riskAmount !== null && req.body.riskAmount !== ''
      ? num(req.body.riskAmount, { min: 0, name: 'Risk amount' }) : riskAmountFor(acc, t.risk_pct, t.open_time);
    let id;
    try {
      id = db.prepare(`INSERT INTO trades(user_id,account_id,ticket,source,symbol,direction,volume,open_time,close_time,open_price,close_price,stop_loss,take_profit,commission,swap,profit,risk_pct,risk_amount,setup,plan_followed,emotion,notes)
                     VALUES(?,?,?,'manual',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(req.user.id, acc.id, t.ticket, t.symbol, t.direction, t.volume, t.open_time, t.close_time, t.open_price, t.close_price, t.stop_loss, t.take_profit, t.commission, t.swap, t.profit, t.risk_pct, risk, t.setup, t.plan_followed, t.emotion, t.notes).lastInsertRowid;
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) throw new HttpError(409, 'A trade with this ticket already exists in this account');
      throw e;
    }
    res.status(201).json({ trade: { ...tradeView(fullTrade(req.user.id, id)), screenshots: [] } });
  }));

  app.get('/api/trades/:id', wrap((req, res) => {
    const t = fullTrade(req.user.id, req.params.id);
    if (!t) throw notFound('Trade not found');
    res.json({ trade: { ...tradeView(t), screenshots: shotsFor(t.id) } });
  }));

  app.patch('/api/trades/:id', wrap((req, res) => {
    const cur = ownTrade(req.user.id, req.params.id);
    if (!cur) throw notFound('Trade not found');
    let accountId = cur.account_id;
    if (req.body.accountId !== undefined && Number(req.body.accountId) !== cur.account_id) {
      const a = ownAccount(req.user.id, req.body.accountId);
      if (!a) throw notFound('Account not found');
      const old = ownAccount(req.user.id, cur.account_id);
      if (a.type !== old.type) throw bad('Cannot move a trade between Demo and Live accounts');
      accountId = a.id;
    }
    const t = readTrade(req.body, cur, req.user);
    const acc = ownAccount(req.user.id, accountId);
    let risk = cur.risk_amount;
    if (req.body.riskAmount !== undefined) risk = num(req.body.riskAmount, { min: 0, name: 'Risk amount' });
    else if (req.body.riskPct !== undefined || req.body.openTime !== undefined) risk = riskAmountFor(acc, t.risk_pct, t.open_time, cur.id);
    // Editing any market data of an imported trade marks it as a manual correction.
    const marketFields = ['symbol', 'direction', 'volume', 'openTime', 'closeTime', 'openPrice', 'closePrice', 'stopLoss', 'takeProfit', 'commission', 'swap', 'profit'];
    const corrected = cur.corrected || (cur.source === 'mt5_csv' && marketFields.some(f => req.body[f] !== undefined)) ? 1 : 0;
    try {
      db.prepare(`UPDATE trades SET account_id=?, ticket=?, symbol=?, direction=?, volume=?, open_time=?, close_time=?, open_price=?, close_price=?, stop_loss=?, take_profit=?, commission=?, swap=?, profit=?, risk_pct=?, risk_amount=?, setup=?, plan_followed=?, emotion=?, notes=?, corrected=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND user_id=?`)
        .run(accountId, t.ticket, t.symbol, t.direction, t.volume, t.open_time, t.close_time, t.open_price, t.close_price, t.stop_loss, t.take_profit, t.commission, t.swap, t.profit, t.risk_pct, risk, t.setup, t.plan_followed, t.emotion, t.notes, corrected, cur.id, req.user.id);
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) throw new HttpError(409, 'A trade with this ticket already exists in this account');
      throw e;
    }
    res.json({ trade: { ...tradeView(fullTrade(req.user.id, cur.id)), screenshots: shotsFor(cur.id) } });
  }));

  app.delete('/api/trades/:id', wrap((req, res) => {
    const cur = ownTrade(req.user.id, req.params.id);
    if (!cur) throw notFound('Trade not found');
    const shots = db.prepare('SELECT file_name FROM trade_screenshots WHERE trade_id=?').all(cur.id);
    db.prepare('DELETE FROM trades WHERE id=? AND user_id=?').run(cur.id, req.user.id);
    for (const s of shots) fs.rm(path.join(uploadDir, s.file_name), { force: true }, () => {});
    res.json({ ok: true });
  }));

  // Screenshots: raw image body, content sniffed by magic bytes, stored outside the web root.
  app.post('/api/trades/:id/screenshots', express.raw({ type: () => true, limit: '6mb' }), wrap((req, res) => {
    const cur = ownTrade(req.user.id, req.params.id);
    if (!cur) throw notFound('Trade not found');
    const kind = req.query.kind;
    if (!['before', 'after'].includes(kind)) throw bad('kind must be before or after');
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || buf.length < 16) throw bad('No image received');
    if (buf.length > 5 * 1024 * 1024) throw bad('Image must be 5 MB or smaller');
    const sig = IMAGE_SIGS.find(s => s.test(buf));
    if (!sig) throw bad('Only PNG, JPEG, WebP or GIF images are accepted');
    if (db.prepare('SELECT COUNT(*) c FROM trade_screenshots WHERE trade_id=?').get(cur.id).c >= 10) throw bad('Maximum 10 screenshots per trade');
    const fileName = `${req.user.id}-${cur.id}-${crypto.randomBytes(12).toString('hex')}.${sig.ext}`;
    fs.writeFileSync(path.join(uploadDir, fileName), buf);
    const id = db.prepare('INSERT INTO trade_screenshots(trade_id,user_id,kind,file_name,mime,size) VALUES(?,?,?,?,?,?)').run(cur.id, req.user.id, kind, fileName, sig.mime, buf.length).lastInsertRowid;
    res.status(201).json({ screenshot: db.prepare('SELECT id, kind, mime, size, created_at FROM trade_screenshots WHERE id=?').get(id) });
  }));
  app.get('/api/screenshots/:id', wrap((req, res) => {
    const s = db.prepare('SELECT * FROM trade_screenshots WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
    if (!s) throw notFound('Screenshot not found');
    res.set({ 'Content-Type': s.mime, 'Cache-Control': 'private, max-age=3600', 'Content-Disposition': 'inline' });
    res.sendFile(path.join(uploadDir, s.file_name));
  }));
  app.delete('/api/screenshots/:id', wrap((req, res) => {
    const s = db.prepare('SELECT * FROM trade_screenshots WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
    if (!s) throw notFound('Screenshot not found');
    db.prepare('DELETE FROM trade_screenshots WHERE id=?').run(s.id);
    fs.rm(path.join(uploadDir, s.file_name), { force: true }, () => {});
    res.json({ ok: true });
  }));

  // ---- MT5 CSV import ---------------------------------------------------------
  const rawCsv = express.raw({ type: () => true, limit: '10mb' });
  const analyseImport = (req) => {
    const acc = ownAccount(req.user.id, req.query.account);
    if (!acc) throw notFound('Choose one of your accounts to import into');
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw bad('The file is empty');
    const parsed = parseMt5Csv(req.body, { serverOffsetMin: acc.server_utc_offset_min });
    if (!parsed.ok) throw bad(parsed.error);
    const exists = db.prepare('SELECT id FROM trades WHERE account_id=? AND ticket=?');
    for (const r of parsed.rows) {
      r.duplicate = !r.errors.length && r.trade.ticket ? !!exists.get(acc.id, r.trade.ticket) : false;
    }
    return { acc, parsed };
  };
  app.post('/api/imports/preview', rawCsv, wrap((req, res) => {
    const { acc, parsed } = analyseImport(req);
    const dup = parsed.rows.filter(r => r.duplicate).length;
    res.json({
      account: accountView(acc), format: parsed.format, delimiter: parsed.delimiter,
      summary: { ...parsed.summary, duplicates: dup, toImport: parsed.summary.valid - dup },
      rows: parsed.rows.slice(0, 1000),
    });
  }));
  app.post('/api/imports/commit', rawCsv, wrap((req, res) => {
    const { acc, parsed } = analyseImport(req);
    const fileName = (str(req.get('X-File-Name') ? decodeURIComponent(req.get('X-File-Name')) : 'import.csv', { max: 200, name: 'File name' }) || 'import.csv').replace(/[^\w.\- ]/g, '_');
    const toImport = parsed.rows.filter(r => !r.errors.length && !r.duplicate);
    if (!toImport.length) throw bad(parsed.summary.valid ? 'All valid rows were already imported into this account' : 'No valid rows to import');
    const result = tx(db, () => {
      const importId = Number(db.prepare('INSERT INTO imports(user_id,account_id,file_name,rows_total,rows_imported,rows_duplicate,rows_invalid) VALUES(?,?,?,?,?,?,?)')
        .run(req.user.id, acc.id, fileName, parsed.rows.length, 0, parsed.rows.filter(r => r.duplicate).length, parsed.summary.invalid).lastInsertRowid);
      const ins = db.prepare(`INSERT OR IGNORE INTO trades(user_id,account_id,ticket,source,import_id,symbol,direction,volume,open_time,close_time,open_price,close_price,stop_loss,take_profit,commission,swap,profit,risk_pct,risk_amount)
                              VALUES(?,?,?,'mt5_csv',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      let n = 0;
      // Insert in chronological order so each trade's risk amount uses the balance at its entry.
      for (const r of [...toImport].sort((a, b) => a.trade.open_time.localeCompare(b.trade.open_time))) {
        const t = r.trade;
        const risk = riskAmountFor(acc, req.user.default_risk_pct, t.open_time);
        n += ins.run(req.user.id, acc.id, t.ticket, importId, t.symbol, t.direction, t.volume, t.open_time, t.close_time, t.open_price, t.close_price, t.stop_loss, t.take_profit, t.commission, t.swap, t.profit, req.user.default_risk_pct, risk).changes;
      }
      db.prepare('UPDATE imports SET rows_imported=? WHERE id=?').run(n, importId);
      return { importId, imported: n };
    });
    res.status(201).json({ ...result, duplicates: parsed.rows.filter(r => r.duplicate).length, invalid: parsed.summary.invalid });
  }));
  app.get('/api/imports', (req, res) => {
    res.json({ imports: db.prepare(`SELECT i.*, a.name account_name, a.type account_type FROM imports i JOIN accounts a ON a.id=i.account_id WHERE i.user_id=? ORDER BY i.id DESC LIMIT 50`).all(req.user.id) });
  });

  // ---- stats & dashboard ------------------------------------------------------
  const rangeFromQuery = (q, tz) => ({
    from: q.from ? startOfLocalDay(ymd(q.from, 'from'), tz).toISOString() : null,
    to: q.to ? startOfLocalDay(addDays(ymd(q.to, 'to'), 1), tz).toISOString() : null,
  });
  app.get('/api/stats', wrap((req, res) => {
    const m = mode(req.query.mode, req.user);
    const { from, to } = rangeFromQuery(req.query, req.user.timezone);
    const accountId = req.query.account ? Number(req.query.account) : null;
    if (accountId) { const a = ownAccount(req.user.id, accountId); if (!a || a.type !== m) throw notFound('Account not found in this mode'); }
    res.json({ mode: m, stats: computeStats(tradesFor(db, req.user.id, { mode: m, from, to, accountId }), req.user.timezone) });
  }));

  app.get('/api/dashboard', wrap((req, res) => {
    const m = mode(req.query.mode, req.user);
    const tz = req.user.timezone;
    const n = now();
    const today = localDate(n, tz);
    const all = computeStats(tradesFor(db, req.user.id, { mode: m }), tz);
    const todayStats = computeStats(tradesFor(db, req.user.id, { mode: m, from: startOfLocalDay(today, tz).toISOString(), to: startOfLocalDay(addDays(today, 1), tz).toISOString() }), tz);
    const ws = weekStart(today);
    const weekStats = computeStats(tradesFor(db, req.user.id, { mode: m, from: startOfLocalDay(ws, tz).toISOString(), to: startOfLocalDay(addDays(ws, 7), tz).toISOString() }), tz);
    const accounts = db.prepare('SELECT * FROM accounts WHERE user_id=? AND type=?').all(req.user.id, m);
    const startBal = accounts.reduce((a, x) => a + x.starting_balance, 0);
    const plan = db.prepare('SELECT * FROM daily_plans WHERE user_id=? AND plan_date=?').get(req.user.id, today);
    const items = db.prepare('SELECT COUNT(*) c FROM checklist_items WHERE user_id=? AND active=1').get(req.user.id).c;
    const checked = db.prepare('SELECT COUNT(*) c FROM checklist_checks cc JOIN checklist_items ci ON ci.id=cc.item_id WHERE cc.user_id=? AND cc.check_date=? AND cc.checked=1 AND ci.active=1').get(req.user.id, today).c;
    const prefs = getPrefs(db, req.user.id);
    const upcoming = queryEvents(db, { from: n.toISOString(), to: new Date(n.getTime() + 48 * 3600e3).toISOString(), impacts: prefImpacts(prefs).length ? prefImpacts(prefs) : ['high', 'medium'], currencies: prefCurrencies(prefs) })
      .slice(0, 6).map(e => presentEvent(e, tz, n));
    const disc = disciplineRange(db, req.user, addDays(today, -13), today, m);
    const recent = tradesFor(db, req.user.id, { mode: m }).reverse().slice(0, 5).map(tradeView);
    res.json({
      mode: m, today, timezone: tz,
      balance: { starting: startBal, current: Math.round((startBal + (all.netPnl || 0)) * 100) / 100, accounts: accounts.length },
      stats: all, todayStats, weekStats,
      plan: { exists: !!plan, reviewed: !!plan?.reviewed_at, checklistDone: checked, checklistTotal: items, maxTrades: plan?.max_trades ?? null },
      upcomingNews: upcoming, calendar: calendarStatus(db, n),
      discipline: { today: disc.days[disc.days.length - 1], average: disc.average, streak: disc.disciplinedStreak, series: disc.days.map(d => ({ date: d.date, score: d.score })) },
      recentTrades: recent,
    });
  }));

  // ---- planner ----------------------------------------------------------------
  const planView = p => p && ({
    date: p.plan_date, marketBias: p.market_bias, keyLevels: p.key_levels, pairsToWatch: p.pairs_to_watch, newsToWatch: p.news_to_watch,
    goals: p.goals, maxTrades: p.max_trades, maxDailyLossPct: p.max_daily_loss_pct, mentalState: p.mental_state,
    review: { followedPlan: p.review_followed_plan === null ? null : !!p.review_followed_plan, wentWell: p.review_went_well, mistakes: p.review_mistakes, lessons: p.review_lessons, rating: p.review_rating, reviewedAt: p.reviewed_at },
    updatedAt: p.updated_at,
  });
  const checklistFor = (userId, date) => db.prepare(`SELECT ci.id, ci.label, ci.position, COALESCE(cc.checked,0) checked FROM checklist_items ci
      LEFT JOIN checklist_checks cc ON cc.item_id=ci.id AND cc.check_date=? WHERE ci.user_id=? AND ci.active=1 ORDER BY ci.position, ci.id`).all(date, userId)
    .map(r => ({ ...r, checked: !!r.checked }));
  const rulesFor = (userId, date) => db.prepare(`SELECT r.id, r.rule, r.category, ra.followed FROM trading_rules r
      LEFT JOIN rule_adherence ra ON ra.rule_id=r.id AND ra.review_date=? WHERE r.user_id=? AND r.active=1 ORDER BY r.position, r.id`).all(date, userId)
    .map(r => ({ ...r, followed: r.followed === null ? null : !!r.followed }));

  app.get('/api/plans', wrap((req, res) => {
    const from = ymd(req.query.from, 'from'), to = ymd(req.query.to, 'to');
    res.json({ plans: db.prepare('SELECT * FROM daily_plans WHERE user_id=? AND plan_date BETWEEN ? AND ? ORDER BY plan_date DESC').all(req.user.id, from, to).map(planView) });
  }));
  app.get('/api/plans/:date', wrap((req, res) => {
    const d = ymd(req.params.date);
    const p = db.prepare('SELECT * FROM daily_plans WHERE user_id=? AND plan_date=?').get(req.user.id, d);
    res.json({ plan: planView(p) || null, checklist: checklistFor(req.user.id, d), rules: rulesFor(req.user.id, d) });
  }));
  app.put('/api/plans/:date', wrap((req, res) => {
    const d = ymd(req.params.date);
    const b = req.body;
    const cur = db.prepare('SELECT * FROM daily_plans WHERE user_id=? AND plan_date=?').get(req.user.id, d) || {};
    const pick = (k, col, fn) => (b[k] !== undefined ? fn(b[k]) : cur[col] ?? null);
    const v = {
      market_bias: pick('marketBias', 'market_bias', x => str(x, { max: 2000, name: 'Market bias' })),
      key_levels: pick('keyLevels', 'key_levels', x => str(x, { max: 4000, name: 'Key levels' })),
      pairs_to_watch: pick('pairsToWatch', 'pairs_to_watch', x => str(x, { max: 500, name: 'Pairs to watch' })),
      news_to_watch: pick('newsToWatch', 'news_to_watch', x => str(x, { max: 2000, name: 'News to watch' })),
      goals: pick('goals', 'goals', x => str(x, { max: 2000, name: 'Goals' })),
      max_trades: pick('maxTrades', 'max_trades', x => num(x, { min: 0, max: 100, int: true, name: 'Max trades' })),
      max_daily_loss_pct: pick('maxDailyLossPct', 'max_daily_loss_pct', x => num(x, { min: 0, max: 100, name: 'Max daily loss %' })),
      mental_state: pick('mentalState', 'mental_state', x => num(x, { min: 1, max: 5, int: true, name: 'Mental state' })),
    };
    const r = b.review || {};
    const rv = {
      review_followed_plan: r.followedPlan !== undefined ? bool01(r.followedPlan, 'Followed plan') : cur.review_followed_plan ?? null,
      review_went_well: r.wentWell !== undefined ? str(r.wentWell, { max: 4000, name: 'What went well' }) : cur.review_went_well ?? null,
      review_mistakes: r.mistakes !== undefined ? str(r.mistakes, { max: 4000, name: 'Mistakes' }) : cur.review_mistakes ?? null,
      review_lessons: r.lessons !== undefined ? str(r.lessons, { max: 4000, name: 'Lessons' }) : cur.review_lessons ?? null,
      review_rating: r.rating !== undefined ? num(r.rating, { min: 1, max: 5, int: true, name: 'Rating' }) : cur.review_rating ?? null,
    };
    const reviewedAt = b.review && (r.complete === true) ? new Date().toISOString() : (cur.reviewed_at ?? null);
    tx(db, () => {
      db.prepare(`INSERT INTO daily_plans(user_id,plan_date,market_bias,key_levels,pairs_to_watch,news_to_watch,goals,max_trades,max_daily_loss_pct,mental_state,review_followed_plan,review_went_well,review_mistakes,review_lessons,review_rating,reviewed_at)
                  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                  ON CONFLICT(user_id,plan_date) DO UPDATE SET market_bias=excluded.market_bias, key_levels=excluded.key_levels, pairs_to_watch=excluded.pairs_to_watch,
                    news_to_watch=excluded.news_to_watch, goals=excluded.goals, max_trades=excluded.max_trades, max_daily_loss_pct=excluded.max_daily_loss_pct,
                    mental_state=excluded.mental_state, review_followed_plan=excluded.review_followed_plan, review_went_well=excluded.review_went_well,
                    review_mistakes=excluded.review_mistakes, review_lessons=excluded.review_lessons, review_rating=excluded.review_rating,
                    reviewed_at=excluded.reviewed_at, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
        .run(req.user.id, d, v.market_bias, v.key_levels, v.pairs_to_watch, v.news_to_watch, v.goals, v.max_trades, v.max_daily_loss_pct, v.mental_state,
          rv.review_followed_plan, rv.review_went_well, rv.review_mistakes, rv.review_lessons, rv.review_rating, reviewedAt);
      if (b.review?.rules && typeof b.review.rules === 'object') {
        for (const [ruleId, followed] of Object.entries(b.review.rules)) {
          const rule = db.prepare('SELECT id FROM trading_rules WHERE id=? AND user_id=?').get(ruleId, req.user.id);
          if (!rule) throw bad('Unknown rule');
          if (followed === null) db.prepare('DELETE FROM rule_adherence WHERE rule_id=? AND review_date=?').run(rule.id, d);
          else db.prepare('INSERT INTO rule_adherence(user_id,rule_id,review_date,followed) VALUES(?,?,?,?) ON CONFLICT(rule_id,review_date) DO UPDATE SET followed=excluded.followed').run(req.user.id, rule.id, d, bool01(followed, 'followed'));
        }
      }
    });
    const p = db.prepare('SELECT * FROM daily_plans WHERE user_id=? AND plan_date=?').get(req.user.id, d);
    res.json({ plan: planView(p), checklist: checklistFor(req.user.id, d), rules: rulesFor(req.user.id, d) });
  }));
  app.delete('/api/plans/:date', wrap((req, res) => {
    db.prepare('DELETE FROM daily_plans WHERE user_id=? AND plan_date=?').run(req.user.id, ymd(req.params.date));
    res.json({ ok: true });
  }));

  app.put('/api/checklist/:date/:itemId', wrap((req, res) => {
    const d = ymd(req.params.date);
    const item = db.prepare('SELECT id FROM checklist_items WHERE id=? AND user_id=?').get(req.params.itemId, req.user.id);
    if (!item) throw notFound('Checklist item not found');
    const c = bool01(req.body.checked, 'checked') ?? 0;
    db.prepare('INSERT INTO checklist_checks(user_id,item_id,check_date,checked) VALUES(?,?,?,?) ON CONFLICT(item_id,check_date) DO UPDATE SET checked=excluded.checked').run(req.user.id, item.id, d, c);
    res.json({ checklist: checklistFor(req.user.id, d) });
  }));
  app.get('/api/checklist/items', (req, res) => res.json({ items: db.prepare('SELECT id,label,position FROM checklist_items WHERE user_id=? AND active=1 ORDER BY position,id').all(req.user.id) }));
  app.post('/api/checklist/items', wrap((req, res) => {
    const label = str(req.body.label, { required: true, max: 200, name: 'Checklist item' });
    const pos = db.prepare('SELECT COALESCE(MAX(position),0)+1 p FROM checklist_items WHERE user_id=?').get(req.user.id).p;
    const id = db.prepare('INSERT INTO checklist_items(user_id,label,position) VALUES(?,?,?)').run(req.user.id, label, pos).lastInsertRowid;
    res.status(201).json({ item: db.prepare('SELECT id,label,position FROM checklist_items WHERE id=?').get(id) });
  }));
  app.patch('/api/checklist/items/:id', wrap((req, res) => {
    const it = db.prepare('SELECT * FROM checklist_items WHERE id=? AND user_id=? AND active=1').get(req.params.id, req.user.id);
    if (!it) throw notFound('Checklist item not found');
    const label = req.body.label !== undefined ? str(req.body.label, { required: true, max: 200, name: 'Checklist item' }) : it.label;
    const pos = req.body.position !== undefined ? num(req.body.position, { int: true, min: 0, max: 10000, name: 'position' }) : it.position;
    db.prepare('UPDATE checklist_items SET label=?, position=? WHERE id=?').run(label, pos, it.id);
    res.json({ item: { id: it.id, label, position: pos } });
  }));
  // Soft-delete keeps historical checklist completion intact.
  app.delete('/api/checklist/items/:id', wrap((req, res) => {
    const r = db.prepare('UPDATE checklist_items SET active=0 WHERE id=? AND user_id=?').run(req.params.id, req.user.id);
    if (!r.changes) throw notFound('Checklist item not found');
    res.json({ ok: true });
  }));

  app.get('/api/rules', (req, res) => res.json({ rules: db.prepare('SELECT id,rule,category,position FROM trading_rules WHERE user_id=? AND active=1 ORDER BY position,id').all(req.user.id) }));
  app.post('/api/rules', wrap((req, res) => {
    const rule = str(req.body.rule, { required: true, max: 300, name: 'Rule' });
    const cat = str(req.body.category, { max: 40, name: 'Category' }) || 'general';
    const pos = db.prepare('SELECT COALESCE(MAX(position),0)+1 p FROM trading_rules WHERE user_id=?').get(req.user.id).p;
    const id = db.prepare('INSERT INTO trading_rules(user_id,rule,category,position) VALUES(?,?,?,?)').run(req.user.id, rule, cat, pos).lastInsertRowid;
    res.status(201).json({ rule: db.prepare('SELECT id,rule,category,position FROM trading_rules WHERE id=?').get(id) });
  }));
  app.patch('/api/rules/:id', wrap((req, res) => {
    const r = db.prepare('SELECT * FROM trading_rules WHERE id=? AND user_id=? AND active=1').get(req.params.id, req.user.id);
    if (!r) throw notFound('Rule not found');
    const rule = req.body.rule !== undefined ? str(req.body.rule, { required: true, max: 300, name: 'Rule' }) : r.rule;
    const cat = req.body.category !== undefined ? (str(req.body.category, { max: 40, name: 'Category' }) || 'general') : r.category;
    db.prepare('UPDATE trading_rules SET rule=?, category=? WHERE id=?').run(rule, cat, r.id);
    res.json({ rule: { id: r.id, rule, category: cat, position: r.position } });
  }));
  app.delete('/api/rules/:id', wrap((req, res) => {
    const r = db.prepare('UPDATE trading_rules SET active=0 WHERE id=? AND user_id=?').run(req.params.id, req.user.id);
    if (!r.changes) throw notFound('Rule not found');
    res.json({ ok: true });
  }));

  const weeklyView = w => w && ({ weekStart: w.week_start, whatWorked: w.what_worked, whatDidnt: w.what_didnt, improvements: w.improvements, focusNextWeek: w.focus_next_week, rating: w.rating, updatedAt: w.updated_at });
  app.get('/api/weekly/:weekStart', wrap((req, res) => {
    const ws = ymd(req.params.weekStart, 'week start');
    if (weekStart(ws) !== ws) throw bad('Week start must be a Monday');
    res.json({ review: weeklyView(db.prepare('SELECT * FROM weekly_reviews WHERE user_id=? AND week_start=?').get(req.user.id, ws)) || null });
  }));
  app.put('/api/weekly/:weekStart', wrap((req, res) => {
    const ws = ymd(req.params.weekStart, 'week start');
    if (weekStart(ws) !== ws) throw bad('Week start must be a Monday');
    const b = req.body;
    const vals = [str(b.whatWorked, { max: 4000, name: 'What worked' }), str(b.whatDidnt, { max: 4000, name: "What didn't" }), str(b.improvements, { max: 4000, name: 'Improvements' }),
      str(b.focusNextWeek, { max: 4000, name: 'Focus' }), num(b.rating, { min: 1, max: 5, int: true, name: 'Rating' })];
    db.prepare(`INSERT INTO weekly_reviews(user_id,week_start,what_worked,what_didnt,improvements,focus_next_week,rating) VALUES(?,?,?,?,?,?,?)
                ON CONFLICT(user_id,week_start) DO UPDATE SET what_worked=excluded.what_worked, what_didnt=excluded.what_didnt, improvements=excluded.improvements,
                focus_next_week=excluded.focus_next_week, rating=excluded.rating, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`).run(req.user.id, ws, ...vals);
    res.json({ review: weeklyView(db.prepare('SELECT * FROM weekly_reviews WHERE user_id=? AND week_start=?').get(req.user.id, ws)) });
  }));

  // ---- discipline & reports -----------------------------------------------------
  app.get('/api/discipline', wrap((req, res) => {
    const m = mode(req.query.mode, req.user);
    const today = localDate(now(), req.user.timezone);
    const to = req.query.to ? ymd(req.query.to, 'to') : today;
    const from = req.query.from ? ymd(req.query.from, 'from') : addDays(to, -29);
    if (from > to || addDays(from, 366) < to) throw bad('Invalid range (max 1 year)');
    res.json({ mode: m, ...disciplineRange(db, req.user, from, to, m) });
  }));

  app.get('/api/reports/daily/:date', wrap((req, res) => {
    const m = mode(req.query.mode, req.user);
    const d = ymd(req.params.date);
    const tz = req.user.timezone;
    const trades = tradesFor(db, req.user.id, { mode: m, from: startOfLocalDay(d, tz).toISOString(), to: startOfLocalDay(addDays(d, 1), tz).toISOString() });
    const p = db.prepare('SELECT * FROM daily_plans WHERE user_id=? AND plan_date=?').get(req.user.id, d);
    const events = queryEvents(db, { from: startOfLocalDay(d, tz).toISOString(), to: startOfLocalDay(addDays(d, 1), tz).toISOString(), impacts: ['high', 'medium'] }).map(e => presentEvent(e, tz, now()));
    res.json({
      mode: m, date: d, timezone: tz, stats: computeStats(trades, tz), trades: trades.map(tradeView),
      plan: planView(p) || null, checklist: checklistFor(req.user.id, d), rules: rulesFor(req.user.id, d),
      discipline: disciplineForDay(db, req.user, d, m), news: events,
    });
  }));

  app.get('/api/reports/weekly/:weekStart', wrap((req, res) => {
    const m = mode(req.query.mode, req.user);
    const ws = ymd(req.params.weekStart, 'week start');
    if (weekStart(ws) !== ws) throw bad('Week start must be a Monday');
    const tz = req.user.timezone;
    const trades = tradesFor(db, req.user.id, { mode: m, from: startOfLocalDay(ws, tz).toISOString(), to: startOfLocalDay(addDays(ws, 7), tz).toISOString() });
    const prev = tradesFor(db, req.user.id, { mode: m, from: startOfLocalDay(addDays(ws, -7), tz).toISOString(), to: startOfLocalDay(ws, tz).toISOString() });
    const disc = disciplineRange(db, req.user, ws, addDays(ws, 6), m);
    const days = [];
    const st = computeStats(trades, tz);
    for (let i = 0; i < 7; i++) {
      const d = addDays(ws, i);
      const bd = st.byDay.find(x => x.date === d);
      days.push({ date: d, trades: bd?.trades || 0, net: bd?.net || 0, discipline: disc.days[i].score, planned: !!db.prepare('SELECT 1 FROM daily_plans WHERE user_id=? AND plan_date=?').get(req.user.id, d) });
    }
    res.json({
      mode: m, weekStart: ws, weekEnd: addDays(ws, 6), timezone: tz, stats: st, previousWeek: { netPnl: computeStats(prev, tz).netPnl, trades: prev.filter(t => t.close_time).length },
      days, discipline: { average: disc.average, scoredDays: disc.scoredDays },
      review: weeklyView(db.prepare('SELECT * FROM weekly_reviews WHERE user_id=? AND week_start=?').get(req.user.id, ws)) || null,
      trades: trades.map(tradeView),
    });
  }));

  // ---- economic calendar ---------------------------------------------------------
  const IMPACT_SET = ['high', 'medium', 'low', 'holiday'];
  app.get('/api/calendar', wrap((req, res) => {
    const tz = req.user.timezone || DEFAULT_TZ;
    const n = now();
    const fromD = req.query.from ? ymd(req.query.from, 'from') : localDate(n, tz);
    const toD = req.query.to ? ymd(req.query.to, 'to') : addDays(fromD, 6);
    if (toD < fromD || addDays(fromD, 31) < toD) throw bad('Invalid range (max 31 days)');
    const impacts = req.query.impacts !== undefined ? String(req.query.impacts).split(',').filter(Boolean) : ['high', 'medium'];
    if (impacts.some(i => !IMPACT_SET.includes(i))) throw bad('Unknown impact level');
    const currencies = req.query.currencies !== undefined ? String(req.query.currencies).split(',').filter(Boolean).map(s => s.toUpperCase()) : null;
    if (currencies && currencies.some(c => !/^[A-Z]{3}$/.test(c))) throw bad('Invalid currency code');
    const events = impacts.length && (!currencies || currencies.length)
      ? queryEvents(db, { from: startOfLocalDay(fromD, tz).toISOString(), to: startOfLocalDay(addDays(toD, 1), tz).toISOString(), impacts, currencies })
      : [];
    res.json({ timezone: tz, from: fromD, to: toD, status: calendarStatus(db, n), events: events.map(e => presentEvent(e, tz, n)) });
  }));
  app.get('/api/calendar/status', (req, res) => res.json(calendarStatus(db, now())));
  // Manual refresh, throttled globally so users cannot exhaust the provider's rate limit.
  app.post('/api/calendar/refresh', wrap(async (req, res) => {
    const last = db.prepare('SELECT started_at FROM calendar_fetches ORDER BY id DESC LIMIT 1').get();
    const st = calendarStatus(db, now());
    const tooSoon = last && now().getTime() - Date.parse(last.started_at) < 5 * 60 * 1000;
    const backoff = st.nextSyncAt && Date.parse(st.nextSyncAt) > now().getTime() && !st.lastAttemptOk;
    if (tooSoon || backoff) return res.status(429).json({ error: 'The calendar was refreshed recently. Next automatic update: ' + (st.nextSyncAt || 'soon'), status: st });
    await syncCalendar(db, { fetchImpl, now: now() });
    res.json({ status: calendarStatus(db, now()) });
  }));

  // ---- web push -------------------------------------------------------------------
  app.get('/api/push/vapid-public-key', (_req, res) => res.json({ publicKey: vapid.publicKey }));
  app.post('/api/push/subscribe', wrap((req, res) => {
    const s = req.body.subscription;
    if (!isValidSubscription(s)) throw bad('Invalid push subscription');
    const ua = String(req.get('User-Agent') || '').slice(0, 300);
    // A browser endpoint belongs to whoever is signed in on that browser now.
    db.prepare(`INSERT INTO push_subscriptions(user_id,endpoint,p256dh,auth,user_agent) VALUES(?,?,?,?,?)
                ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, p256dh=excluded.p256dh, auth=excluded.auth, user_agent=excluded.user_agent,
                active=1, failure_count=0, last_error=NULL`).run(req.user.id, s.endpoint, s.keys.p256dh, s.keys.auth, ua);
    db.prepare('INSERT OR IGNORE INTO notification_prefs(user_id) VALUES(?)').run(req.user.id);
    const row = db.prepare('SELECT id, created_at FROM push_subscriptions WHERE endpoint=?').get(s.endpoint);
    res.status(201).json({ subscription: row });
  }));
  app.post('/api/push/unsubscribe', wrap((req, res) => {
    const endpoint = str(req.body.endpoint, { required: true, max: 2000, name: 'endpoint' });
    const r = db.prepare('DELETE FROM push_subscriptions WHERE endpoint=? AND user_id=?').run(endpoint, req.user.id);
    res.json({ ok: true, removed: r.changes });
  }));
  app.get('/api/push/subscriptions', (req, res) => {
    res.json({ subscriptions: db.prepare('SELECT id, user_agent, active, failure_count, last_success_at, last_failure_at, last_error, created_at, substr(endpoint,1,60) endpoint_preview FROM push_subscriptions WHERE user_id=? ORDER BY id DESC').all(req.user.id) });
  });
  app.delete('/api/push/subscriptions/:id', wrap((req, res) => {
    const r = db.prepare('DELETE FROM push_subscriptions WHERE id=? AND user_id=?').run(req.params.id, req.user.id);
    if (!r.changes) throw notFound('Subscription not found');
    res.json({ ok: true });
  }));

  const prefsView = p => ({
    enabled: !!p.enabled, impacts: { high: !!p.impact_high, medium: !!p.impact_medium, low: !!p.impact_low },
    alerts: { t30: !!p.alert_30, t15: !!p.alert_15, release: !!p.alert_release }, dailyBriefing: !!p.daily_briefing,
    briefingTime: p.briefing_time, currencies: prefCurrencies(p), availableCurrencies: SUPPORTED_CURRENCIES,
  });
  app.get('/api/notifications/prefs', (req, res) => res.json({ prefs: prefsView(getPrefs(db, req.user.id)) }));
  app.put('/api/notifications/prefs', wrap((req, res) => {
    const cur = getPrefs(db, req.user.id);
    const b = req.body;
    const flag = (v, c) => (v === undefined ? c : bool01(v, 'preference'));
    const p = {
      enabled: flag(b.enabled, cur.enabled),
      impact_high: flag(b.impacts?.high, cur.impact_high), impact_medium: flag(b.impacts?.medium, cur.impact_medium), impact_low: flag(b.impacts?.low, cur.impact_low),
      alert_30: flag(b.alerts?.t30, cur.alert_30), alert_15: flag(b.alerts?.t15, cur.alert_15), alert_release: flag(b.alerts?.release, cur.alert_release),
      daily_briefing: flag(b.dailyBriefing, cur.daily_briefing),
      briefing_time: b.briefingTime !== undefined ? (/^([01]\d|2[0-3]):[0-5]\d$/.test(b.briefingTime) ? b.briefingTime : (() => { throw bad('Briefing time must be HH:MM'); })()) : cur.briefing_time,
      currencies: b.currencies !== undefined ? (() => {
        if (!Array.isArray(b.currencies) || b.currencies.some(c => !SUPPORTED_CURRENCIES.includes(c))) throw bad('Unsupported currency');
        return [...new Set(b.currencies)].join(',');
      })() : cur.currencies,
    };
    db.prepare(`INSERT INTO notification_prefs(user_id,enabled,impact_high,impact_medium,impact_low,alert_30,alert_15,alert_release,daily_briefing,briefing_time,currencies)
                VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET enabled=excluded.enabled, impact_high=excluded.impact_high, impact_medium=excluded.impact_medium,
                impact_low=excluded.impact_low, alert_30=excluded.alert_30, alert_15=excluded.alert_15, alert_release=excluded.alert_release, daily_briefing=excluded.daily_briefing,
                briefing_time=excluded.briefing_time, currencies=excluded.currencies`)
      .run(req.user.id, p.enabled, p.impact_high, p.impact_medium, p.impact_low, p.alert_30, p.alert_15, p.alert_release, p.daily_briefing, p.briefing_time, p.currencies);
    res.json({ prefs: prefsView(getPrefs(db, req.user.id)) });
  }));
  app.get('/api/notifications/history', (req, res) => {
    res.json({ notifications: db.prepare(`SELECT n.id, n.kind, n.title, n.body, n.due_at, n.status, n.attempts, n.last_error, n.sent_at, n.created_at
      FROM notifications n WHERE n.user_id=? ORDER BY n.id DESC LIMIT 100`).all(req.user.id) });
  });
  app.post('/api/notifications/test', wrap(async (req, res) => {
    const subs = db.prepare('SELECT COUNT(*) c FROM push_subscriptions WHERE user_id=? AND active=1').get(req.user.id).c;
    if (!subs) throw bad('No active device subscription. Enable notifications on this device first.');
    const r = await sendTestNotification(db, req.user.id, sender, now());
    res.json(r);
  }));

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

  // ---- static client (built SPA) --------------------------------------------------
  if (publicDir && fs.existsSync(publicDir)) {
    app.get('/sw.js', (_req, res) => { res.set({ 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/' }); res.sendFile(path.join(publicDir, 'sw.js')); });
    app.use(express.static(publicDir, { index: false, maxAge: '1h', setHeaders: (res, p) => { if (p.includes(`${path.sep}assets${path.sep}`)) res.set('Cache-Control', 'public, max-age=31536000, immutable'); } }));
    app.get('*', (_req, res) => { res.set('Cache-Control', 'no-cache'); res.sendFile(path.join(publicDir, 'index.html')); });
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Upload is too large' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Internal server error' : err.message });
  });
  return app;
}
