import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, qs } from '../api.js';
import { useAuth, PageHead } from '../App.jsx';
import { Card, Alert, Loading, useLoad, Stat, ImpactBadge } from '../components/ui.jsx';
import { Bars, ScoreRing } from '../components/charts.jsx';
import { Icon } from '../components/icons.jsx';
import { todayIn, addDays, weekStartOf, fmtDay, fmtDateTime, money, pct, numf, signClass } from '../format.js';

export default function Reports() {
  const { user } = useAuth();
  const today = todayIn(user.timezone);
  const [kind, setKind] = useState('daily');
  const [date, setDate] = useState(today);
  const ws = weekStartOf(date);
  const step = (n) => setDate(addDays(date, kind === 'daily' ? n : n * 7));
  return (
    <>
      <PageHead title="Reports" sub={kind === 'daily' ? fmtDay(date) : `Week of ${fmtDay(ws, { day: 'numeric', month: 'long', year: 'numeric' })}`}>
        <div className="seg">{[['daily', 'Daily'], ['weekly', 'Weekly']].map(([k, l]) => <button key={k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>{l}</button>)}</div>
        <button className="btn sm" onClick={() => step(-1)} aria-label="Previous"><Icon.chevL /></button>
        <input className="input" type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} style={{ height: 32, width: 150 }} aria-label="Report date" />
        <button className="btn sm" onClick={() => step(1)} aria-label="Next"><Icon.chevR /></button>
        <button className="btn sm" onClick={() => window.print()}><Icon.print />Print</button>
      </PageHead>
      {kind === 'daily' ? <Daily date={date} /> : <Weekly ws={ws} />}
    </>
  );
}

function TradesTable({ trades, tz }) {
  const nav = useNavigate();
  if (!trades.length) return <p className="small muted">No trades.</p>;
  return (
    <div className="table-wrap"><table className="table">
      <thead><tr><th>Opened</th><th>Symbol</th><th>Side</th><th className="num">Lots</th><th className="num">Net</th><th className="num">R</th><th>Plan</th><th>Notes</th></tr></thead>
      <tbody>{trades.map((t) => (
        <tr key={t.id} className="click" onClick={() => nav(`/journal/${t.id}`)}>
          <td className="small nowrap">{fmtDateTime(t.openTime, tz)}</td><td style={{ fontWeight: 600 }}>{t.symbol}</td><td>{t.direction}</td>
          <td className="num">{numf(t.volume)}</td><td className={`num ${signClass(t.netProfit)}`}>{t.closeTime ? money(t.netProfit, 'USD', { sign: true }) : 'open'}</td>
          <td className="num">{t.rMultiple === null ? '—' : `${t.rMultiple}R`}</td>
          <td>{t.planFollowed === null ? '—' : t.planFollowed ? '✓' : '✗'}</td>
          <td className="small text-2 ellipsis" style={{ maxWidth: 260 }}>{t.notes || ''}</td>
        </tr>))}</tbody>
    </table></div>
  );
}

function Daily({ date }) {
  const { user } = useAuth();
  const { data, error, loading } = useLoad(() => api.get(`/api/reports/daily/${date}${qs({ mode: user.activeMode })}`), [date, user.activeMode]);
  if (error) return <Alert kind="error">{error.message}</Alert>;
  if (loading && !data) return <Loading />;
  const s = data.stats;
  const p = data.plan;
  return (
    <div className="stack">
      <div className={`mode-banner ${data.mode}`}>{data.mode.toUpperCase()} accounts</div>
      <div className="grid g4">
        <Card><Stat label="Net P&L" value={money(s.netPnl, 'USD', { sign: true })} className={signClass(s.netPnl)} /></Card>
        <Card><Stat label="Trades" value={s.trades} hint={`${s.openTrades} open`} /></Card>
        <Card><Stat label="Win rate" value={pct(s.winRate)} /></Card>
        <Card><Stat label="Average R" value={s.avgR === null ? '—' : `${numf(s.avgR)}R`} /></Card>
      </div>
      <div className="grid g3">
        <Card title="Discipline" icon={<Icon.target />}>
          <div className="row" style={{ gap: 16 }}>
            <ScoreRing score={data.discipline.score} size={96} />
            <div className="stack" style={{ gap: 4 }}>{data.discipline.components.map((c) => <div key={c.key} className="tiny"><span className={c.score >= 1 ? 'pos' : c.score > 0 ? '' : 'neg'}>●</span> {c.label}: {c.detail}</div>)}</div>
          </div>
        </Card>
        <Card className="span2" title="Plan & review" icon={<Icon.planner />} action={<Link className="small no-print" to={`/planner/${date}`}>Edit</Link>}>
          {!p ? <p className="small muted">No plan for this day.</p> : (
            <div className="grid g2 small">
              <div><div className="muted tiny">BIAS</div>{p.marketBias || '—'}</div>
              <div><div className="muted tiny">LIMITS</div>Max trades {p.maxTrades ?? '—'} · Max loss {p.maxDailyLossPct ?? '—'}%</div>
              <div><div className="muted tiny">WENT WELL</div>{p.review.wentWell || '—'}</div>
              <div><div className="muted tiny">MISTAKES</div>{p.review.mistakes || '—'}</div>
              <div className="span2"><div className="muted tiny">LESSONS</div>{p.review.lessons || '—'}</div>
            </div>
          )}
          {data.rules.some((r) => r.followed !== null) && (
            <div className="chips" style={{ marginTop: 12 }}>{data.rules.filter((r) => r.followed !== null).map((r) => <span key={r.id} className={`badge ${r.followed ? 'pos' : 'neg'}`}>{r.followed ? '✓' : '✗'} {r.rule}</span>)}</div>
          )}
        </Card>
      </div>
      <Card title="Trades" icon={<Icon.journal />}><TradesTable trades={data.trades} tz={user.timezone} /></Card>
      <Card title="High & medium impact news" icon={<Icon.calendar />}>
        {data.news.length === 0 ? <p className="small muted">No high/medium impact events recorded from the provider for this day.</p> : (
          <div className="list">{data.news.map((e) => <div className="list-item" key={e.id}><b className="small" style={{ width: 46 }}>{e.localTime}</b><span className="badge">{e.currency}</span><span className="grow small">{e.title}</span><ImpactBadge impact={e.impact} /></div>)}</div>
        )}
      </Card>
    </div>
  );
}

