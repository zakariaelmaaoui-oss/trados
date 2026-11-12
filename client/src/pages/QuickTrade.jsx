// Phone-first trade entry: big touch targets, recent symbols and lot sizes,
// times picked with one tap and profit computed where it can be exact.
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, qs } from '../api.js';
import { useAuth, PageHead } from '../App.jsx';
import { Card, Alert, Loading, Field, useToast } from '../components/ui.jsx';
import { Icon } from '../components/icons.jsx';
import { estimateProfit } from '../profit.js';
import { isoToLocalInput, localInputToIso, money, signClass } from '../format.js';

const DEFAULT_SYMBOLS = ['EURUSD', 'GBPUSD', 'XAUUSD', 'USDJPY', 'GBPJPY', 'US30', 'NAS100'];
const DEFAULT_LOTS = [0.01, 0.1, 0.5, 1];
const DURATIONS = [[5, '5m'], [15, '15m'], [30, '30m'], [60, '1h'], [120, '2h'], [240, '4h']];
const EMOTIONS = ['Calm', 'Confident', 'FOMO', 'Fearful', 'Revenge', 'Impatient'];
const LS = 'tradeos.quick.account';

const top = (arr, n) => Object.entries(arr.reduce((m, x) => ((m[x] = (m[x] || 0) + 1), m), {})).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);

