import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth, PageHead } from '../App.jsx';
import { Card, Alert, Field, Switch, useLoad, useToast, Loading } from '../components/ui.jsx';
import { Icon } from '../components/icons.jsx';
import { pushSupport, permissionState, currentSubscription, enablePush, disablePushOnThisDevice } from '../push.js';
import { fmtDateTime } from '../format.js';

export default function Settings() {
  useEffect(() => { if (location.hash) document.querySelector(location.hash)?.scrollIntoView(); }, []);
  return (
    <>
      <PageHead title="Settings" />
      <div className="stack">
        <div className="grid g2"><Profile /><Accounts /></div>
        <div id="mt5-sync"><Mt5Sync /></div>
        <Notifications />
      </div>
    </>
  );
}

function Profile() {
  const { user, setUser } = useAuth();
  const toast = useToast();
  const [f, setF] = useState({ displayName: user.displayName, defaultRiskPct: String(user.defaultRiskPct), timezone: user.timezone });
  const [err, setErr] = useState(null);
  const save = async (e) => {
    e.preventDefault(); setErr(null);
    try { const r = await api.patch('/api/me', f); setUser(r.user); toast('Profile saved'); } catch (ex) { setErr(ex.message); }
  };
  return (
    <Card title="Profile & risk" icon={<Icon.settings />}>
      <form className="stack" onSubmit={save}>
        {err && <Alert kind="error">{err}</Alert>}
        <Field label="Name"><input className="input" value={f.displayName} onChange={(e) => setF({ ...f, displayName: e.target.value })} /></Field>
        <Field label="Default risk per trade (%)" help="Used to pre-fill new trades and imported trades. Default is 1%."><input className="input" inputMode="decimal" value={f.defaultRiskPct} onChange={(e) => setF({ ...f, defaultRiskPct: e.target.value })} /></Field>
        <Field label="Timezone" help="All dates, plans and news times use this zone.">
          <select className="input" value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })}>
            {['Africa/Casablanca', 'UTC', 'Europe/London', 'Europe/Paris', 'America/New_York', 'Asia/Dubai', 'Asia/Tokyo'].map((t) => <option key={t}>{t}</option>)}
          </select>
        </Field>
        <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn primary" type="submit">Save</button></div>
      </form>
    </Card>
  );
}

function deviceName(ua = '') {
  if (!ua) return 'Unknown browser';
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'Device';
  const br = /Edg\//.test(ua) ? 'Edge' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /FxiOS|Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return `${os} · ${br}`;
}

const OFFSETS = Array.from({ length: 27 }, (_, i) => (i - 12) * 60);
const fmtOffset = (m) => `UTC${m >= 0 ? '+' : '−'}${String(Math.floor(Math.abs(m) / 60)).padStart(2, '0')}:00`;

