// Performance statistics and discipline scoring, always computed from stored records.
import { localDate, startOfLocalDay, addDays } from '../lib/time.js';

export const net = t => (t.profit ?? 0) + (t.commission ?? 0) + (t.swap ?? 0);

/** Trades for a user in one mode (demo|live). Demo and Live are never mixed. */
export function tradesFor(db, userId, { mode, accountId, from, to, closedOnly = false } = {}) {
  if (mode !== 'demo' && mode !== 'live') throw new Error('mode must be demo or live');
  const where = ['t.user_id = ?', 'a.type = ?'];
  const args = [userId, mode];
  if (accountId) { where.push('t.account_id = ?'); args.push(accountId); }
  if (from) { where.push('COALESCE(t.close_time, t.open_time) >= ?'); args.push(from); }
  if (to) { where.push('COALESCE(t.close_time, t.open_time) < ?'); args.push(to); }
  if (closedOnly) where.push('t.close_time IS NOT NULL');
  return db.all(`SELECT t.*, a.name AS account_name, a.type AS account_type, a.currency AS account_currency
                 FROM trades t JOIN accounts a ON a.id = t.account_id AND a.user_id = t.user_id
                 WHERE ${where.join(' AND ')} ORDER BY COALESCE(t.close_time, t.open_time), t.id`, ...args);
}

const round = (n, d = 2) => (n === null || !Number.isFinite(n) ? null : Math.round(n * 10 ** d) / 10 ** d);

export function computeStats(trades, tz) {
  const closed = trades.filter(t => t.close_time && t.profit !== null);
  const nets = closed.map(net);
  const wins = nets.filter(n => n > 0), losses = nets.filter(n => n < 0);
  const grossWin = wins.reduce((a, b) => a + b, 0), grossLoss = -losses.reduce((a, b) => a + b, 0);
  const rs = closed.filter(t => t.risk_amount > 0).map(t => net(t) / t.risk_amount);
  let eq = 0, peak = 0, maxDd = 0;
  const equity = closed.map(t => {
    eq += net(t); peak = Math.max(peak, eq); maxDd = Math.max(maxDd, peak - eq);
    return { t: t.close_time, equity: round(eq), id: t.id };
  });
  const bySymbol = {}, byDay = {};
  for (const t of closed) {
    const s = (bySymbol[t.symbol] ||= { symbol: t.symbol, trades: 0, net: 0, wins: 0 });
    s.trades++; s.net += net(t); if (net(t) > 0) s.wins++;
    const d = localDate(new Date(t.close_time), tz);
    const day = (byDay[d] ||= { date: d, trades: 0, net: 0 });
    day.trades++; day.net += net(t);
  }
  let streak = 0, bestStreak = 0, worstStreak = 0, cur = 0;
  for (const n of nets) {
    if (n > 0) cur = cur > 0 ? cur + 1 : 1; else if (n < 0) cur = cur < 0 ? cur - 1 : -1; else cur = 0;
    bestStreak = Math.max(bestStreak, cur); worstStreak = Math.min(worstStreak, cur);
  }
  streak = cur;
  return {
    trades: closed.length,
    openTrades: trades.length - closed.length,
    netPnl: round(nets.reduce((a, b) => a + b, 0)),
    wins: wins.length, losses: losses.length, breakeven: nets.length - wins.length - losses.length,
    winRate: closed.length ? round((wins.length / closed.length) * 100, 1) : null,
    profitFactor: grossLoss > 0 ? round(grossWin / grossLoss) : (grossWin > 0 ? null : null),
    profitFactorInfinite: grossLoss === 0 && grossWin > 0,
    avgWin: wins.length ? round(grossWin / wins.length) : null,
    avgLoss: losses.length ? round(-grossLoss / losses.length) : null,
    expectancy: closed.length ? round(nets.reduce((a, b) => a + b, 0) / closed.length) : null,
    avgR: rs.length ? round(rs.reduce((a, b) => a + b, 0) / rs.length) : null,
    rTrades: rs.length,
    maxDrawdown: round(maxDd),
    bestTrade: nets.length ? round(Math.max(...nets)) : null,
    worstTrade: nets.length ? round(Math.min(...nets)) : null,
    currentStreak: streak, bestStreak, worstStreak: -worstStreak,
    planFollowedRate: (() => {
      const f = closed.filter(t => t.plan_followed !== null);
      return f.length ? round((f.filter(t => t.plan_followed === 1).length / f.length) * 100, 1) : null;
    })(),
    equity,
    bySymbol: Object.values(bySymbol).map(s => ({ ...s, net: round(s.net), winRate: round((s.wins / s.trades) * 100, 1) })).sort((a, b) => b.net - a.net),
    byDay: Object.values(byDay).map(d => ({ ...d, net: round(d.net) })).sort((a, b) => a.date.localeCompare(b.date)),
  };
}

