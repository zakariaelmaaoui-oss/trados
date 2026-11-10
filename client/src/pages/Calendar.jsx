import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, qs } from '../api.js';
import { useAuth, PageHead } from '../App.jsx';
import { Card, Alert, Loading, useLoad, useToast, ImpactBadge, StatusBadge } from '../components/ui.jsx';
import { Icon } from '../components/icons.jsx';
import { todayIn, addDays, fmtDay, fmtDateTime, relTime } from '../format.js';

const CCYS = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD'];
const LS_KEY = 'tradeos.calendar.filters';

function loadFilters() {
  try { const v = JSON.parse(localStorage.getItem(LS_KEY)); if (v?.impacts && v?.currencies) return v; } catch { /* ignore */ }
  return { impacts: ['high', 'medium'], currencies: CCYS };
}

export default function CalendarPage() {
  const { user } = useAuth();
  const toast = useToast();
  const tz = user.timezone;
  const today = todayIn(tz);
  const [from, setFrom] = useState(today);
  const [days, setDays] = useState(7);
  const [filters, setFilters] = useState(loadFilters);
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => { try { localStorage.setItem(LS_KEY, JSON.stringify(filters)); } catch { /* ignore */ } }, [filters]);
  const to = addDays(from, days - 1);
  const { data, error, loading, reload } = useLoad(
    () => api.get(`/api/calendar${qs({ from, to, impacts: filters.impacts.join(','), currencies: filters.currencies.join(',') })}`),
    [from, to, filters.impacts.join(), filters.currencies.join()],
  );
  const toggle = (k, v) => setFilters((f) => ({ ...f, [k]: f[k].includes(v) ? f[k].filter((x) => x !== v) : [...f[k], v] }));
  const groups = useMemo(() => {
    const g = new Map();
    for (const e of data?.events || []) { if (!g.has(e.localDate)) g.set(e.localDate, []); g.get(e.localDate).push(e); }
    return [...g.entries()];
  }, [data]);
  const refresh = async () => {
    setRefreshing(true);
    try { await api.post('/api/calendar/refresh'); toast('Calendar refreshed from provider'); reload(); }
    catch (e) { toast(e.message, 'error'); } finally { setRefreshing(false); }
  };
  const st = data?.status;
  const offset = data?.events?.[0]?.utcOffset;

  return (
    <>
      <PageHead title="Economic Calendar" sub={`Times shown in ${tz.replace('_', ' ')}${offset ? ` (${offset})` : ''}`}>
        <Link className="btn sm" to="/settings#notifications"><Icon.bell />Alerts</Link>
      </PageHead>
      <div className="stack">
        <Card>
          <div className="row between" style={{ alignItems: 'flex-start' }}>
            <div className="stack" style={{ gap: 4 }}>
              <div className="small"><span className="muted">Provider:</span> <b>{st?.provider || '—'}</b></div>
              <div className="small"><span className="muted">Last successful update:</span> {st?.lastSuccessfulUpdate ? <>{fmtDateTime(st.lastSuccessfulUpdate, tz)} ({relTime(st.lastSuccessfulUpdate)})</> : 'never'}</div>
              {st?.coverage && <div className="tiny muted">Provider coverage: {fmtDateTime(st.coverage.start, tz)} → {fmtDateTime(st.coverage.end, tz)}. Events outside this window are not available from the provider yet.</div>}
            </div>
            <button className="btn sm" onClick={refresh} disabled={refreshing}><Icon.refresh />{refreshing ? 'Refreshing…' : 'Refresh'}</button>
          </div>
          {st && st.stale && <div style={{ marginTop: 12 }}><Alert kind="warn">{st.hasData ? `Data is stale: the last successful update was ${relTime(st.lastSuccessfulUpdate)}. Times may have changed.` : 'No data has been received from the provider yet.'}{st.lastError && <> Last error: {st.lastError}.</>}</Alert></div>}
          {st && !st.stale && st.lastAttemptOk === false && <div style={{ marginTop: 12 }}><Alert kind="info">The most recent refresh failed ({st.lastError}); showing data from the last successful update. Retrying automatically.</Alert></div>}
          <div className="row" style={{ marginTop: 16, gap: 18, alignItems: 'flex-start' }}>
            <div className="stack" style={{ gap: 6 }}>
              <span className="tiny muted">IMPACT</span>
              <div className="chips">
                {['high', 'medium', 'low'].map((i) => (
                  <button key={i} type="button" className={`chip ${filters.impacts.includes(i) ? 'on' : ''}`} aria-pressed={filters.impacts.includes(i)} onClick={() => toggle('impacts', i)}>
                    <span className={`dot ${i}`} style={{ marginRight: 6 }} />{i[0].toUpperCase() + i.slice(1)}
                  </button>
                ))}
              </div>
            </div>
            <div className="stack" style={{ gap: 6 }}>
              <span className="tiny muted">CURRENCIES</span>
              <div className="chips">
                {CCYS.map((c) => <button key={c} type="button" className={`chip ${filters.currencies.includes(c) ? 'on' : ''}`} aria-pressed={filters.currencies.includes(c)} onClick={() => toggle('currencies', c)}>{c}</button>)}
              </div>
            </div>
            <div className="stack" style={{ gap: 6 }}>
              <span className="tiny muted">RANGE</span>
              <div className="row" style={{ gap: 4 }}>
                <button className="btn sm" onClick={() => setFrom(addDays(from, -days))} aria-label="Earlier"><Icon.chevL /></button>
                <div className="seg">{[[1, 'Day'], [7, 'Week']].map(([n, l]) => <button key={n} className={days === n ? 'on' : ''} onClick={() => setDays(n)}>{l}</button>)}</div>
                <button className="btn sm" onClick={() => setFrom(addDays(from, days))} aria-label="Later"><Icon.chevR /></button>
                {from !== today && <button className="btn sm" onClick={() => setFrom(today)}>Today</button>}
              </div>
            </div>
          </div>
        </Card>

        <Card title={`${fmtDay(from, { day: 'numeric', month: 'short' })} – ${fmtDay(to, { day: 'numeric', month: 'short' })}`} sub={data ? `${data.events.length} events` : ''}>
          {error && <Alert kind="error">{error.message}</Alert>}
          {loading && !data ? <Loading /> : data && data.events.length === 0 ? (
            <div className="empty">
              <Icon.calendar />
              <div>{filters.impacts.length === 0 || filters.currencies.length === 0 ? 'Select at least one impact level and currency.' : st?.hasData ? 'No events from the provider match these filters in this range.' : 'No provider data available yet.'}</div>
            </div>
          ) : groups.map(([d, evs]) => (
            <div className="day-group" key={d}>
              <div className="day-head"><span>{fmtDay(d)}{d === today && <span className="badge accent" style={{ marginLeft: 8 }}>Today</span>}</span><span className="tiny muted">{evs.length}</span></div>
              {evs.map((e) => (
                <div key={e.id} className={`event ${e.status !== 'scheduled' ? 'past' : ''}`}>
                  <div className="time">{e.localTime}</div>
                  <div className="ccy">{e.currency}</div>
                  <div style={{ minWidth: 0 }}>
                    <div className="ellipsis" style={{ fontWeight: 560 }}>{e.title}</div>
                    <div className="vals"><span>Forecast: {e.forecast || '—'}</span><span>Previous: {e.previous || '—'}</span>{e.actual && <span>Actual: <b>{e.actual}</b></span>}</div>
                  </div>
                  <div className="row meta" style={{ gap: 6, justifyContent: 'flex-end' }}><ImpactBadge impact={e.impact} /><StatusBadge status={e.status} /></div>
                </div>
              ))}
            </div>
          ))}
        </Card>
        <p className="tiny muted">Scheduled times come from the provider and are converted to {tz} using the IANA time-zone database (including Morocco's offset changes). “Time passed · not verified” means the scheduled time has passed but the provider has not published an actual figure — TradeOS does not assume a release happened.</p>
      </div>
    </>
  );
}
