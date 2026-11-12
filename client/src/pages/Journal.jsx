import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, qs } from '../api.js';
import { useAuth, PageHead } from '../App.jsx';
import { Card, Empty, Alert, Loading, useLoad, Field } from '../components/ui.jsx';
import { Icon } from '../components/icons.jsx';
import { money, signClass, fmtDateTime, numf } from '../format.js';

export default function Journal() {
  const { user } = useAuth();
  const nav = useNavigate();
  const [filters, setFilters] = useState({ account: '', from: '', to: '', symbol: '' });
  const accounts = useLoad(() => api.get('/api/accounts'), []);
  const { data, error, loading } = useLoad(() => api.get(`/api/trades${qs({ mode: user.activeMode, ...filters })}`), [user.activeMode, filters.account, filters.from, filters.to, filters.symbol]);
  const modeAccounts = (accounts.data?.accounts || []).filter((a) => a.type === user.activeMode);
  const set = (k) => (e) => setFilters({ ...filters, [k]: e.target.value });
  const total = data?.trades.reduce((a, t) => a + (t.netProfit || 0), 0) ?? 0;
  return (
    <>
      <PageHead title="Trading Journal" sub="Every trade, with notes, risk and screenshots">
        <Link className="btn" to="/import"><Icon.upload />Import MT5</Link>
        <Link className="btn" to="/journal/new">Full form</Link>
        <Link className="btn primary" to="/journal/quick"><Icon.plus />Quick trade</Link>
      </PageHead>
      <Card>
        <div className="form-grid" style={{ marginBottom: 16 }}>
          <Field label="Account">
            <select className="input" value={filters.account} onChange={set('account')}>
              <option value="">All {user.activeMode} accounts</option>
              {modeAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </Field>
          <Field label="From"><input className="input" type="date" value={filters.from} onChange={set('from')} /></Field>
          <Field label="To"><input className="input" type="date" value={filters.to} onChange={set('to')} /></Field>
          <Field label="Symbol"><input className="input" placeholder="e.g. EURUSD" value={filters.symbol} onChange={(e) => setFilters({ ...filters, symbol: e.target.value.toUpperCase() })} /></Field>
        </div>
        {error && <Alert kind="error">{error.message}</Alert>}
        {loading && !data ? <Loading /> : data && data.trades.length === 0 ? (
          <Empty icon={<Icon.journal />} action={<div className="row" style={{ justifyContent: 'center' }}><Link className="btn sm primary" to="/journal/quick">Record a trade</Link><Link className="btn sm" to="/import">Import MT5 CSV</Link></div>}>
            No {user.activeMode} trades match these filters.
          </Empty>
        ) : data && (
          <>
            <div className="row between small" style={{ marginBottom: 8 }}>
              <span className="muted">{data.trades.length} trades</span>
              <span>Net: <b className={signClass(total)}>{money(total, 'USD', { sign: true })}</b></span>
            </div>
            <div className="table-wrap"><table className="table">
              <thead><tr><th>Opened</th><th>Symbol</th><th>Side</th><th className="num">Lots</th><th>Account</th><th className="num">Net</th><th className="num">R</th><th>Plan</th><th>Source</th></tr></thead>
              <tbody>
                {data.trades.map((t) => (
                  <tr key={t.id} className="click" onClick={() => nav(`/journal/${t.id}`)}>
                    <td className="small nowrap">{fmtDateTime(t.openTime, user.timezone)}</td>
                    <td style={{ fontWeight: 600 }}>{t.symbol}</td>
                    <td><span className={`badge ${t.direction === 'buy' ? 'pos' : 'neg'}`}>{t.direction.toUpperCase()}</span></td>
                    <td className="num">{numf(t.volume)}</td>
                    <td className="small text-2 nowrap">{t.accountName}</td>
                    <td className={`num ${signClass(t.netProfit)}`}>{t.closeTime ? money(t.netProfit, 'USD', { sign: true }) : <span className="badge accent">Open</span>}</td>
                    <td className="num">{t.rMultiple === null ? '—' : `${t.rMultiple}R`}</td>
                    <td>{t.planFollowed === null ? <span className="muted">—</span> : t.planFollowed ? <span className="badge pos">Yes</span> : <span className="badge neg">No</span>}</td>
                    <td className="small">{t.source === 'mt5_sync' ? <span className="badge accent">MT5 sync{t.corrected ? ' · edited' : ''}</span> : t.source === 'mt5_csv' ? <span className="badge">MT5 CSV{t.corrected ? ' · edited' : ''}</span> : <span className="muted">Manual</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          </>
        )}
      </Card>
    </>
  );
}
