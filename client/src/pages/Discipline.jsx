import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, qs } from '../api.js';
import { useAuth, PageHead } from '../App.jsx';
import { Card, Alert, Loading, useLoad, Stat } from '../components/ui.jsx';
import { Bars, ScoreRing } from '../components/charts.jsx';
import { Icon } from '../components/icons.jsx';
import { todayIn, addDays, fmtDay } from '../format.js';

export default function Discipline() {
  const { user } = useAuth();
  const today = todayIn(user.timezone);
  const [range, setRange] = useState(30);
  const { data, error, loading } = useLoad(() => api.get(`/api/discipline${qs({ mode: user.activeMode, from: addDays(today, -(range - 1)), to: today })}`), [user.activeMode, range]);
  const [sel, setSel] = useState(null);
  const day = data ? (data.days.find((d) => d.date === sel) || data.days[data.days.length - 1]) : null;
  return (
    <>
      <PageHead title="Discipline Tracking" sub="Scored from your checklist, rules, limits, plan and review">
        <div className="seg">{[7, 30, 90].map((n) => <button key={n} className={range === n ? 'on' : ''} onClick={() => setRange(n)}>{n}d</button>)}</div>
      </PageHead>
      {error && <Alert kind="error">{error.message}</Alert>}
      {loading && !data ? <Loading /> : data && (
        <div className="stack">
          <div className="grid g4">
            <Card><Stat label={`Average (${range}d)`} value={data.average ?? '—'} hint={`${data.scoredDays} active days`} /></Card>
            <Card><Stat label="Disciplined streak" value={`${data.disciplinedStreak} d`} hint="Consecutive active days ≥ 80" /></Card>
            <Card><Stat label="Days ≥ 80" value={data.days.filter((d) => d.score >= 80).length} /></Card>
            <Card><Stat label="Days < 50" value={data.days.filter((d) => d.score !== null && d.score < 50).length} className={data.days.some((d) => d.score !== null && d.score < 50) ? 'neg' : ''} /></Card>
          </div>
          <Card title="Daily scores" icon={<Icon.target />} sub="Click a bar to see the breakdown. Days without a plan or trades are not scored.">
            <div style={{ overflowX: 'auto' }}>
              <div style={{ minWidth: Math.max(300, data.days.length * 18) }} onClick={(e) => { const el = e.target.closest('[title]'); if (el) setSel(el.getAttribute('data-d')); }}>
                <div style={{ display: 'flex', gap: 4, alignItems: 'flex-end', height: 150 }}>
                  {data.days.map((d) => (
                    <button key={d.date} type="button" data-d={d.date} title={`${d.date}: ${d.score ?? 'not scored'}`} onClick={() => setSel(d.date)}
                      style={{ flex: 1, minWidth: 8, height: d.score === null ? 4 : Math.max(6, d.score * 1.4), borderRadius: 5, border: 0, cursor: 'pointer', padding: 0,
                        background: d.score === null ? 'var(--surface-3)' : d.score >= 80 ? 'var(--pos)' : d.score >= 50 ? 'var(--accent)' : 'var(--neg)', outline: day?.date === d.date ? '2px solid var(--text)' : 'none', outlineOffset: 2 }} />
                  ))}
                </div>
              </div>
            </div>
          </Card>
          {day && (
            <Card title={fmtDay(day.date)} icon={<Icon.planner />} action={<Link className="small" to={`/planner/${day.date}`}>Open plan</Link>}>
              {day.score === null ? <p className="muted small">No plan or trades on this day, so it isn't scored.</p> : (
                <div className="row" style={{ gap: 24, alignItems: 'flex-start' }}>
                  <ScoreRing score={day.score} />
                  <div className="list grow" style={{ minWidth: 240 }}>
                    {day.components.map((c) => (
                      <div className="list-item" key={c.key}>
                        <span className={`dot`} style={{ background: c.score >= 1 ? 'var(--pos)' : c.score > 0 ? 'var(--accent)' : 'var(--neg)' }} />
                        <span className="grow small">{c.label}</span>
                        <span className="small text-2">{c.detail}</span>
                        <b className="small" style={{ width: 44, textAlign: 'right' }}>{Math.round(c.score * 100)}</b>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </Card>
          )}
        </div>
      )}
    </>
  );
}
