import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth, PageHead } from '../App.jsx';
import { Card, Alert, Loading, Field, useToast } from '../components/ui.jsx';
import { Icon } from '../components/icons.jsx';
import { isoToLocalInput, localInputToIso, money, signClass } from '../format.js';

const EMOTIONS = ['Calm', 'Confident', 'Focused', 'Anxious', 'Fearful', 'Greedy', 'Impatient', 'Revenge', 'FOMO', 'Bored'];

export default function TradeEditor() {
  const { id } = useParams();
  const isNew = !id;
  const { user } = useAuth();
  const nav = useNavigate();
  const toast = useToast();
  const tz = user.timezone;
  const [accounts, setAccounts] = useState(null);
  const [trade, setTrade] = useState(null);
  const [f, setF] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [lightbox, setLightbox] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const a = await api.get('/api/accounts');
        setAccounts(a.accounts);
        if (isNew) {
          const first = a.accounts.find((x) => x.type === user.activeMode);
          setF({ accountId: first?.id ?? '', symbol: '', direction: 'buy', volume: '', openTime: isoToLocalInput(new Date().toISOString(), tz), closeTime: '', openPrice: '', closePrice: '', stopLoss: '', takeProfit: '', commission: '0', swap: '0', profit: '', riskPct: String(user.defaultRiskPct), riskAmount: '', setup: '', planFollowed: '', emotion: '', notes: '', ticket: '' });
        } else {
          const r = await api.get(`/api/trades/${id}`);
          load(r.trade);
        }
      } catch (e) { setErr(e.message); }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  function load(t) {
    setTrade(t);
    const s = (v) => (v === null || v === undefined ? '' : String(v));
    setF({ accountId: t.accountId, symbol: t.symbol, direction: t.direction, volume: s(t.volume), openTime: isoToLocalInput(t.openTime, tz), closeTime: isoToLocalInput(t.closeTime, tz), openPrice: s(t.openPrice), closePrice: s(t.closePrice), stopLoss: s(t.stopLoss), takeProfit: s(t.takeProfit), commission: s(t.commission), swap: s(t.swap), profit: s(t.profit), riskPct: s(t.riskPct), riskAmount: s(t.riskAmount), setup: s(t.setup), planFollowed: t.planFollowed === null ? '' : t.planFollowed ? '1' : '0', emotion: s(t.emotion), notes: s(t.notes), ticket: s(t.ticket) });
  }

  if (err && !f) return <><PageHead title="Trade" /><Alert kind="error">{err}</Alert></>;
  if (!f || !accounts || (!isNew && !trade)) return <><PageHead title="Trade" /><Loading /></>;

  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const account = accounts.find((a) => a.id === Number(f.accountId));
  const modeAccounts = accounts.filter((a) => (isNew ? a.type === user.activeMode : a.type === trade.accountType));
  const isClosed = !!f.closeTime;
  const netPreview = isClosed && f.profit !== '' ? Number(f.profit) + Number(f.commission || 0) + Number(f.swap || 0) : null;

  const save = async (e) => {
    e.preventDefault();
    setErr(null); setBusy(true);
    const nz = (v) => (v === '' ? null : v);
    const body = {
      accountId: Number(f.accountId), symbol: f.symbol, direction: f.direction, volume: f.volume,
      openTime: localInputToIso(f.openTime, tz), closeTime: f.closeTime ? localInputToIso(f.closeTime, tz) : null,
      openPrice: f.openPrice, closePrice: nz(f.closePrice), stopLoss: nz(f.stopLoss), takeProfit: nz(f.takeProfit),
      commission: f.commission || 0, swap: f.swap || 0, profit: nz(f.profit), riskPct: f.riskPct,
      setup: f.setup, planFollowed: f.planFollowed === '' ? null : f.planFollowed === '1', emotion: f.emotion, notes: f.notes, ticket: nz(f.ticket),
    };
    if (f.riskAmount !== '' && (isNew || Number(f.riskAmount) !== trade.riskAmount)) body.riskAmount = f.riskAmount;
    try {
      const r = isNew ? await api.post('/api/trades', body) : await api.patch(`/api/trades/${id}`, body);
      toast(isNew ? 'Trade saved' : 'Trade updated');
      load(r.trade);
      if (isNew) nav(`/journal/${r.trade.id}`, { replace: true });
    } catch (ex) { setErr(ex.message); } finally { setBusy(false); }
  };

  const remove = async () => {
    if (!confirm('Delete this trade and its screenshots? This cannot be undone.')) return;
    try { await api.del(`/api/trades/${id}`); toast('Trade deleted'); nav('/journal'); } catch (ex) { setErr(ex.message); }
  };

  if (modeAccounts.length === 0) {
    return <><PageHead title="New trade" /><Alert kind="warn">You have no {user.activeMode} account yet. <Link to="/settings">Create one in Settings</Link>, or switch mode.</Alert></>;
  }

  return (
    <>
      <PageHead title={isNew ? 'New trade' : `${trade.symbol} ${trade.direction.toUpperCase()}`} sub={isNew ? `Recording into a ${user.activeMode} account` : `${trade.accountName} · ${trade.accountType.toUpperCase()}${trade.source === 'mt5_csv' ? ' · imported from MT5' : ''}${trade.corrected ? ' · manually corrected' : ''}`}>
        <Link className="btn" to="/journal">Back</Link>
      </PageHead>
      <form onSubmit={save} className="stack">
        {err && <Alert kind="error">{err}</Alert>}
        {trade?.source === 'mt5_csv' && <Alert kind="info">This trade was imported from MT5. Editing market data (prices, times, P&L) marks it as a manual correction.</Alert>}
        <div className="grid g3">
          <Card className="span2" title="Execution">
            <div className="form-grid">
              <Field label="Account">
                <select className="input" value={f.accountId} onChange={set('accountId')} required>
                  {modeAccounts.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.type})</option>)}
                </select>
              </Field>
              <Field label="Symbol"><input className="input" required value={f.symbol} onChange={(e) => setF({ ...f, symbol: e.target.value.toUpperCase() })} placeholder="EURUSD" /></Field>
              <Field label="Direction">
                <div className="seg" style={{ width: 'fit-content' }}>
                  {['buy', 'sell'].map((d) => <button type="button" key={d} className={f.direction === d ? 'on' : ''} onClick={() => setF({ ...f, direction: d })}>{d === 'buy' ? 'Buy' : 'Sell'}</button>)}
                </div>
              </Field>
              <Field label="Volume (lots)"><input className="input" required inputMode="decimal" value={f.volume} onChange={set('volume')} /></Field>
              <Field label="Open time" help={`Your timezone: ${tz}`}><input className="input" type="datetime-local" required value={f.openTime} onChange={set('openTime')} /></Field>
              <Field label="Open price"><input className="input" required inputMode="decimal" value={f.openPrice} onChange={set('openPrice')} /></Field>
              <Field label="Stop loss"><input className="input" inputMode="decimal" value={f.stopLoss} onChange={set('stopLoss')} /></Field>
              <Field label="Take profit"><input className="input" inputMode="decimal" value={f.takeProfit} onChange={set('takeProfit')} /></Field>
              <Field label="Close time" help="Leave empty for an open trade"><input className="input" type="datetime-local" value={f.closeTime} onChange={set('closeTime')} /></Field>
              <Field label="Close price"><input className="input" inputMode="decimal" value={f.closePrice} onChange={set('closePrice')} required={isClosed} /></Field>
              <Field label={`Profit (${account?.currency || 'USD'})`} help="Gross, before costs"><input className="input" inputMode="decimal" value={f.profit} onChange={set('profit')} required={isClosed} /></Field>
              <Field label="Commission"><input className="input" inputMode="decimal" value={f.commission} onChange={set('commission')} /></Field>
              <Field label="Swap"><input className="input" inputMode="decimal" value={f.swap} onChange={set('swap')} /></Field>
              <Field label="Ticket / position ID"><input className="input" value={f.ticket} onChange={set('ticket')} /></Field>
            </div>
          </Card>
          <div className="stack">
            <Card title="Risk">
              <div className="stack" style={{ gap: 12 }}>
                <Field label="Risk %" help={`Your default is ${user.defaultRiskPct}%`}><input className="input" inputMode="decimal" value={f.riskPct} onChange={set('riskPct')} required /></Field>
                <Field label="Risk amount" help="Leave blank to calculate from the account balance at entry"><input className="input" inputMode="decimal" value={f.riskAmount} onChange={set('riskAmount')} placeholder="auto" /></Field>
                {netPreview !== null && (
                  <div className="row between"><span className="small text-2">Net result</span><b className={signClass(netPreview)}>{money(netPreview, account?.currency || 'USD', { sign: true })}{trade?.rMultiple !== null && trade?.rMultiple !== undefined ? ` · ${trade.rMultiple}R` : ''}</b></div>
                )}
              </div>
            </Card>
            <Card title="Discipline">
              <div className="stack" style={{ gap: 12 }}>
                <Field label="Taken according to plan?">
                  <select className="input" value={f.planFollowed} onChange={set('planFollowed')}>
                    <option value="">Not set</option><option value="1">Yes — followed my plan</option><option value="0">No — broke my plan</option>
                  </select>
                </Field>
                <Field label="Setup"><input className="input" value={f.setup} onChange={set('setup')} placeholder="e.g. London breakout" /></Field>
                <Field label="Emotion">
                  <select className="input" value={f.emotion} onChange={set('emotion')}>
                    <option value="">—</option>{EMOTIONS.map((e) => <option key={e}>{e}</option>)}
                  </select>
                </Field>
              </div>
            </Card>
          </div>
        </div>
        <Card title="Notes"><textarea className="input" aria-label="Notes" rows={5} value={f.notes} onChange={set('notes')} placeholder="Why did you take this trade? What did you see? What would you do differently?" /></Card>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          {!isNew && <button type="button" className="btn danger" onClick={remove}><Icon.trash />Delete</button>}
          <button className="btn primary" disabled={busy} type="submit">{busy ? 'Saving…' : isNew ? 'Save trade' : 'Save changes'}</button>
        </div>
      </form>
      {!isNew && (
        <div className="grid g2" style={{ marginTop: 16 }}>
          {['before', 'after'].map((k) => <Screenshots key={k} kind={k} trade={trade} onChange={load} onOpen={setLightbox} />)}
        </div>
      )}
      {isNew && <p className="muted small" style={{ marginTop: 12 }}>Save the trade first, then add before/after screenshots.</p>}
      {lightbox && <div className="lightbox" onClick={() => setLightbox(null)}><img src={lightbox} alt="Screenshot" /></div>}
    </>
  );
}