/**
 * Discipline score for one local day (0–100), from the components that exist:
 * checklist completion, rule adherence, max-trades limit, max-loss limit,
 * plan-followed flags on trades, and whether the post-session review was done.
 */
export async function disciplineForDay(db, user, ymd, mode) {
  const tz = user.timezone;
  const from = startOfLocalDay(ymd, tz).toISOString();
  const to = startOfLocalDay(addDays(ymd, 1), tz).toISOString();
  const plan = await db.get('SELECT * FROM daily_plans WHERE user_id=? AND plan_date=?', user.id, ymd);
  const items = (await db.get('SELECT COUNT(*)::int c FROM checklist_items WHERE user_id=? AND active=1', user.id)).c;
  const checked = (await db.get(`SELECT COUNT(*)::int c FROM checklist_checks cc JOIN checklist_items ci ON ci.id=cc.item_id
                                 WHERE cc.user_id=? AND cc.check_date=? AND cc.checked=1 AND ci.active=1`, user.id, ymd)).c;
  const adh = await db.all('SELECT followed FROM rule_adherence ra JOIN trading_rules r ON r.id=ra.rule_id WHERE ra.user_id=? AND ra.review_date=? AND r.active=1', user.id, ymd);
  const dayTrades = await db.all(`SELECT t.* FROM trades t JOIN accounts a ON a.id=t.account_id
                                  WHERE t.user_id=? AND a.type=? AND t.open_time >= ? AND t.open_time < ?`, user.id, mode, from, to);
  const components = [];
  if (plan || dayTrades.length) {
    if (items) components.push({ key: 'checklist', label: 'Pre-trading checklist', score: checked / items, detail: `${checked}/${items} checked` });
    if (adh.length) {
      const f = adh.filter(a => a.followed).length;
      components.push({ key: 'rules', label: 'Trading rules followed', score: f / adh.length, detail: `${f}/${adh.length} rules` });
    }
    if (plan?.max_trades) {
      components.push({ key: 'max_trades', label: 'Max trades respected', score: dayTrades.length <= plan.max_trades ? 1 : 0, detail: `${dayTrades.length}/${plan.max_trades} trades` });
    }
    if (plan?.max_daily_loss_pct) {
      const bal = (await db.get('SELECT COALESCE(SUM(starting_balance),0)::float8 b FROM accounts WHERE user_id=? AND type=?', user.id, mode)).b;
      const dayNet = dayTrades.filter(t => t.close_time).reduce((a, t) => a + net(t), 0);
      if (bal > 0) {
        const lossPct = dayNet < 0 ? (-dayNet / bal) * 100 : 0;
        components.push({ key: 'max_loss', label: 'Daily loss limit respected', score: lossPct <= plan.max_daily_loss_pct ? 1 : 0, detail: `${round(lossPct)}% / ${plan.max_daily_loss_pct}%` });
      }
    }
    const flagged = dayTrades.filter(t => t.plan_followed !== null);
    if (flagged.length) {
      const f = flagged.filter(t => t.plan_followed === 1).length;
      components.push({ key: 'plan_trades', label: 'Trades taken per plan', score: f / flagged.length, detail: `${f}/${flagged.length} trades` });
    }
    components.push({ key: 'plan', label: 'Daily plan prepared', score: plan ? 1 : 0, detail: plan ? 'Done' : 'No plan' });
    components.push({ key: 'review', label: 'Post-session review', score: plan?.reviewed_at ? 1 : 0, detail: plan?.reviewed_at ? 'Done' : 'Not done' });
  }
  const score = components.length ? Math.round((components.reduce((a, c) => a + c.score, 0) / components.length) * 100) : null;
  return { date: ymd, score, components, trades: dayTrades.length };
}

export async function disciplineRange(db, user, fromYmd, toYmd, mode) {
  const dates = [];
  for (let d = fromYmd; d <= toYmd; d = addDays(d, 1)) dates.push(d);
  const days = await Promise.all(dates.map((d) => disciplineForDay(db, user, d, mode)));
  const scored = days.filter(d => d.score !== null);
  // Streak: consecutive most-recent scored days with score >= 80
  let streak = 0;
  for (let i = scored.length - 1; i >= 0 && scored[i].score >= 80; i--) streak++;
  return {
    days,
    average: scored.length ? Math.round(scored.reduce((a, d) => a + d.score, 0) / scored.length) : null,
    disciplinedStreak: streak,
    scoredDays: scored.length,
  };
}
