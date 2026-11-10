import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, qs } from '../api.js';
import { useAuth, PageHead } from '../App.jsx';
import { Card, Alert, Loading, Field, Stars, useToast, Stat } from '../components/ui.jsx';
import { Bars } from '../components/charts.jsx';
import { Icon } from '../components/icons.jsx';
import { todayIn, addDays, weekStartOf, fmtDay, money, pct, signClass, numf } from '../format.js';

export default function WeeklyReview() {
  const { user } = useAuth();
  const toast = useToast();
  const [sp, setSp] = useSearchParams();
  const ws = weekStartOf(sp.get('week') || todayIn(user.timezone));
  const [report, setReport] = useState(null);
  const [f, setF] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setReport(null); setErr(null);
    api.get(`/api/reports/weekly/${ws}${qs({ mode: user.activeMode })}`).then((r) => {
      setReport(r);
      const v = r.review || {};
      setF({ whatWorked: v.whatWorked || '', whatDidnt: v.whatDidnt || '', improvements: v.improvements || '', focusNextWeek: v.focusNextWeek || '', rating: v.rating ?? null });
    }).catch((e) => setErr(e.message));
  }, [ws, user.activeMode]);

  const save = async () => {
    setBusy(true);
    try { await api.put(`/api/weekly/${ws}`, f); toast('Weekly review saved'); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  return (
    <>
      <PageHead title="Weekly Performance Review" sub={`${fmtDay(ws, { day: 'numeric', month: 'short' })} – ${fmtDay(addDays(ws, 6), { day: 'numeric', month: 'short', year: 'numeric' })}`}>
        <button className="btn sm" onClick={() => setSp({ week: addDays(ws, -7) })} aria-label="Previous week"><Icon.chevL /></button>
        <button className="btn sm" onClick={() => setSp({ week: addDays(ws, 7) })} aria-label="Next week"><Icon.chevR /></button>
      </PageHead>
      {err && <Alert kind="error">{err}</Alert>}
      {!report || !f ? (!err && <Loading />) : (
        <div className="stack">
          <div className="grid g4">
            <Card><Stat label="Net P&L" value={money(report.stats.netPnl, 'USD', { sign: true })} className={signClass(report.stats.netPnl)} hint={`Prev. week ${money(report.previousWeek.netPnl, 'USD', { sign: true })}`} /></Card>
            <Card><Stat label="Trades" value={report.stats.trades} hint={`Win rate ${pct(report.stats.winRate)}`} /></Card>
            <Card><Stat label="Average R" value={report.stats.avgR === null ? '—' : `${numf(report.stats.avgR)}R`} hint={`PF ${report.stats.profitFactorInfinite ? '∞' : numf(report.stats.profitFactor)}`} /></Card>
            <Card><Stat label="Discipline avg" value={report.discipline.average ?? '—'} hint={`${report.discipline.scoredDays} scored days`} /></Card>
          </div>
          <Card title="Daily P&L" icon={<Icon.report />}>
            <Bars items={report.days.map((d) => ({ label: fmtDay(d.date, { weekday: 'short' }), value: d.net }))} format={(v) => money(v)} />
          </Card>
          <Card title="Your review" icon={<Icon.planner />} sub={`${user.activeMode.toUpperCase()} mode stats shown above`}>
            <div className="form-grid">
              <Field label="What worked this week" className="full"><textarea className="input" value={f.whatWorked} onChange={set('whatWorked')} /></Field>
              <Field label="What didn't work" className="full"><textarea className="input" value={f.whatDidnt} onChange={set('whatDidnt')} /></Field>
              <Field label="Improvements to make" className="full"><textarea className="input" value={f.improvements} onChange={set('improvements')} /></Field>
              <Field label="Focus for next week" className="full"><textarea className="input" value={f.focusNextWeek} onChange={set('focusNextWeek')} /></Field>
              <Field label="Week rating"><Stars value={f.rating} onChange={(v) => setF({ ...f, rating: v })} /></Field>
            </div>
            <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}><button className="btn primary" disabled={busy} onClick={save}>Save weekly review</button></div>
          </Card>
        </div>
      )}
    </>
  );
}