function Screenshots({ kind, trade, onChange, onOpen }) {
  const toast = useToast();
  const input = useRef();
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const shots = trade.screenshots.filter((s) => s.kind === kind);
  const upload = async (files) => {
    setBusy(true);
    try {
      for (const file of files) {
        if (file.size > 5 * 1024 * 1024) { toast(`${file.name} is larger than 5 MB`, 'error'); continue; }
        await api.upload(`/api/trades/${trade.id}/screenshots?kind=${kind}`, file);
      }
      const r = await api.get(`/api/trades/${trade.id}`);
      onChange(r.trade);
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  };
  const remove = async (sid) => {
    try { await api.del(`/api/screenshots/${sid}`); const r = await api.get(`/api/trades/${trade.id}`); onChange(r.trade); } catch (e) { toast(e.message, 'error'); }
  };
  return (
    <Card title={kind === 'before' ? 'Before screenshot' : 'After screenshot'} icon={<Icon.image />} sub={kind === 'before' ? 'Your chart at entry' : 'How the trade played out'}>
      <div className="stack" style={{ gap: 12 }}>
        {shots.length > 0 && (
          <div className="shots">
            {shots.map((s) => (
              <div className="shot" key={s.id}>
                <img src={`/api/screenshots/${s.id}`} alt={`${kind} screenshot`} onClick={() => onOpen(`/api/screenshots/${s.id}`)} />
                <button className="btn sm x" type="button" onClick={() => remove(s.id)} aria-label="Remove screenshot"><Icon.x /></button>
              </div>
            ))}
          </div>
        )}
        <div className={`dropzone ${over ? 'over' : ''}`} onClick={() => input.current.click()} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); upload([...e.dataTransfer.files]); }} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && input.current.click()}>
          <div className="small text-2">{busy ? 'Uploading…' : 'Drop an image here or click to choose'}</div>
          <div className="tiny muted">PNG, JPEG, WebP or GIF · max 5 MB</div>
          <input ref={input} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden onChange={(e) => { upload([...e.target.files]); e.target.value = ''; }} />
        </div>
      </div>
    </Card>
  );
}
