import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Icon } from './icons.jsx';

const ToastCtx = createContext(() => {});
export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const push = useCallback((msg, kind = 'info') => {
    const id = Math.random();
    setItems((x) => [...x, { id, msg, kind }]);
    setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), kind === 'error' ? 6000 : 3200);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toast-wrap" role="status" aria-live="polite">
        {items.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.msg}</div>)}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

export function Card({ title, icon, action, children, className = '', sub }) {
  return (
    <section className={`card ${className}`}>
      {(title || action) && (
        <div className="card-head">
          <div className="row" style={{ gap: 12 }}>
            {icon && <div className="icon-bubble">{icon}</div>}
            <div>
              {title && <h3>{title}</h3>}
              {sub && <div className="muted small">{sub}</div>}
            </div>
          </div>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, hint, className = '' }) {
  return (
    <div className="stat">
      <span className="label">{label}</span>
      <span className={`value ${className}`}>{value}</span>
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

export function Switch({ checked, onChange, label, disabled }) {
  return (
    <label className="switch" title={label}>
      <input type="checkbox" checked={!!checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} aria-label={label} />
      <span />
    </label>
  );
}

export function Stars({ value, onChange, label = 'Rating' }) {
  return (
    <div className="stars" role="radiogroup" aria-label={label}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button type="button" key={n} className={n <= (value || 0) ? 'on' : ''} aria-label={`${n} of 5`} aria-checked={value === n} role="radio" onClick={() => onChange(value === n ? null : n)}>★</button>
      ))}
    </div>
  );
}

export function Empty({ icon, children, action }) {
  return <div className="empty">{icon}<div>{children}</div>{action}</div>;
}

export function Alert({ kind = 'info', children }) {
  const ic = kind === 'error' || kind === 'warn' ? <Icon.warn width={18} height={18} /> : <Icon.info width={18} height={18} />;
  return <div className={`alert ${kind}`} role={kind === 'error' ? 'alert' : undefined}>{ic}<div>{children}</div></div>;
}

export function Loading() {
  return <div className="empty"><div className="muted">Loading…</div></div>;
}

export function Field({ label, help, children, className = '' }) {
  return <label className={`field ${className}`}><span>{label}</span>{children}{help && <small className="help">{help}</small>}</label>;
}

/** Fetch helper hook with reload. */
export function useLoad(fn, deps) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const seq = useRef(0);
  const load = useCallback(async () => {
    const my = ++seq.current;
    setState((s) => ({ ...s, loading: true }));
    try {
      const data = await fn();
      if (my === seq.current) setState({ data, error: null, loading: false });
    } catch (e) {
      if (my === seq.current) setState({ data: null, error: e, loading: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { load(); }, [load]);
  return { ...state, reload: load, setData: (d) => setState((s) => ({ ...s, data: typeof d === 'function' ? d(s.data) : d })) };
}

export function ModeBadge({ mode }) {
  return <span className={`badge ${mode}`}>{mode === 'live' ? 'LIVE' : 'DEMO'}</span>;
}

export function ImpactBadge({ impact }) {
  const label = { high: 'High', medium: 'Medium', low: 'Low', holiday: 'Holiday' }[impact] || impact;
  const cls = impact === 'high' ? 'neg' : impact === 'medium' ? 'warn' : '';
  return <span className={`badge ${cls}`}><span className={`dot ${impact}`} />{label}</span>;
}

export const STATUS_TEXT = {
  scheduled: { label: 'Scheduled', cls: 'accent', tip: 'Scheduled release time from the provider' },
  time_passed_unverified: { label: 'Time passed · not verified', cls: '', tip: 'The scheduled time has passed, but the provider has not published an actual figure, so the release is not verified.' },
  released_verified: { label: 'Released · verified', cls: 'pos', tip: 'The provider has published the actual figure.' },
};
export function StatusBadge({ status }) {
  const s = STATUS_TEXT[status] || { label: status, cls: '' };
  return <span className={`badge ${s.cls}`} title={s.tip}>{s.label}</span>;
}
