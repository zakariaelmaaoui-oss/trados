import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { BrowserRouter, Routes, Route, NavLink, Navigate, useLocation, Link } from 'react-router-dom';
import { api } from './api.js';
import { Icon } from './components/icons.jsx';
import { ToastProvider, useToast } from './components/ui.jsx';
import { disablePushOnThisDevice } from './push.js';
import AuthPage from './pages/Auth.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Journal from './pages/Journal.jsx';
import TradeEditor from './pages/TradeEditor.jsx';
import ImportPage from './pages/Import.jsx';
import Planner from './pages/Planner.jsx';
import WeeklyReview from './pages/WeeklyReview.jsx';
import CalendarPage from './pages/Calendar.jsx';
import Discipline from './pages/Discipline.jsx';
import Reports from './pages/Reports.jsx';
import Settings from './pages/Settings.jsx';

const AuthCtx = createContext(null);
export const useAuth = () => useContext(AuthCtx);

const NAV = [
  { to: '/', label: 'Dashboard', icon: Icon.dashboard, end: true },
  { to: '/journal', label: 'Journal', icon: Icon.journal },
  { to: '/import', label: 'MT5 Import', icon: Icon.upload },
  { to: '/planner', label: 'Planner', icon: Icon.planner },
  { to: '/calendar', label: 'Calendar', icon: Icon.calendar },
  { to: '/discipline', label: 'Discipline', icon: Icon.target },
  { to: '/reports', label: 'Reports', icon: Icon.report },
  { to: '/settings', label: 'Settings', icon: Icon.settings },
];
const MOBILE_MAIN = ['/', '/journal', '/planner', '/calendar'];

export function ModeSwitch() {
  const { user, setMode } = useAuth();
  return (
    <div className="seg mode-switch" role="group" aria-label="Account mode">
      {['demo', 'live'].map((m) => (
        <button key={m} type="button" className={`${user.activeMode === m ? 'on' : ''} ${m}`} aria-pressed={user.activeMode === m} onClick={() => setMode(m)}>
          {m === 'demo' ? 'Demo' : 'Live'}
        </button>
      ))}
    </div>
  );
}

export function PageHead({ title, sub, children }) {
  return (
    <header className="topbar">
      <div className="title"><h1>{title}</h1>{sub && <span className="sub">{sub}</span>}</div>
      <div className="topbar-actions">{children}<ModeSwitch /></div>
    </header>
  );
}

function Shell({ children }) {
  const { user, logout } = useAuth();
  const [more, setMore] = useState(false);
  const loc = useLocation();
  useEffect(() => setMore(false), [loc.pathname]);
  return (
    <div className="shell">
      <aside className="sidebar">
        <Link to="/" className="brand"><img src="/icons/icon.svg" alt="" />TradeOS</Link>
        <nav className="nav" aria-label="Main">
          {NAV.map((n) => <NavLink key={n.to} to={n.to} end={n.end}><n.icon />{n.label}</NavLink>)}
        </nav>
        <div className="spacer" />
        <div className="card" style={{ padding: 14, boxShadow: 'none' }}>
          <div className="small" style={{ fontWeight: 600 }}>{user.displayName}</div>
          <div className="tiny muted ellipsis">{user.email}</div>
          <button className="btn sm ghost" style={{ marginTop: 8, paddingLeft: 0 }} onClick={logout}><Icon.logout />Sign out</button>
        </div>
      </aside>
      <main className="main">{children}</main>
      <nav className="mobile-nav" aria-label="Main">
        {NAV.filter((n) => MOBILE_MAIN.includes(n.to)).map((n) => <NavLink key={n.to} to={n.to} end={n.end}><n.icon />{n.label}</NavLink>)}
        <button type="button" onClick={() => setMore(true)} aria-haspopup="dialog"><Icon.more />More</button>
      </nav>
      {more && (
        <div className="more-sheet" role="dialog" aria-label="More pages" onClick={() => setMore(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            {NAV.filter((n) => !MOBILE_MAIN.includes(n.to)).map((n) => <Link key={n.to} to={n.to}><n.icon width={22} />{n.label}</Link>)}
            <a href="#" onClick={(e) => { e.preventDefault(); logout(); }}><Icon.logout width={22} />Sign out</a>
          </div>
        </div>
      )}
    </div>
  );
}

function AuthProvider({ children }) {
  const [user, setUser] = useState(undefined);
  const toast = useToast();
  useEffect(() => {
    api.get('/api/me').then((r) => setUser(r.user)).catch(() => setUser(null));
    const h = () => setUser(null);
    window.addEventListener('tradeos:unauthorized', h);
    return () => window.removeEventListener('tradeos:unauthorized', h);
  }, []);
  const setMode = useCallback(async (m) => {
    try { const r = await api.patch('/api/me', { activeMode: m }); setUser(r.user); }
    catch (e) { toast(e.message, 'error'); }
  }, [toast]);
  const logout = useCallback(async () => {
    // Remove this device's push subscription so the next person signing in here doesn't get these alerts.
    try { await disablePushOnThisDevice(); } catch { /* ignore */ }
    await api.post('/api/auth/logout').catch(() => {});
    setUser(null);
  }, []);
  return <AuthCtx.Provider value={{ user, setUser, setMode, logout }}>{children}</AuthCtx.Provider>;
}

function Gate() {
  const { user } = useAuth();
  if (user === undefined) return <div className="auth-wrap"><div className="muted">Loading…</div></div>;
  if (!user) {
    return (
      <Routes>
        <Route path="/register" element={<AuthPage mode="register" />} />
        <Route path="*" element={<AuthPage mode="login" />} />
      </Routes>
    );
  }
  return (
    <Shell>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/journal" element={<Journal />} />
        <Route path="/journal/new" element={<TradeEditor />} />
        <Route path="/journal/:id" element={<TradeEditor />} />
        <Route path="/import" element={<ImportPage />} />
        <Route path="/planner" element={<Planner />} />
        <Route path="/planner/:date" element={<Planner />} />
        <Route path="/weekly" element={<WeeklyReview />} />
        <Route path="/calendar" element={<CalendarPage />} />
        <Route path="/discipline" element={<Discipline />} />
        <Route path="/reports" element={<Reports />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/login" element={<Navigate to="/" replace />} />
        <Route path="/register" element={<Navigate to="/" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <ToastProvider>
        <AuthProvider>
          <Gate />
        </AuthProvider>
      </ToastProvider>
    </BrowserRouter>
  );
}
