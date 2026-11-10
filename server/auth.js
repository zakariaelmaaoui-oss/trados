import crypto from 'node:crypto';

const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
export const COOKIE = 'tradeos_session';

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function verifyPassword(pw, stored) {
  const [alg, saltB64, keyB64] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const key = Buffer.from(keyB64, 'base64');
  const test = crypto.scryptSync(pw, Buffer.from(saltB64, 'base64'), key.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(key, test);
}

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

export function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)')
    .run(sha256(token), userId, now + SESSION_TTL_MS, now);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
  return { token, maxAge: SESSION_TTL_MS };
}

export function destroySession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionCookie(token, maxAgeMs, secure) {
  return [
    `${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`, secure ? 'Secure' : '',
  ].filter(Boolean).join('; ');
}

/** Attaches req.user when a valid session cookie is present. */
export function loadUser(db) {
  const q = db.prepare(`SELECT u.id, u.email, u.display_name, u.default_risk_pct, u.timezone, u.active_mode
                        FROM sessions s JOIN users u ON u.id = s.user_id
                        WHERE s.token_hash = ? AND s.expires_at > ?`);
  return (req, _res, next) => {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    req.sessionToken = token;
    req.user = token ? q.get(sha256(token), Date.now()) || null : null;
    next();
  };
}

export function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  next();
}

/**
 * CSRF guard for state-changing requests: SameSite=Lax cookies plus a required
 * custom header that cross-site forms cannot set without a CORS preflight.
 */
export function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('X-TradeOS-Request') !== '1') return res.status(403).json({ error: 'Missing request header' });
  next();
}

/** Tiny fixed-window rate limiter keyed by IP + route (for login/register). */
export function rateLimit({ windowMs, max }) {
  const hits = new Map();
  return (req, res, next) => {
    const key = `${req.ip}:${req.path}`;
    const now = Date.now();
    const h = hits.get(key);
    if (!h || h.reset < now) hits.set(key, { n: 1, reset: now + windowMs });
    else if (++h.n > max) return res.status(429).json({ error: 'Too many attempts, try again later' });
    next();
  };
}
