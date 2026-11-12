import { Link, useNavigate } from 'react-router-dom';
import { api, qs } from '../api.js';
import { useAuth, PageHead } from '../App.jsx';
import { Card, Stat, Empty, Alert, Loading, useLoad, ImpactBadge } from '../components/ui.jsx';
import { EquityChart, Bars, ScoreRing } from '../components/charts.jsx';
import { Icon } from '../components/icons.jsx';
import { money, pct, numf, signClass, fmtDay, fmtDateTime, relTime } from '../format.js';

export default function Dashboard() {
  const { user } = useAuth();
  const nav = useNavigate();
  const { data, error, loading } = useLoad(() => api.get(`/api/dashboard${qs({ mode: user.activeMode })}`), [user.activeMode]);
  if (loading && !data) return <><PageHead title="Dashboard" /><Loading /></>;
  if (error) return <><PageHead title="Dashboard" /><Alert kind="error">{error.message}</Alert></>;
  const s = data.stats;
  const ccy = 'USD';
  const hasTrades = s.trades > 0;
  return (
    <>
      <PageHead title={`Hello, ${user.displayName}`} sub={`${fmtDay(data.today)} · ${data.timezone.replace('_', ' ')}`}>
        <Link className="btn primary" to="/journal/quick"><Icon.plus />New trade</Link>
      </PageHead>
      <div className={`mode-banner ${data.mode}`} style={{ marginBottom: 16 }}>
        <Icon.shield width={16} />
        Showing {data.mode === 'live' ? 'LIVE' : 'DEMO'} accounts only ({data.balance.accounts}). Demo and Live statistics are never combined.
      </div>

      <div className="grid g4" style={{ marginBottom: 16 }}>
        <Card><Stat label="Net P&L (all time)" value={money(s.netPnl, ccy, { sign: true })} className={signClass(s.netPnl)} hint={`${s.trades} closed trades`} /></Card>
        <Card><Stat label="Win rate" value={pct(s.winRate)} hint={`${s.wins}W · ${s.losses}L · ${s.breakeven}BE`} /></Card>
        <Card><Stat label="Profit factor" value={s.profitFactorInfinite ? '∞' : numf(s.profitFactor)} hint={`Expectancy ${money(s.expectancy, ccy)}`} /></Card>
        <Card><Stat label="Average R" value={s.avgR === null ? '—' : `${numf(s.avgR)}R`} hint={`Max drawdown ${money(s.maxDrawdown, ccy)}`} /></Card>
      </div>

      <div className="grid g3" style={{ marginBottom: 16 }}>
        <Card className="span2 feature" title="Equity curve" icon={<Icon.trend />} sub={`Balance ${money(data.balance.current, ccy)} · started ${money(data.balance.starting, ccy)}`}>
          {hasTrades ? <EquityChart points={s.equity} currency={ccy} /> : (
            <Empty icon={<Icon.trend />} action={<div className="row" style={{ justifyContent: 'center' }}><Link className="btn sm" to="/journal/quick">Add a trade</Link><Link className="btn sm" to="/import">Import MT5 CSV</Link></div>}>
              No closed {data.mode} trades yet. Statistics appear once you record or import trades.
            </Empty>
          )}
        </Card>
        <Card title="Discipline" icon={<Icon.target />} action={<Link className="small" to="/discipline">Details</Link>}>
          <div className="row" style={{ gap: 18, alignItems: 'center' }}>
            <ScoreRing score={data.discipline.today?.score ?? null} />
            <div className="stack" style={{ gap: 6 }}>
              <div className="small text-2">Today's score</div>
              <div className="small">14-day avg: <b>{data.discipline.average ?? '—'}</b></div>
              <div className="small">Disciplined streak: <b>{data.discipline.streak} day{data.discipline.streak === 1 ? '' : 's'}</b></div>
            </div>
          </div>
          <div style={{ marginTop: 14 }}>
            <Bars items={data.discipline.series.map((d) => ({ label: d.date.slice(8), value: d.score }))} height={56} colorFor={(v) => (v >= 80 ? 'var(--pos)' : v >= 50 ? 'var(--accent)' : 'var(--neg)')} />
          </div>
        </Card>
      </div>

      <div className="grid g3" style={{ marginBottom: 16 }}>
        <Card title="Today's plan" icon={<Icon.planner />} action={<Link className="small" to="/planner">Open planner</Link>}>
          <div className="stack" style={{ gap: 12 }}>
            <div className="row between"><span className="small text-2">Daily preparation</span>{data.plan.exists ? <span className="badge pos">Done</span> : <span className="badge warn">Not started</span>}</div>
            <div>
              <div className="row between small"><span className="text-2">Pre-trading checklist</span><span>{data.plan.checklistDone}/{data.plan.checklistTotal}</span></div>
              <div className="progress" style={{ marginTop: 6 }}><div style={{ width: `${data.plan.checklistTotal ? (data.plan.checklistDone / data.plan.checklistTotal) * 100 : 0}%` }} /></div>
            </div>
            <div className="row between"><span className="small text-2">Trades today</span><span className="small">{data.todayStats.trades + data.todayStats.openTrades}{data.plan.maxTrades ? ` / ${data.plan.maxTrades} max` : ''}</span></div>
            <div className="row between"><span className="small text-2">Today's P&L</span><span className={`small ${signClass(data.todayStats.netPnl)}`}>{money(data.todayStats.netPnl, ccy, { sign: true })}</span></div>
            <div className="row between"><span className="small text-2">Post-session review</span>{data.plan.reviewed ? <span className="badge pos">Done</span> : <span className="badge">Pending</span>}</div>
          </div>
        </Card>
        <Card className="span2" title="Upcoming news" icon={<Icon.calendar />} sub={`${data.calendar.provider} · updated ${relTime(data.calendar.lastSuccessfulUpdate)}`} action={<Link className="small" to="/calendar">Full calendar</Link>}>
          {data.calendar.stale && <div style={{ marginBottom: 10 }}><Alert kind="warn">{data.calendar.hasData ? 'Calendar data is stale — the provider has not been reached recently.' : 'No calendar data yet. The provider has not been reached successfully.'}</Alert></div>}
          {data.upcomingNews.length === 0 ? <Empty>No matching events in the next 48 hours.</Empty> : (
            <div className="list">
              {data.upcomingNews.map((e) => (
                <div className="list-item" key={e.id}>
                  <div className="nowrap" style={{ width: 92 }}><div style={{ fontWeight: 620 }}>{e.localTime}</div><div className="tiny muted">{fmtDay(e.localDate, { weekday: 'short', day: 'numeric', month: 'short' })}</div></div>
                  <span className="badge" style={{ fontWeight: 700 }}>{e.currency}</span>
                  <div className="grow ellipsis">{e.title}</div>
                  <ImpactBadge impact={e.impact} />
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <div className="grid g3">
        <Card title="This week" icon={<Icon.report />} action={<Link className="small" to="/reports">Reports</Link>}>
          <div className="grid g2">
            <Stat label="Net P&L" value={money(data.weekStats.netPnl, ccy, { sign: true })} className={signClass(data.weekStats.netPnl)} />
            <Stat label="Trades" value={data.weekStats.trades} />
            <Stat label="Win rate" value={pct(data.weekStats.winRate)} />
            <Stat label="Avg R" value={data.weekStats.avgR === null ? '—' : `${numf(data.weekStats.avgR)}R`} />
          </div>
        </Card>
        <Card className="span2" title="Recent trades" icon={<Icon.journal />} action={<Link className="small" to="/journal">All trades</Link>}>
          {data.recentTrades.length === 0 ? <Empty>No trades recorded yet.</Empty> : (
            <div className="table-wrap"><table className="table">
              <thead><tr><th>Symbol</th><th>Side</th><th>Closed</th><th className="num">Net</th><th className="num">R</th></tr></thead>
              <tbody>{data.recentTrades.map((t) => (
                <tr key={t.id} className="click" onClick={() => nav(`/journal/${t.id}`)}>
                  <td style={{ fontWeight: 600 }}>{t.symbol}</td>
                  <td><span className={`badge ${t.direction === 'buy' ? 'pos' : 'neg'}`}>{t.direction.toUpperCase()}</span></td>
                  <td className="small text-2">{t.closeTime ? fmtDateTime(t.closeTime, user.timezone) : <span className="badge accent">Open</span>}</td>
                  <td className={`num ${signClass(t.netProfit)}`}>{money(t.netProfit, ccy, { sign: true })}</td>
                  <td className="num">{t.rMultiple === null ? '—' : `${t.rMultiple}R`}</td>
                </tr>))}
              </tbody>
            </table></div>
          )}
        </Card>
      </div>
      {data.stats.bySymbol.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <Card title="Performance by symbol" sub="Closed trades" icon={<Icon.report />}>
            <Bars items={s.bySymbol.slice(0, 12).map((x) => ({ label: x.symbol, value: x.net }))} format={(v) => money(v, ccy)} />
          </Card>
        </div>
      )}
    </>
  );
}
