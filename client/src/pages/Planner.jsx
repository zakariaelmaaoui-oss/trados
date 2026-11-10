import { useEffect, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { api, qs } from '../api.js';
import { useAuth, PageHead } from '../App.jsx';
import { Card, Alert, Loading, Field, Stars, useToast, useLoad, ImpactBadge } from '../components/ui.jsx';
import { Icon } from '../components/icons.jsx';
import { todayIn, addDays, fmtDay, weekStartOf } from '../format.js';

export default function Planner() {
  const { user } = useAuth();
  const params = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const today = todayIn(user.timezone);
  const date = params.date || today;
  const [tab, setTab] = useState('prep');
  const [data, setData] = useState(null);
  const [f, setF] = useState(null);
  const [rv, setRv] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const news = useLoad(() => api.get(`/api/calendar${qs({ from: date, to: date, impacts: 'high,medium' })}`), [date]);

  const hydrate = (r) => {
    setData(r);
    const p = r.plan || {};
    const s = (v) => (v === null || v === undefined ? '' : String(v));
    setF({ marketBias: s(p.marketBias), keyLevels: s(p.keyLevels), pairsToWatch: s(p.pairsToWatch), newsToWatch: s(p.newsToWatch), goals: s(p.goals), maxTrades: s(p.maxTrades), maxDailyLossPct: s(p.maxDailyLossPct), mentalState: p.mentalState ?? null });
    const rr = p.review || {};
    setRv({ followedPlan: rr.followedPlan ?? null, wentWell: s(rr.wentWell), mistakes: s(rr.mistakes), lessons: s(rr.lessons), rating: rr.rating ?? null, rules: Object.fromEntries(r.rules.map((x) => [x.id, x.followed])) });
    setDirty(false);
  };
  useEffect(() => {
    setData(null); setErr(null);
    api.get(`/api/plans/${date}`).then(hydrate).catch((e) => setErr(e.message));
  }, [date]);

  const savePlan = async (extra = {}) => {
    setBusy(true); setErr(null);
    try {
      const nz = (v) => (v === '' ? null : v);
      const r = await api.put(`/api/plans/${date}`, { ...f, maxTrades: nz(f.maxTrades), maxDailyLossPct: nz(f.maxDailyLossPct), ...extra });
      hydrate(r); toast('Plan saved');
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const saveReview = async (complete) => {
    await savePlan({ review: { ...rv, complete } });
  };
  const toggleCheck = async (item) => {
    try { const r = await api.put(`/api/checklist/${date}/${item.id}`, { checked: !item.checked }); setData({ ...data, checklist: r.checklist }); }
    catch (e) { toast(e.message, 'error'); }
  };

  const set = (k) => (e) => { setF({ ...f, [k]: e.target.value }); setDirty(true); };
  const setR = (k) => (e) => { setRv({ ...rv, [k]: e.target.value }); setDirty(true); };

  const head = (
    <PageHead title="Daily Planner" sub={fmtDay(date)}>
      <div className="row" style={{ gap: 4 }}>
        <button className="btn sm" onClick={() => nav(`/planner/${addDays(date, -1)}`)} aria-label="Previous day"><Icon.chevL /></button>
        <input className="input" type="date" value={date} onChange={(e) => e.target.value && nav(`/planner/${e.target.value}`)} style={{ height: 32, width: 150 }} aria-label="Plan date" />
        <button className="btn sm" onClick={() => nav(`/planner/${addDays(date, 1)}`)} aria-label="Next day"><Icon.chevR /></button>
        {date !== today && <button className="btn sm" onClick={() => nav('/planner')}>Today</button>}
      </div>
      <Link className="btn sm" to={`/weekly?week=${weekStartOf(date)}`}>Weekly review</Link>
    </PageHead>
  );
  if (err && !data) return <>{head}<Alert kind="error">{err}</Alert></>;
  if (!data || !f) return <>{head}<Loading /></>;

  const done = data.checklist.filter((c) => c.checked).length;
  return (
    <>
      {head}
      <div className="tabs" role="tablist">
        {[['prep', 'Preparation'], ['checklist', `Checklist ${done}/${data.checklist.length}`], ['review', 'Post-session review'], ['manage', 'Rules & checklist']].map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      {err && <div style={{ marginBottom: 12 }}><Alert kind="error">{err}</Alert></div>}

      {tab === 'prep' && (
        <div className="grid g3">
          <Card className="span2" title="Daily preparation" icon={<Icon.planner />} sub={data.plan ? `Last saved ${new Date(data.plan.updatedAt).toLocaleTimeString()}` : 'Not saved yet'}>
            <div className="form-grid">
              <Field label="Market bias" className="full"><textarea className="input" rows={2} value={f.marketBias} onChange={set('marketBias')} placeholder="e.g. USD strength into CPI; EURUSD bearish below 1.0850" /></Field>
              <Field label="Pairs to watch"><input className="input" value={f.pairsToWatch} onChange={set('pairsToWatch')} placeholder="EURUSD, GBPJPY, XAUUSD" /></Field>
              <Field label="Max trades today"><input className="input" inputMode="numeric" value={f.maxTrades} onChange={set('maxTrades')} placeholder="e.g. 3" /></Field>
              <Field label="Max daily loss %"><input className="input" inputMode="decimal" value={f.maxDailyLossPct} onChange={set('maxDailyLossPct')} placeholder="e.g. 2" /></Field>
              <Field label="Key levels" className="full"><textarea className="input" rows={3} value={f.keyLevels} onChange={set('keyLevels')} placeholder="Support / resistance, liquidity pools, session highs/lows" /></Field>
              <Field label="News to watch" className="full"><textarea className="input" rows={2} value={f.newsToWatch} onChange={set('newsToWatch')} placeholder="Events from the calendar you'll avoid or trade around" /></Field>
              <Field label="Goals for today" className="full"><textarea className="input" rows={2} value={f.goals} onChange={set('goals')} placeholder="Process goals, e.g. 'Wait for confirmation candle before entry'" /></Field>
              <Field label="Mental state" className="full"><Stars value={f.mentalState} onChange={(v) => { setF({ ...f, mentalState: v }); setDirty(true); }} label="Mental state" /></Field>
            </div>
            <div className="row" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
              {dirty && <span className="small muted">Unsaved changes</span>}
              <button className="btn primary" disabled={busy} onClick={() => savePlan()}>{busy ? 'Saving…' : data.plan ? 'Save plan' : 'Create plan'}</button>
            </div>
          </Card>
          <Card title="High & medium impact today" icon={<Icon.calendar />} sub={news.data ? `${news.data.status.provider}` : ''}>
            {news.data?.status.stale && <Alert kind="warn">Calendar data may be stale.</Alert>}
            {news.data && news.data.events.length === 0 && <p className="small muted">No high or medium impact events on this day.</p>}
            <div className="list">
              {news.data?.events.map((e) => (
                <div className="list-item" key={e.id}>
                  <b className="nowrap small" style={{ width: 46 }}>{e.localTime}</b>
                  <span className="badge">{e.currency}</span>
                  <span className="grow small ellipsis" title={e.title}>{e.title}</span>
                  <ImpactBadge impact={e.impact} />
                </div>
              ))}
            </div>
            {news.data?.events.length > 0 && (
              <button className="btn sm" style={{ marginTop: 10 }} onClick={() => { setF({ ...f, newsToWatch: news.data.events.map((e) => `${e.localTime} ${e.currency} ${e.title}`).join('\n') }); setDirty(true); }}>Copy into plan</button>
            )}
          </Card>
        </div>
      )}

      {tab === 'checklist' && (
        <Card title="Pre-trading checklist" icon={<Icon.check />} sub="Tick each item before your first trade" action={<span className="badge accent">{done}/{data.checklist.length}</span>}>
          <div className="progress" style={{ marginBottom: 14 }}><div style={{ width: `${data.checklist.length ? (done / data.checklist.length) * 100 : 0}%` }} /></div>
          <div className="stack" style={{ gap: 8 }}>
            {data.checklist.map((c) => (
              <label key={c.id} className={`check ${c.checked ? 'done' : ''}`}>
                <input type="checkbox" checked={c.checked} onChange={() => toggleCheck(c)} />
                <span>{c.label}</span>
              </label>
            ))}
            {data.checklist.length === 0 && <p className="muted small">No checklist items. Add some under “Rules & checklist”.</p>}
          </div>
          {done === data.checklist.length && data.checklist.length > 0 && <div style={{ marginTop: 14 }}><Alert kind="ok">Checklist complete — you're prepared to trade.</Alert></div>}
        </Card>
      )}

      {tab === 'review' && rv && (
        <div className="grid g3">
          <Card className="span2" title="Post-session review" icon={<Icon.report />} sub={data.plan?.review.reviewedAt ? `Completed ${new Date(data.plan.review.reviewedAt).toLocaleString()}` : 'Complete at the end of your session'}>
            <div className="stack">
              <Field label="Did you follow your plan?">
                <div className="seg" style={{ width: 'fit-content' }}>
                  {[[true, 'Yes'], [false, 'No']].map(([v, l]) => <button key={l} type="button" className={rv.followedPlan === v ? 'on' : ''} onClick={() => { setRv({ ...rv, followedPlan: rv.followedPlan === v ? null : v }); setDirty(true); }}>{l}</button>)}
                </div>
              </Field>
              <Field label="What went well"><textarea className="input" value={rv.wentWell} onChange={setR('wentWell')} /></Field>
              <Field label="Mistakes"><textarea className="input" value={rv.mistakes} onChange={setR('mistakes')} /></Field>
              <Field label="Lessons for tomorrow"><textarea className="input" value={rv.lessons} onChange={setR('lessons')} /></Field>
              <Field label="Session rating"><Stars value={rv.rating} onChange={(v) => { setRv({ ...rv, rating: v }); setDirty(true); }} /></Field>
            </div>
            <div className="row" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
              <button className="btn" disabled={busy} onClick={() => saveReview(false)}>Save draft</button>
              <button className="btn primary" disabled={busy} onClick={() => saveReview(true)}>Complete review</button>
            </div>
          </Card>
          <Card title="Rule adherence" icon={<Icon.shield />} sub="Mark each rule for today">
            <div className="list">
              {data.rules.map((r) => (
                <div key={r.id} className="list-item" style={{ alignItems: 'flex-start' }}>
                  <div className="grow small">{r.rule}<div className="tiny muted">{r.category}</div></div>
                  <div className="seg">
                    {[[true, '✓'], [false, '✗']].map(([v, l]) => (
                      <button key={l} type="button" aria-label={v ? 'Followed' : 'Broken'} className={rv.rules[r.id] === v ? 'on' : ''} style={rv.rules[r.id] === v ? { color: v ? 'var(--pos)' : 'var(--neg)' } : undefined}
                        onClick={() => { setRv({ ...rv, rules: { ...rv.rules, [r.id]: rv.rules[r.id] === v ? null : v } }); setDirty(true); }}>{l}</button>
                    ))}
                  </div>
                </div>
              ))}
              {data.rules.length === 0 && <p className="small muted">No rules yet. Add them under “Rules & checklist”.</p>}
            </div>
          </Card>
        </div>
      )}

      {tab === 'manage' && <ManageLists onChange={() => api.get(`/api/plans/${date}`).then(hydrate)} />}
    </>
  );
}

function EditableList({ title, items, field, onAdd, onUpdate, onDelete, placeholder, extra }) {
  const [text, setText] = useState('');
  const [editing, setEditing] = useState(null);
  return (
    <Card title={title}>
      <form className="row" style={{ marginBottom: 12, flexWrap: 'nowrap' }} onSubmit={(e) => { e.preventDefault(); if (text.trim()) { onAdd(text.trim()); setText(''); } }}>
        <input className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} />
        <button className="btn primary" type="submit"><Icon.plus />Add</button>
      </form>
      <div className="list">
        {items.map((it) => (
          <div className="list-item" key={it.id}>
            {editing?.id === it.id ? (
              <form className="row grow" style={{ flexWrap: 'nowrap' }} onSubmit={(e) => { e.preventDefault(); onUpdate(it.id, editing.text); setEditing(null); }}>
                <input className="input" autoFocus value={editing.text} onChange={(e) => setEditing({ ...editing, text: e.target.value })} />
                <button className="btn sm" type="submit">Save</button>
              </form>
            ) : (
              <>
                <div className="grow small" onDoubleClick={() => setEditing({ id: it.id, text: it[field] })}>{it[field]}{extra?.(it)}</div>
                <button className="btn sm ghost" onClick={() => setEditing({ id: it.id, text: it[field] })}>Edit</button>
                <button className="btn sm ghost danger" onClick={() => onDelete(it.id)} aria-label="Delete"><Icon.trash /></button>
              </>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}

function ManageLists({ onChange }) {
  const toast = useToast();
  const items = useLoad(() => api.get('/api/checklist/items'), []);
  const rules = useLoad(() => api.get('/api/rules'), []);
  const [cat, setCat] = useState('general');
  const run = async (p, reload) => { try { await p; reload(); onChange(); } catch (e) { toast(e.message, 'error'); } };
  return (
    <div className="grid g2">
      <EditableList title="Pre-trading checklist items" field="label" items={items.data?.items || []} placeholder="New checklist item"
        onAdd={(t) => run(api.post('/api/checklist/items', { label: t }), items.reload)}
        onUpdate={(id, t) => run(api.patch(`/api/checklist/items/${id}`, { label: t }), items.reload)}
        onDelete={(id) => run(api.del(`/api/checklist/items/${id}`), items.reload)} />
      <div className="stack">
        <EditableList title="Trading rules" field="rule" items={rules.data?.rules || []} placeholder="New trading rule"
          onAdd={(t) => run(api.post('/api/rules', { rule: t, category: cat }), rules.reload)}
          onUpdate={(id, t) => run(api.patch(`/api/rules/${id}`, { rule: t }), rules.reload)}
          onDelete={(id) => run(api.del(`/api/rules/${id}`), rules.reload)}
          extra={(r) => <span className="badge" style={{ marginLeft: 8 }}>{r.category}</span>} />
        <Field label="Category for new rules">
          <select className="input" value={cat} onChange={(e) => setCat(e.target.value)}>
            {['general', 'risk', 'execution', 'news', 'psychology'].map((c) => <option key={c}>{c}</option>)}
          </select>
        </Field>
      </div>
    </div>
  );
}