function Weekly({ ws }) {
  const { user } = useAuth();
  const { data, error, loading } = useLoad(() => api.get(`/api/reports/weekly/${ws}${qs({ mode: user.activeMode })}`), [ws, user.activeMode]);
  if (error) return <Alert kind="error">{error.message}</Alert>;
  if (loading && !data) return <Loading />;
  const s = data.stats;
  return (
    <div className="stack">
      <div className={`mode-banner ${data.mode}`}>{data.mode.toUpperCase()} accounts</div>
      <div className="grid g4">
        <Card><Stat label="Net P&L" value={money(s.netPnl, 'USD', { sign: true })} className={signClass(s.netPnl)} hint={`Prev. week ${money(data.previousWeek.netPnl, 'USD', { sign: true })}`} /></Card>
        <Card><Stat label="Trades" value={s.trades} hint={`${s.wins}W · ${s.losses}L`} /></Card>
        <Card><Stat label="Profit factor" value={s.profitFactorInfinite ? '∞' : numf(s.profitFactor)} hint={`Win rate ${pct(s.winRate)}`} /></Card>
        <Card><Stat label="Discipline avg" value={data.discipline.average ?? '—'} hint={`${data.discipline.scoredDays} scored days`} /></Card>
      </div>
      <div className="grid g2">
        <Card title="P&L by day" icon={<Icon.report />}><Bars items={data.days.map((d) => ({ label: fmtDay(d.date, { weekday: 'short' }), value: d.net }))} format={(v) => money(v)} /></Card>
        <Card title="Discipline by day" icon={<Icon.target />}><Bars items={data.days.map((d) => ({ label: fmtDay(d.date, { weekday: 'short' }), value: d.discipline }))} colorFor={(v) => (v >= 80 ? 'var(--pos)' : v >= 50 ? 'var(--accent)' : 'var(--neg)')} /></Card>
      </div>
      {s.bySymbol.length > 0 && (
        <Card title="By symbol">
          <div className="table-wrap"><table className="table"><thead><tr><th>Symbol</th><th className="num">Trades</th><th className="num">Win rate</th><th className="num">Net</th></tr></thead>
            <tbody>{s.bySymbol.map((x) => <tr key={x.symbol}><td style={{ fontWeight: 600 }}>{x.symbol}</td><td className="num">{x.trades}</td><td className="num">{pct(x.winRate)}</td><td className={`num ${signClass(x.net)}`}>{money(x.net, 'USD', { sign: true })}</td></tr>)}</tbody></table></div>
        </Card>
      )}
      <Card title="Weekly review" icon={<Icon.planner />} action={<Link className="small no-print" to={`/weekly?week=${ws}`}>{data.review ? 'Edit' : 'Write review'}</Link>}>
        {!data.review ? <p className="small muted">No weekly review written yet.</p> : (
          <div className="grid g2 small">
            <div><div className="muted tiny">WHAT WORKED</div>{data.review.whatWorked || '—'}</div>
            <div><div className="muted tiny">WHAT DIDN'T</div>{data.review.whatDidnt || '—'}</div>
            <div><div className="muted tiny">IMPROVEMENTS</div>{data.review.improvements || '—'}</div>
            <div><div className="muted tiny">FOCUS NEXT WEEK</div>{data.review.focusNextWeek || '—'}</div>
          </div>
        )}
      </Card>
      <Card title="Trades" icon={<Icon.journal />}><TradesTable trades={data.trades} tz={user.timezone} /></Card>
    </div>
  );
}
