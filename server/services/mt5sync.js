// MT5 auto-sync: closed positions pushed by the TradeOS Expert Advisor.
// Authentication is a per-account sync key (Bearer). The key decides the
// target account, so the EA can never choose which account it writes to.
import crypto from 'node:crypto';

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const MAX_POSITIONS_PER_REQUEST = 500;

export function newSyncToken() {
  const token = `tos_${crypto.randomBytes(24).toString('base64url')}`;
  return { token, hash: sha256(token), hint: token.slice(-4) };
}

export async function findToken(db, header) {
  const m = /^Bearer\s+(tos_[A-Za-z0-9_-]{20,60})\s*$/.exec(header || '');
  if (!m) return null;
  // account_id NULL = "Connect MT5" key: accounts are created/matched from the terminal's login.
  const t = await db.get(`SELECT st.*, a.type AS account_type, a.name AS account_name, a.starting_balance
                          FROM sync_tokens st LEFT JOIN accounts a ON a.id = st.account_id AND a.user_id = st.user_id
                          WHERE st.token_hash = ? AND st.revoked = 0`, sha256(m[1]));
  if (t && t.account_id && !t.account_type) return null; // account deleted
  return t || null;
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Validate the EA payload. Times arrive as Unix seconds in broker *server* time
 * (MQL5 datetime) together with the terminal's measured server→GMT offset.
 */
export function validatePayload(body, { now = Date.now() } = {}) {
  if (!body || typeof body !== 'object') return { error: 'Invalid JSON body' };
  const acct = body.account || {};
  const offsetSec = Number(acct.server_gmt_offset_sec);
  if (!Number.isFinite(offsetSec) || Math.abs(offsetSec) > 14 * 3600) return { error: 'account.server_gmt_offset_sec is missing or invalid' };
  // Round to 15 minutes: TimeTradeServer() - TimeGMT() can be off by a few seconds.
  const offsetMs = Math.round(offsetSec / 900) * 900 * 1000;
  const tradeMode = ['demo', 'real', 'contest'].includes(acct.trade_mode) ? acct.trade_mode : null;
  if (!Array.isArray(body.positions)) return { error: 'positions must be an array' };
  if (body.positions.length > MAX_POSITIONS_PER_REQUEST) return { error: `Send at most ${MAX_POSITIONS_PER_REQUEST} positions per request` };
  const toIso = (sec) => (isNum(sec) && sec > 946684800 ? new Date(sec * 1000 - offsetMs).toISOString() : null);
  const valid = [], invalid = [];
  for (const p of body.positions) {
    const errors = [];
    const ticket = p && (typeof p.ticket === 'string' || isNum(p.ticket)) ? String(p.ticket).trim() : '';
    if (!/^\d{1,20}$/.test(ticket)) errors.push('ticket');
    const symbol = typeof p?.symbol === 'string' ? p.symbol.trim().toUpperCase() : '';
    if (!/^[A-Z0-9._#\-+]{2,20}$/.test(symbol)) errors.push('symbol');
    if (!['buy', 'sell'].includes(p?.type)) errors.push('type');
    if (!isNum(p?.volume) || p.volume <= 0) errors.push('volume');
    if (!isNum(p?.open_price) || p.open_price <= 0) errors.push('open_price');
    if (!isNum(p?.close_price) || p.close_price <= 0) errors.push('close_price');
    for (const f of ['commission', 'swap', 'profit']) if (!isNum(p?.[f])) errors.push(f);
    const open_time = toIso(p?.open_time), close_time = toIso(p?.close_time);
    if (!open_time) errors.push('open_time');
    if (!close_time) errors.push('close_time');
    if (open_time && close_time && close_time < open_time) errors.push('close_time before open_time');
    if (close_time && Date.parse(close_time) > now + 36 * 3600e3) errors.push('close_time in the future');
    if (errors.length) { invalid.push({ ticket: ticket || null, errors }); continue; }
    valid.push({
      ticket, symbol, direction: p.type, volume: p.volume, open_time, close_time,
      open_price: p.open_price, close_price: p.close_price,
      stop_loss: isNum(p.sl) && p.sl > 0 ? p.sl : null, take_profit: isNum(p.tp) && p.tp > 0 ? p.tp : null,
      commission: p.commission, swap: p.swap, profit: p.profit,
    });
  }
  const login = acct.login !== undefined && /^\d{1,20}$/.test(String(acct.login)) ? String(acct.login) : null;
  const server = typeof acct.server === 'string' && acct.server.trim() ? acct.server.trim().slice(0, 80) : null;
  const company = typeof acct.company === 'string' && acct.company.trim() ? acct.company.trim().slice(0, 80) : null;
  const currency = typeof acct.currency === 'string' && /^[A-Z]{3}$/.test(acct.currency.trim().toUpperCase()) ? acct.currency.trim().toUpperCase() : 'USD';
  const balance = isNum(acct.balance) && Math.abs(acct.balance) < 1e12 ? acct.balance : null;
  return { valid, invalid, tradeMode, login, server, company, currency, balance, offsetMs };
}