function Accounts() {
  const toast = useToast();
  const { data, reload } = useLoad(() => api.get('/api/accounts'), []);
  const blank = { name: '', type: 'demo', broker: '', currency: 'USD', startingBalance: '', serverUtcOffsetMin: 120 };
  const [f, setF] = useState(null);
  const [err, setErr] = useState(null);
  const save = async (e) => {
    e.preventDefault(); setErr(null);
    try {
      const body = { ...f, startingBalance: f.startingBalance || 0, serverUtcOffsetMin: Number(f.serverUtcOffsetMin) };
      if (f.id) await api.patch(`/api/accounts/${f.id}`, body); else await api.post('/api/accounts', body);
      toast('Account saved'); setF(null); reload();
    } catch (ex) { setErr(ex.message); }
  };
  const del = async (a) => {
    if (!confirm(`Delete "${a.name}" and ALL its trades? This cannot be undone.`)) return;
    try { await api.del(`/api/accounts/${a.id}`); toast('Account deleted'); reload(); } catch (ex) { toast(ex.message, 'error'); }
  };
  return (
    <Card title="Trading accounts" icon={<Icon.shield />} sub="Demo and Live accounts are kept strictly separate" action={!f && <button className="btn sm" onClick={() => setF(blank)}><Icon.plus />Add</button>}>
      {f ? (
        <form className="stack" onSubmit={save}>
          {err && <Alert kind="error">{err}</Alert>}
          <div className="form-grid">
            <Field label="Name"><input className="input" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label="Type" help={f.id ? 'Cannot change once the account has trades' : undefined}>
              <select className="input" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}><option value="demo">Demo</option><option value="live">Live</option></select>
            </Field>
            <Field label="Broker"><input className="input" value={f.broker || ''} onChange={(e) => setF({ ...f, broker: e.target.value })} /></Field>
            <Field label="Currency"><input className="input" maxLength={3} value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value.toUpperCase() })} /></Field>
            <Field label="Starting balance"><input className="input" inputMode="decimal" value={f.startingBalance} onChange={(e) => setF({ ...f, startingBalance: e.target.value })} /></Field>
            <Field label="MT5 server time" help="Most brokers use UTC+2 (winter) / UTC+3 (summer)">
              <select className="input" value={f.serverUtcOffsetMin} onChange={(e) => setF({ ...f, serverUtcOffsetMin: e.target.value })}>{OFFSETS.map((o) => <option key={o} value={o}>{fmtOffset(o)}</option>)}</select>
            </Field>
          </div>
          <div className="row" style={{ justifyContent: 'flex-end' }}><button type="button" className="btn" onClick={() => setF(null)}>Cancel</button><button className="btn primary" type="submit">Save account</button></div>
        </form>
      ) : (
        <div className="list">
          {(data?.accounts || []).map((a) => (
            <div className="list-item" key={a.id}>
              <span className={`badge ${a.type}`}>{a.type.toUpperCase()}</span>
              <div className="grow"><div style={{ fontWeight: 600 }}>{a.name}</div><div className="tiny muted">{a.broker || 'No broker'} · {a.currency} · start {a.startingBalance} · server {fmtOffset(a.serverUtcOffsetMin)}</div></div>
              <button className="btn sm ghost" onClick={() => setF({ ...a, startingBalance: String(a.startingBalance) })}>Edit</button>
              <button className="btn sm ghost danger" onClick={() => del(a)} aria-label="Delete account"><Icon.trash /></button>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function Mt5Sync() {
  const toast = useToast();
  const { user } = useAuth();
  const accounts = useLoad(() => api.get('/api/accounts'), []);
  const all = accounts.data?.accounts || [];
  const [accountId, setAccountId] = useState('');
  const acc = all.find((a) => a.id === Number(accountId)) || all.find((a) => a.type === user.activeMode) || all[0];
  const keys = useLoad(() => (acc ? api.get(`/api/accounts/${acc.id}/sync-keys`) : Promise.resolve({ keys: [] })), [acc?.id]);
  const [newKey, setNewKey] = useState(null);
  const [busy, setBusy] = useState(false);
  const site = window.location.origin;
  useEffect(() => { setNewKey(null); }, [acc?.id]);

  const create = async () => {
    setBusy(true);
    try { const r = await api.post(`/api/accounts/${acc.id}/sync-keys`); setNewKey(r.key); keys.reload(); }
    catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  };
  const revoke = async (k) => {
    if (!confirm('Revoke this key? The EA using it will stop syncing.')) return;
    try { await api.del(`/api/sync-keys/${k.id}`); keys.reload(); toast('Key revoked'); } catch (e) { toast(e.message, 'error'); }
  };
  const copy = async (text) => {
    try { await navigator.clipboard.writeText(text); toast('Copied'); } catch { toast('Select the text and copy it manually', 'error'); }
  };
  if (!acc) return null;
  return (
    <Card title="MT5 auto-sync" icon={<Icon.refresh />} sub="Every position you close in MetaTrader 5 appears in your journal automatically">
      <div className="grid g2">
        <div className="stack">
          <Field label="TradeOS account to sync into">
            <select className="input" value={acc.id} onChange={(e) => setAccountId(e.target.value)}>
              {all.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.type.toUpperCase()})</option>)}
            </select>
          </Field>
          <Alert kind="info">Use a <b>{acc.type === 'live' ? 'LIVE' : 'DEMO'}</b> MT5 account with this key. TradeOS refuses trades from a {acc.type === 'live' ? 'demo' : 'real'} MT5 account so Demo and Live never mix.</Alert>
          {newKey ? (
            <div className="stack" style={{ gap: 8 }}>
              <Alert kind="warn">Copy this key now — it is shown only once.</Alert>
              <div className="row" style={{ flexWrap: 'nowrap' }}>
                <input className="input mono" readOnly value={newKey} onFocus={(e) => e.target.select()} aria-label="Sync key" />
                <button className="btn" type="button" onClick={() => copy(newKey)}>Copy</button>
              </div>
            </div>
          ) : (
            <button className="btn primary" disabled={busy} onClick={create}><Icon.plus />Create sync key</button>
          )}
          <div>
            <div className="small" style={{ fontWeight: 600, marginBottom: 6 }}>Connected keys</div>
            {(keys.data?.keys || []).length === 0 ? <p className="small muted">No keys yet for this account.</p> : (
              <div className="list">
                {keys.data.keys.map((k) => (
                  <div className="list-item" key={k.id}>
                    <span className={`dot`} style={{ background: k.lastUsedAt && Date.now() - Date.parse(k.lastUsedAt) < 15 * 60e3 ? 'var(--pos)' : 'var(--low)' }} />
                    <div className="grow" style={{ minWidth: 0 }}>
                      <div className="small mono">tos_…{k.hint}{k.mt5Login ? ` · MT5 ${k.mt5Login}` : ''}</div>
                      <div className="tiny muted" style={{ overflowWrap: 'anywhere' }}>
                        {k.lastUsedAt ? `Last sync ${fmtDateTime(k.lastUsedAt, user.timezone)} · ${k.lastImported ?? 0} new` : 'Waiting for the EA to connect…'}{k.mt5Server ? ` · ${k.mt5Server}` : ''}
                      </div>
                    </div>
                    <button className="btn sm ghost danger" onClick={() => revoke(k)}>Revoke</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="stack" style={{ gap: 10 }}>
          <div className="small" style={{ fontWeight: 600 }}>Setup on your PC (MT5 must stay open)</div>
          <ol className="small text-2" style={{ paddingLeft: 18, margin: 0, display: 'grid', gap: 8 }}>
            <li><a href="/downloads/TradeOS_Sync.mq5" download>Download TradeOS_Sync.mq5</a>.</li>
            <li>In MT5: <b>File → Open Data Folder</b> → open <b>MQL5 → Experts</b> → paste the file there. In the Navigator, right-click <b>Expert Advisors → Refresh</b>.</li>
            <li><b>Tools → Options → Expert Advisors</b>: tick <b>Allow WebRequest for listed URL</b> and add <span className="mono" style={{ overflowWrap: 'anywhere' }}>{site}</span> <button className="btn sm ghost" type="button" onClick={() => copy(site)}>Copy</button></li>
            <li>Drag <b>TradeOS_Sync</b> onto any one chart. In <b>Inputs</b>, paste your sync key in <b>InpKey</b> (and check <b>InpUrl</b> is {site}). Click OK.</li>
            <li>Turn on <b>Algo Trading</b>. The chart shows “Connected to TradeOS”. Closed positions from the last 30 days are imported, then every new close within about a minute.</li>
          </ol>
          <p className="tiny muted">The EA only reads your history — it never opens, changes or closes trades. Positions already imported by CSV are not duplicated.</p>
        </div>
      </div>
    </Card>
  );
}

function Notifications() {
  const toast = useToast();
  const prefs = useLoad(() => api.get('/api/notifications/prefs'), []);
  const history = useLoad(() => api.get('/api/notifications/history'), []);
  const devices = useLoad(() => api.get('/api/push/subscriptions'), []);
  const support = pushSupport();
  const [perm, setPerm] = useState(permissionState());
  const [sub, setSub] = useState(undefined);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  useEffect(() => { currentSubscription().then(setSub).catch(() => setSub(null)); }, []);

  const p = prefs.data?.prefs;
  const update = async (patch) => {
    try { const r = await api.put('/api/notifications/prefs', patch); prefs.setData({ prefs: r.prefs }); } catch (e) { toast(e.message, 'error'); }
  };
  const enable = async () => {
    setBusy(true); setErr(null);
    try { const s = await enablePush(); setSub(s); setPerm(permissionState()); if (!p.enabled) await update({ enabled: true }); devices.reload(); toast('Notifications enabled on this device'); }
    catch (e) { setErr(e.message); setPerm(permissionState()); } finally { setBusy(false); }
  };
  const disableDevice = async () => {
    setBusy(true);
    try { await disablePushOnThisDevice(); setSub(null); devices.reload(); toast('Notifications disabled on this device'); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const test = async () => {
    try { const r = await api.post('/api/notifications/test'); toast(r.sent ? `Test sent to ${r.sent} device(s)` : 'Test could not be delivered', r.sent ? 'info' : 'error'); history.reload(); devices.reload(); }
    catch (e) { toast(e.message, 'error'); }
  };
  const removeDevice = async (id) => { try { await api.del(`/api/push/subscriptions/${id}`); devices.reload(); } catch (e) { toast(e.message, 'error'); } };

  if (!p) return <Card title="Notifications"><Loading /></Card>;
  const statusLine = !support.supported ? null : perm === 'denied' ? 'blocked' : sub ? 'on' : 'off';
  return (
    <div id="notifications" className="grid g2">
      <Card title="Economic news notifications" icon={<Icon.bell />} sub="Browser Web Push · times in your timezone">
        <div className="stack">
          {!support.supported && <Alert kind="warn">Web Push isn't available here: {support.reason} You can still use the calendar normally.</Alert>}
          {support.supported && (
            <div className="row between" style={{ padding: 14, borderRadius: 14, background: 'var(--surface-2)' }}>
              <div>
                <div style={{ fontWeight: 600 }}>This device</div>
                <div className="small muted">{statusLine === 'on' ? 'Receiving notifications' : statusLine === 'blocked' ? 'Blocked in browser settings' : 'Not enabled'}</div>
              </div>
              {statusLine === 'on' ? (
                <div className="row"><button className="btn sm" onClick={test}>Send test</button><button className="btn sm danger" disabled={busy} onClick={disableDevice}>Disable</button></div>
              ) : (
                <button className="btn primary" disabled={busy || sub === undefined} onClick={enable}><Icon.bell />{busy ? 'Enabling…' : 'Enable Notifications'}</button>
              )}
            </div>
          )}
          {perm === 'denied' && <Alert kind="warn">Notifications are blocked for this site. Open your browser's site settings, allow notifications, then click Enable again.</Alert>}
          {err && <Alert kind="error">{err}</Alert>}
          <div className="toggle-row"><div><div style={{ fontWeight: 600 }}>All news notifications</div><div className="small muted">Master switch for every device</div></div><Switch checked={p.enabled} onChange={(v) => update({ enabled: v })} label="All news notifications" /></div>
          <div style={{ opacity: p.enabled ? 1 : 0.5, pointerEvents: p.enabled ? 'auto' : 'none' }}>
            <h3 style={{ margin: '8px 0 4px' }}>Impact</h3>
            {[['high', 'High impact'], ['medium', 'Medium impact'], ['low', 'Low impact']].map(([k, l]) => (
              <div className="toggle-row" key={k}><span className="row"><span className={`dot ${k}`} />{l}</span><Switch checked={p.impacts[k]} onChange={(v) => update({ impacts: { [k]: v } })} label={l} /></div>
            ))}
            <h3 style={{ margin: '14px 0 4px' }}>Schedule</h3>
            {[['t30', '30 minutes before'], ['t15', '15 minutes before'], ['release', 'At scheduled release time']].map(([k, l]) => (
              <div className="toggle-row" key={k}><span>{l}</span><Switch checked={p.alerts[k]} onChange={(v) => update({ alerts: { [k]: v } })} label={l} /></div>
            ))}
            <div className="toggle-row">
              <span>Daily upcoming-news briefing</span>
              <div className="row"><input className="input" type="time" value={p.briefingTime} onChange={(e) => e.target.value && update({ briefingTime: e.target.value })} style={{ width: 132, height: 34 }} aria-label="Briefing time" disabled={!p.dailyBriefing} /><Switch checked={p.dailyBriefing} onChange={(v) => update({ dailyBriefing: v })} label="Daily briefing" /></div>
            </div>
            <h3 style={{ margin: '14px 0 8px' }}>Currencies</h3>
            <div className="chips">
              {p.availableCurrencies.map((c) => {
                const on = p.currencies.includes(c);
                return <button key={c} type="button" className={`chip ${on ? 'on' : ''}`} aria-pressed={on} onClick={() => update({ currencies: on ? p.currencies.filter((x) => x !== c) : [...p.currencies, c] })}>{c}</button>;
              })}
            </div>
          </div>
        </div>
      </Card>
      <div className="stack">
        <Card title="Devices" sub="Browsers subscribed to your alerts">
          {(devices.data?.subscriptions || []).length === 0 ? <p className="small muted">No devices subscribed.</p> : (
            <div className="list">{devices.data.subscriptions.map((d) => (
              <div className="list-item" key={d.id}>
                <div className="grow" style={{ minWidth: 0 }}><div className="small ellipsis" title={d.user_agent || ''}>{deviceName(d.user_agent)}</div>
                  <div className="tiny muted" style={{ overflowWrap: 'anywhere' }}>{d.active ? 'Active' : 'Inactive'} · last delivery {d.last_success_at ? fmtDateTime(d.last_success_at) : 'never'}{d.last_error ? ` · ${d.last_error}` : ''}</div></div>
                <button className="btn sm ghost danger" onClick={() => removeDevice(d.id)} aria-label="Remove device"><Icon.trash /></button>
              </div>))}
            </div>
          )}
        </Card>
        <Card title="Notification history" action={<button className="btn sm ghost" onClick={history.reload}><Icon.refresh /></button>}>
          {(history.data?.notifications || []).length === 0 ? <p className="small muted">No notifications sent yet.</p> : (
            <div className="list" style={{ maxHeight: 420, overflowY: 'auto' }}>{history.data.notifications.map((n) => (
              <div className="list-item" key={n.id} style={{ alignItems: 'flex-start' }}>
                <span className={`badge ${n.status === 'sent' ? 'pos' : n.status === 'failed' ? 'neg' : n.status === 'partial' ? 'warn' : ''}`}>{n.status.replace('_', ' ')}</span>
                <div className="grow"><div className="small" style={{ fontWeight: 600 }}>{n.title}</div><div className="tiny muted" style={{ whiteSpace: 'pre-line' }}>{n.body}</div>
                  <div className="tiny muted">{fmtDateTime(n.sent_at || n.created_at)}{n.attempts > 1 ? ` · ${n.attempts} attempts` : ''}{n.last_error && n.status !== 'sent' ? ` · ${n.last_error}` : ''}</div></div>
              </div>))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
