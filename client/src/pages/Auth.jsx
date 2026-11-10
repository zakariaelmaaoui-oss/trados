import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../App.jsx';
import { Alert, Field } from '../components/ui.jsx';

export default function AuthPage({ mode }) {
  const { setUser } = useAuth();
  const nav = useNavigate();
  const [f, setF] = useState({ email: '', password: '', displayName: '' });
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const isReg = mode === 'register';
  const submit = async (e) => {
    e.preventDefault();
    setErr(null); setBusy(true);
    try {
      const r = await api.post(isReg ? '/api/auth/register' : '/api/auth/login', f);
      setUser(r.user);
      nav('/');
    } catch (ex) { setErr(ex.message); } finally { setBusy(false); }
  };
  return (
    <div className="auth-wrap">
      <div className="auth-card stack">
        <div className="brand" style={{ justifyContent: 'center', fontSize: 22 }}><img src="/icons/icon.svg" alt="" />TradeOS</div>
        <form className="card pad-lg stack" onSubmit={submit}>
          <div>
            <h2>{isReg ? 'Create your account' : 'Welcome back'}</h2>
            <p className="muted small" style={{ marginTop: 4 }}>{isReg ? 'Journal, plan and review your trading with discipline.' : 'Sign in to your trading workspace.'}</p>
          </div>
          {err && <Alert kind="error">{err}</Alert>}
          {isReg && <Field label="Name"><input className="input" autoComplete="name" value={f.displayName} onChange={(e) => setF({ ...f, displayName: e.target.value })} /></Field>}
          <Field label="Email"><input className="input" type="email" autoComplete="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
          <Field label="Password" help={isReg ? 'At least 8 characters.' : undefined}>
            <input className="input" type="password" autoComplete={isReg ? 'new-password' : 'current-password'} required minLength={isReg ? 8 : undefined} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
          </Field>
          <button className="btn primary" disabled={busy} type="submit">{busy ? 'Please wait…' : isReg ? 'Create account' : 'Sign in'}</button>
          <p className="small muted" style={{ textAlign: 'center' }}>
            {isReg ? <>Already have an account? <Link to="/login">Sign in</Link></> : <>New to TradeOS? <Link to="/register">Create an account</Link></>}
          </p>
        </form>
      </div>
    </div>
  );
}