export default function QuickTrade() {
  const { user } = useAuth();
  const toast = useToast();
  const nav = useNavigate();
  const tz = user.timezone;
  const [accounts, setAccounts] = useState(null);
  const [recent, setRecent] = useState([]);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(null);
  const blank = (keep = {}) => ({
    accountId: keep.accountId ?? '', symbol: keep.symbol ?? '', direction: keep.direction ?? 'buy', volume: keep.volume ?? '',
    openPrice: '', closePrice: '', stopLoss: '', profit: '', profitTouched: false, commission: '',
    closeTime: isoToLocalInput(new Date().toISOString(), tz), duration: 30, openTimeCustom: '',
    planFollowed: null, emotion: '', notes: '', ticket: '', more: false,
  });
  const [f, setF] = useState(blank());

  useEffect(() => {
    (async () => {
      try {
        const [a, t] = await Promise.all([api.get('/api/accounts'), api.get(`/api/trades${qs({ mode: user.activeMode })}`)]);
        const list = a.accounts.filter((x) => x.type === user.activeMode);
        setAccounts(list);
        setRecent(t.trades.slice(0, 200));
        let remembered = null;
        try { remembered = Number(localStorage.getItem(`${LS}.${user.activeMode}`)); } catch { /* ignore */ }
        const pick = list.find((x) => x.id === remembered) || list.find((x) => x.mt5Login) || list[0];
        setF((s) => ({ ...s, accountId: pick?.id ?? '' }));
      } catch (e) { setErr(e.message); }
    })();
  }, [user.activeMode]);

  const symbols = useMemo(() => { const r = top(recent.map((t) => t.symbol), 6); return [...r, ...DEFAULT_SYMBOLS.filter((s) => !r.includes(s))].slice(0, 7); }, [recent]);
  const lots = useMemo(() => { const r = top(recent.map((t) => String(t.volume)), 4).map(Number); return (r.length ? [...new Set([...r, ...DEFAULT_LOTS])] : DEFAULT_LOTS).slice(0, 5).sort((a, b) => a - b); }, [recent]);
  const account = accounts?.find((a) => a.id === Number(f.accountId));
  const est = estimateProfit({ symbol: f.symbol, direction: f.direction, volume: f.volume, openPrice: f.openPrice, closePrice: f.closePrice, accountCurrency: account?.currency });
  const profit = f.profitTouched ? f.profit : est ? String(est.profit) : f.profit;
  const net = profit !== '' && Number.isFinite(Number(profit)) ? Number(profit) + Number(f.commission || 0) : null;
  const closeIso = localInputToIso(f.closeTime, tz);
  const openIso = f.openTimeCustom ? localInputToIso(f.openTimeCustom, tz) : closeIso ? new Date(Date.parse(closeIso) - f.duration * 60000).toISOString() : null;
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  if (err && !accounts) return <><PageHead title="Quick trade" /><Alert kind="error">{err}</Alert></>;
  if (!accounts) return <><PageHead title="Quick trade" /><Loading /></>;
  if (accounts.length === 0) return <><PageHead title="Quick trade" /><Alert kind="warn">No {user.activeMode} account yet. <Link to="/settings">Connect MT5 or add an account in Settings</Link>, or switch mode.</Alert></>;

  const save = async () => {
    setErr(null);
    if (!f.symbol || !f.volume || !f.openPrice || !f.closePrice || profit === '') { setErr('Fill in symbol, lots, entry, exit and profit.'); return; }
    setBusy(true);
    try {
      const r = await api.post('/api/trades', {
        accountId: Number(f.accountId), symbol: f.symbol, direction: f.direction, volume: f.volume,
        openTime: openIso, closeTime: closeIso, openPrice: f.openPrice, closePrice: f.closePrice,
        stopLoss: f.stopLoss || null, profit, commission: f.commission || 0, swap: 0,
        planFollowed: f.planFollowed, emotion: f.emotion || null, notes: f.notes || null, ticket: f.ticket || null,
      });
      try { localStorage.setItem(`${LS}.${user.activeMode}`, String(f.accountId)); } catch { /* ignore */ }
      setSaved(r.trade);
      setRecent((x) => [r.trade, ...x]);
      toast('Trade saved');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  if (saved) {
    return (
      <>
        <PageHead title="Quick trade" />
        <Card className="feature">
          <div className="stack" style={{ alignItems: 'center', textAlign: 'center', padding: '10px 0' }}>
            <div className="icon-bubble" style={{ width: 54, height: 54 }}><Icon.check /></div>
            <h2>{saved.symbol} {saved.direction.toUpperCase()} saved</h2>
            <div className={`stat`}><span className={`value ${signClass(saved.netProfit)}`}>{money(saved.netProfit, account?.currency || 'USD', { sign: true })}</span>{saved.rMultiple !== null && <span className="hint">{saved.rMultiple}R</span>}</div>
            <p className="small muted">When MT5 on your PC syncs, this trade is completed with the exact MT5 data — no duplicate.</p>
            <div className="row" style={{ justifyContent: 'center' }}>
              <button className="btn primary" onClick={() => { setF(blank({ accountId: f.accountId, symbol: f.symbol, direction: f.direction, volume: f.volume })); setSaved(null); }}><Icon.plus />Add another</button>
              <button className="btn" onClick={() => nav(`/journal/${saved.id}`)}><Icon.image />Add screenshots</button>
            </div>
          </div>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHead title="Quick trade" sub="Log a closed trade in a few taps">
        <Link className="btn sm" to="/journal/new">Full form</Link>
      </PageHead>
      <div className="stack quick">
        {err && <Alert kind="error">{err}</Alert>}
        {accounts.length > 1 && (
          <Field label="Account">
            <select className="input" value={f.accountId} onChange={set('accountId')}>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </Field>
        )}

        <Card>
          <div className="stack" style={{ gap: 14 }}>
            <div className="seg big" role="group" aria-label="Direction">
              {['buy', 'sell'].map((d) => (
                <button key={d} type="button" className={`${f.direction === d ? 'on' : ''} ${d}`} aria-pressed={f.direction === d} onClick={() => setF({ ...f, direction: d })}>{d === 'buy' ? 'Buy' : 'Sell'}</button>
              ))}
            </div>
            <div>
              <div className="field-label">Symbol</div>
              <div className="chips">
                {symbols.map((s) => <button key={s} type="button" className={`chip big ${f.symbol === s ? 'on' : ''}`} aria-pressed={f.symbol === s} onClick={() => setF({ ...f, symbol: s })}>{s}</button>)}
              </div>
              <input className="input" style={{ marginTop: 8 }} placeholder="Other symbol" aria-label="Symbol" value={symbols.includes(f.symbol) ? '' : f.symbol} onChange={(e) => setF({ ...f, symbol: e.target.value.toUpperCase().trim() })} autoCapitalize="characters" />
            </div>
            <div>
              <div className="field-label">Lots</div>
              <div className="chips">
                {lots.map((l) => <button key={l} type="button" className={`chip big ${Number(f.volume) === l ? 'on' : ''}`} aria-pressed={Number(f.volume) === l} onClick={() => setF({ ...f, volume: String(l) })}>{l}</button>)}
                <input className="input chip-input" inputMode="decimal" placeholder="Other" aria-label="Lots" value={lots.includes(Number(f.volume)) ? '' : f.volume} onChange={set('volume')} />
              </div>
            </div>
          </div>
        </Card>

        <Card>
          <div className="grid g2" style={{ gap: 12 }}>
            <Field label="Entry price"><input className="input big" inputMode="decimal" value={f.openPrice} onChange={set('openPrice')} /></Field>
            <Field label="Exit price"><input className="input big" inputMode="decimal" value={f.closePrice} onChange={set('closePrice')} /></Field>
            <Field label="Stop loss (optional)"><input className="input" inputMode="decimal" value={f.stopLoss} onChange={set('stopLoss')} /></Field>
            <Field label={`Profit (${account?.currency || 'USD'})`} help={est && !f.profitTouched ? `Calculated · ${est.note}` : !est && !f.profitTouched ? 'Type the profit shown in MT5' : 'Typed by you'}>
              <input className="input big" inputMode="decimal" value={profit} onChange={(e) => setF({ ...f, profit: e.target.value, profitTouched: true })} />
            </Field>
            <Field label="Commission (optional)" help="Negative, e.g. -3.5"><input className="input" inputMode="decimal" value={f.commission} onChange={set('commission')} /></Field>
            {net !== null && <div className="stat" style={{ justifyContent: 'center' }}><span className="label">Net result</span><span className={`value ${signClass(net)}`}>{money(net, account?.currency || 'USD', { sign: true })}</span></div>}
          </div>
        </Card>

        <Card>
          <div className="stack" style={{ gap: 12 }}>
            <Field label="Closed at"><input className="input" type="datetime-local" value={f.closeTime} onChange={set('closeTime')} /></Field>
            <div>
              <div className="field-label">Held for</div>
              <div className="chips">
                {DURATIONS.map(([m, l]) => <button key={m} type="button" className={`chip big ${!f.openTimeCustom && f.duration === m ? 'on' : ''}`} onClick={() => setF({ ...f, duration: m, openTimeCustom: '' })}>{l}</button>)}
              </div>
              <input className="input" style={{ marginTop: 8 }} type="datetime-local" aria-label="Opened at" value={f.openTimeCustom} onChange={set('openTimeCustom')} />
              <div className="tiny muted" style={{ marginTop: 4 }}>{f.openTimeCustom ? 'Custom open time' : 'Or pick the exact open time'}</div>
            </div>
          </div>
        </Card>

        <Card>
          <div className="stack" style={{ gap: 12 }}>
            <div>
              <div className="field-label">Followed my plan?</div>
              <div className="seg big">
                {[[true, 'Yes'], [false, 'No']].map(([v, l]) => <button key={l} type="button" className={f.planFollowed === v ? 'on' : ''} onClick={() => setF({ ...f, planFollowed: f.planFollowed === v ? null : v })}>{l}</button>)}
              </div>
            </div>
            <div>
              <div className="field-label">Feeling</div>
              <div className="chips">{EMOTIONS.map((e) => <button key={e} type="button" className={`chip ${f.emotion === e ? 'on' : ''}`} onClick={() => setF({ ...f, emotion: f.emotion === e ? '' : e })}>{e}</button>)}</div>
            </div>
            <Field label="Notes"><textarea className="input" rows={2} aria-label="Notes" value={f.notes} onChange={set('notes')} placeholder="Why this trade?" /></Field>
            {f.more ? (
              <Field label="MT5 position # (optional)" help="From MT5 history; guarantees no duplicate when your PC syncs"><input className="input" inputMode="numeric" value={f.ticket} onChange={set('ticket')} /></Field>
            ) : <button type="button" className="btn sm ghost" style={{ alignSelf: 'flex-start' }} onClick={() => setF({ ...f, more: true })}>+ MT5 position number</button>}
          </div>
        </Card>

        <div className="save-bar">
          <button className="btn primary big" disabled={busy} onClick={save}>{busy ? 'Saving…' : `Save ${f.symbol || 'trade'}${net !== null ? ` · ${money(net, account?.currency || 'USD', { sign: true })}` : ''}`}</button>
        </div>
      </div>
    </>
  );
}
