import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, qs } from '../api.js';
import { useAuth, PageHead } from '../App.jsx';
import { Card, Alert, Field, useLoad, useToast, Stat } from '../components/ui.jsx';
import { Icon } from '../components/icons.jsx';
import { money, fmtDateTime, signClass } from '../format.js';

const fmtOffset = (m) => `UTC${m >= 0 ? '+' : '−'}${String(Math.floor(Math.abs(m) / 60)).padStart(2, '0')}:${String(Math.abs(m) % 60).padStart(2, '0')}`;

export default function ImportPage() {
  const { user } = useAuth();
  const toast = useToast();
  const accounts = useLoad(() => api.get('/api/accounts'), []);
  const history = useLoad(() => api.get('/api/imports'), []);
  const [accountId, setAccountId] = useState('');
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const input = useRef();
  const all = accounts.data?.accounts || [];
  const modeAccounts = all.filter((a) => a.type === user.activeMode);
  const acc = all.find((a) => a.id === Number(accountId)) || modeAccounts[0];

  const analyse = async (fl, a = acc) => {
    setErr(null); setPreview(null); setFile(fl);
    if (!fl || !a) return;
    setBusy(true);
    try { setPreview(await api.upload(`/api/imports/preview${qs({ account: a.id })}`, fl, { 'Content-Type': 'text/csv' })); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const commit = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api.upload(`/api/imports/commit${qs({ account: acc.id })}`, file, { 'Content-Type': 'text/csv', 'X-File-Name': encodeURIComponent(file.name) });
      toast(`Imported ${r.imported} trades into ${acc.name}`);
      setPreview(null); setFile(null); history.reload();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  const rows = preview ? (showAll ? preview.rows : preview.rows.filter((r) => r.errors.length || r.duplicate).concat(preview.rows.filter((r) => !r.errors.length && !r.duplicate)).slice(0, 50)) : [];

  return (
    <>
      <PageHead title="MT5 CSV Import" sub="Import closed positions from MetaTrader 5 history" />
      <div className="grid g3">
        <div className="span2 stack">
          <Card title="1. Choose the target account" icon={<Icon.shield />} sub="Demo and Live trades are stored separately — pick carefully.">
            {modeAccounts.length === 0 ? <Alert kind="warn">No {user.activeMode} accounts. <Link to="/settings">Create one</Link> or switch mode.</Alert> : (
              <div className="form-grid">
                <Field label="Account">
                  <select className="input" value={acc?.id || ''} onChange={(e) => { setAccountId(e.target.value); const a = all.find((x) => x.id === Number(e.target.value)); if (file) analyse(file, a); }}>
                    {modeAccounts.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.type.toUpperCase()})</option>)}
                  </select>
                </Field>
                <Field label="Broker server time" help="MT5 exports times in broker server time. Change in Settings → Accounts.">
                  <input className="input" readOnly value={acc ? fmtOffset(acc.serverUtcOffsetMin) : ''} />
                </Field>
              </div>
            )}
          </Card>
          <Card title="2. Upload the CSV" icon={<Icon.upload />}>
            <div className={`dropzone ${over ? 'over' : ''}`} onClick={() => input.current.click()} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
              onDrop={(e) => { e.preventDefault(); setOver(false); analyse(e.dataTransfer.files[0]); }} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && input.current.click()}>
              <Icon.upload width={28} height={28} style={{ color: 'var(--accent)' }} />
              <div style={{ fontWeight: 600, marginTop: 6 }}>{file ? file.name : 'Drop your MT5 history CSV here'}</div>
              <div className="small muted">or click to choose · comma, semicolon or tab separated · UTF-8 or UTF-16</div>
              <input ref={input} type="file" accept=".csv,.txt,text/csv,text/plain" hidden onChange={(e) => { analyse(e.target.files[0]); e.target.value = ''; }} />
            </div>
            {busy && <p className="muted small" style={{ marginTop: 10 }}>Validating…</p>}
            {err && <div style={{ marginTop: 12 }}><Alert kind="error">{err}</Alert></div>}
          </Card>
          {preview && (
            <Card title="3. Review & confirm" icon={<Icon.check />} sub={`Detected MT5 positions table · ${preview.delimiter}-separated`}>
              <div className="grid g4" style={{ marginBottom: 14 }}>
                <Stat label="Rows" value={preview.summary.total} />
                <Stat label="Will import" value={preview.summary.toImport} className="pos" />
                <Stat label="Duplicates" value={preview.summary.duplicates} hint="Already in this account" />
                <Stat label="Invalid" value={preview.summary.invalid} className={preview.summary.invalid ? 'neg' : ''} />
              </div>
              {preview.summary.invalid > 0 && <div style={{ marginBottom: 12 }}><Alert kind="warn">Invalid rows are skipped. Fix them in the CSV and re-import — already-imported trades are never duplicated.</Alert></div>}
              <div className="table-wrap"><table className="table">
                <thead><tr><th>Line</th><th>Ticket</th><th>Symbol</th><th>Side</th><th className="num">Lots</th><th>Open (local)</th><th>Close (local)</th><th className="num">Net</th><th>Status</th></tr></thead>
                <tbody>{rows.map((r) => {
                  const t = r.trade;
                  const n = t.profit !== null ? t.profit + (t.commission || 0) + (t.swap || 0) : null;
                  return (
                    <tr key={r.line} className={r.errors.length ? 'err' : r.duplicate ? 'dup' : ''}>
                      <td className="mono">{r.line}</td><td className="mono">{t.ticket || '—'}</td><td>{t.symbol || '—'}</td><td>{t.direction || '—'}</td>
                      <td className="num">{t.volume ?? '—'}</td>
                      <td className="small nowrap">{t.open_time ? fmtDateTime(t.open_time, user.timezone) : '—'}</td>
                      <td className="small nowrap">{t.close_time ? fmtDateTime(t.close_time, user.timezone) : '—'}</td>
                      <td className={`num ${signClass(n)}`}>{n === null ? '—' : money(n, acc?.currency)}</td>
                      <td className="small">{r.errors.length ? <span className="neg">{r.errors.join('; ')}</span> : r.duplicate ? <span className="badge warn">Duplicate</span> : <span className="badge pos">OK</span>}</td>
                    </tr>);
                })}</tbody>
              </table></div>
              {preview.rows.length > 50 && <button className="btn sm ghost" onClick={() => setShowAll(!showAll)}>{showAll ? 'Show fewer' : `Show all ${preview.rows.length} rows`}</button>}
              <div className="row" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
                <button className="btn" onClick={() => { setPreview(null); setFile(null); }}>Cancel</button>
                <button className="btn primary" disabled={busy || preview.summary.toImport === 0} onClick={commit}>Import {preview.summary.toImport} trades into {acc?.name}</button>
              </div>
            </Card>
          )}
        </div>
        <div className="stack">
          <Card title="How to export from MT5" icon={<Icon.info />}>
            <ol className="small text-2" style={{ paddingLeft: 18, margin: 0, display: 'grid', gap: 6 }}>
              <li>Open <b>Toolbox → History</b> and right-click.</li>
              <li>Choose <b>Positions</b> view and the period you want.</li>
              <li>Right-click → <b>Report → Open XML</b> (Excel), then save the <b>Positions</b> table as CSV — or copy the table into a spreadsheet and save as CSV.</li>
              <li>Required columns: Time, Position, Symbol, Type, Volume, Price, Time, Price, Profit (S/L, T/P, Commission, Swap optional).</li>
            </ol>
            <p className="tiny muted" style={{ marginTop: 10 }}>Pending orders and Deals-only exports are rejected because they can't be matched to closed positions reliably.</p>
          </Card>
          <Card title="Import history">
            {(history.data?.imports || []).length === 0 ? <p className="small muted">No imports yet.</p> : (
              <div className="list">{history.data.imports.map((i) => (
                <div className="list-item" key={i.id}>
                  <div className="grow"><div className="small ellipsis" style={{ fontWeight: 600 }}>{i.file_name}</div>
                    <div className="tiny muted">{i.account_name} · {fmtDateTime(i.created_at, user.timezone)}</div></div>
                  <div className="tiny" style={{ textAlign: 'right' }}><span className="pos">{i.rows_imported} imported</span><br /><span className="muted">{i.rows_duplicate} dup · {i.rows_invalid} invalid</span></div>
                </div>))}
              </div>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
