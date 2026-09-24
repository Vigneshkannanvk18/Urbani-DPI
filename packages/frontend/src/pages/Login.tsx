import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { Button } from '../components/ui';

export function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('admin@urbani.local');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
      navigate('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="card login-card" onSubmit={submit}>
        <div className="login-brand">
          <div className="brand-mark" aria-hidden>U</div>
          <div>
            <div className="brand-name" style={{ fontSize: 17 }}>URBANI</div>
            <div className="brand-sub">Proactive Observability &amp; AI Troubleshooting</div>
          </div>
        </div>

        <h1 style={{ fontSize: 'var(--text-section)', marginBottom: 4 }}>Sign in</h1>
        <p className="text-secondary" style={{ fontSize: 13, marginTop: 0, marginBottom: 'var(--space-4)' }}>
          Use your administrator credentials to access the dashboard.
        </p>

        <div className="field" style={{ marginBottom: 'var(--space-3)' }}>
          <label className="field-label" htmlFor="email">Email</label>
          <input
            id="email"
            className="input"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="password">Password</label>
          <input
            id="password"
            className="input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </div>

        <Button type="submit" disabled={busy} className="mt-4" style={{ width: '100%' }}>
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>

        {error && <div className="login-error" role="alert">{error}</div>}
      </form>
    </div>
  );
}
