import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import {
  IconMail,
  IconLock,
  IconEye,
  IconEyeOff,
  IconArrowRight,
  IconShield,
  IconMetrics,
  IconTriangleAlert,
  IconBrainFill,
  IconShieldOutline,
  IconDashboard,
  IconAlert,
  IconLogs,
  IconAI,
  IconAssistant,
  IconServices,
  IconCost,
  IconAudit,
  IconSettings,
  IconServer,
} from '../components/icons';
import './login.css';

const FEATURES = [
  { icon: <IconMetrics />, label: 'Real-time\nMonitoring' },
  { icon: <IconTriangleAlert />, label: 'Proactive\nAlerts' },
  { icon: <IconBrainFill />, label: 'AI-Powered\nInsights' },
  { icon: <IconShieldOutline />, label: 'Faster\nTroubleshooting' },
];

function Brand({ variant }: { variant: 'hero' | 'card' }) {
  return (
    <div className={`lg-brand lg-brand-${variant}`}>
      <div className="lg-mark" aria-hidden>U</div>
      <div>
        <div className="lg-name">URBANI</div>
        <div className="lg-sub">Proactive Observability &amp; AI Troubleshooting</div>
      </div>
    </div>
  );
}

/** Tilted tablet showing a stylised dashboard; bleeds off the bottom-left. */
function DashboardMock() {
  const nav = [
    { label: 'Dashboard', icon: <IconDashboard size={12} /> },
    { label: 'Alerts / Incidents', icon: <IconAlert size={12} />, badge: '13' },
    { label: 'Logs', icon: <IconLogs size={12} /> },
    { label: 'Metrics', icon: <IconMetrics size={12} /> },
    { label: 'AI Insights', icon: <IconAI size={12} /> },
    { label: 'Urbani Copilot', icon: <IconAssistant size={12} /> },
    { label: 'Services', icon: <IconServices size={12} /> },
    { label: 'Usage & Cost', icon: <IconCost size={12} /> },
    { label: 'Audit / Activity', icon: <IconAudit size={12} /> },
    { label: 'Settings', icon: <IconSettings size={12} /> },
  ];
  const kpis = [
    { label: 'Total Services', value: '3', sub: '', icon: <IconServer size={11} /> },
    { label: 'Active Alerts', value: '13', sub: 'Open + acknowledged', icon: <IconAlert size={11} /> },
    { label: 'Critical Alerts', value: '9', sub: 'Require attention', icon: <IconAlert size={11} /> },
    { label: 'Recent Incidents', value: '13', sub: '', icon: <IconLogs size={11} /> },
  ];
  return (
    <div className="login-device" aria-hidden>
      <div className="ld-frame">
        <div className="ld-screen">
          <div className="ld-body">
            <aside className="ld-sidebar">
              <div className="ld-sb-brand">
                <span className="ld-mark">U</span> URBANI
              </div>
              {nav.map((n, i) => (
                <span key={n.label} className={`ld-nav ${i === 0 ? 'active' : ''}`}>
                  {n.icon}
                  <span className="ld-nav-text">{n.label}</span>
                  {n.badge && <span className="ld-nav-badge">{n.badge}</span>}
                </span>
              ))}
            </aside>
            <div className="ld-content">
              <div className="ld-top">
                <span className="ld-crumb">Dashboard</span>
                <span className="ld-top-right">
                  <span className="ld-env">ENV · LIVE</span>
                  <span className="ld-avatar">UA</span>
                  <span className="ld-user">
                    Urbani Admin
                    <small>Admin</small>
                  </span>
                </span>
              </div>
              <div className="ld-main">
                <div className="ld-title">
                  Dashboard <span className="ld-live">+ LIVE</span>
                </div>
                <div className="ld-sub">Proactive observability overview</div>
                <div className="ld-kpis">
                  {kpis.map((k) => (
                    <div key={k.label} className="ld-kpi">
                      <span className="ld-kpi-label">
                        <span className="ld-kpi-icon">{k.icon}</span>
                        {k.label}
                      </span>
                      <span className="ld-kpi-value">{k.value}</span>
                      {k.sub && <span className="ld-kpi-sub">{k.sub}</span>}
                    </div>
                  ))}
                </div>
                <div className="ld-health">
                  <div className="ld-health-head">
                    <span className="ld-health-title">
                      <span className="ld-mark sm">U</span> System Health
                    </span>
                    <span className="ld-degraded">● DEGRADED</span>
                  </div>
                  <svg className="ld-chart" viewBox="0 0 420 80" preserveAspectRatio="none">
                    <defs>
                      <linearGradient id="ldFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#d1990a" stopOpacity="0.28" />
                        <stop offset="100%" stopColor="#d1990a" stopOpacity="0" />
                      </linearGradient>
                    </defs>
                    <path
                      d="M0,62 L30,58 L60,60 L90,50 L120,54 L150,44 L180,48 L210,36 L240,42 L270,30 L300,36 L330,24 L360,30 L390,18 L420,22 L420,80 L0,80 Z"
                      fill="url(#ldFill)"
                    />
                    <polyline
                      points="0,62 30,58 60,60 90,50 120,54 150,44 180,48 210,36 240,42 270,30 300,36 330,24 360,30 390,18 420,22"
                      fill="none"
                      stroke="#d1990a"
                      strokeWidth="2.5"
                      vectorEffect="non-scaling-stroke"
                    />
                  </svg>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('admin@urbani.local');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(false);
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
    <div className="login-page">
      <div className="login-orb login-orb-1" aria-hidden />
      <div className="login-orb login-orb-2" aria-hidden />
      <div className="login-orb login-orb-3" aria-hidden />
      <div className="login-dots" aria-hidden />

      {/* ---- Left: hero ---- */}
      <section className="login-hero">
        <Brand variant="hero" />

        <h1 className="login-headline">
          From <span className="accent">Alerts</span> to
          <br />
          Answers <span className="accent">Faster</span>
        </h1>
        <p className="login-lede">
          Monitor, analyze, and troubleshoot your infrastructure
          <br />
          with AI-powered observability.
        </p>

        <ul className="login-features">
          {FEATURES.map((f) => (
            <li key={f.label} className="login-feature">
              <span className="login-feature-icon">{f.icon}</span>
              <span className="login-feature-label">{f.label}</span>
            </li>
          ))}
        </ul>

        <DashboardMock />
      </section>

      {/* ---- Right: sign-in card ---- */}
      <section className="login-panel">
        <form className="login-card" onSubmit={submit}>
          <Brand variant="card" />

          <h2 className="login-card-title">Sign in</h2>
          <p className="login-card-sub">
            Use your administrator credentials to access
            <br />
            the dashboard.
          </p>

          <div className="login-field">
            <label className="login-label" htmlFor="email">Email</label>
            <div className="login-input">
              <span className="login-input-icon"><IconMail size={18} /></span>
              <input
                id="email"
                className="login-input-el"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username"
                placeholder="admin@urbani.local"
              />
            </div>
          </div>

          <div className="login-field">
            <label className="login-label" htmlFor="password">Password</label>
            <div className="login-input">
              <span className="login-input-icon"><IconLock size={18} /></span>
              <input
                id="password"
                className="login-input-el"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                placeholder="Enter your password"
              />
              <button
                type="button"
                className="login-eye"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                aria-pressed={showPassword}
              >
                {showPassword ? <IconEye size={18} /> : <IconEyeOff size={18} />}
              </button>
            </div>
          </div>

          <div className="login-row">
            <label className="login-check">
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              <span>Keep me signed in</span>
            </label>
            <a className="login-forgot" href="#">Forgot password?</a>
          </div>

          {error && <div className="login-error" role="alert">{error}</div>}

          <button type="submit" className="login-submit" disabled={busy}>
            <span>{busy ? 'Signing in…' : 'Sign in'}</span>
            <IconArrowRight size={20} className="login-submit-arrow" />
          </button>

          <div className="login-foot">
            <IconShield size={14} />
            <span>Secure access to your observability platform</span>
          </div>
        </form>
      </section>
    </div>
  );
}
