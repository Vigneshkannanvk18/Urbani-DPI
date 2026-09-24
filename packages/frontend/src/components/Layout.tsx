import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { NAV_SECTIONS } from '../navigation';
import { useAuth } from '../auth/AuthContext';
import { useApi } from '../hooks/useApi';
import { dashboardApi } from '../api/endpoints';

/** App shell: sidebar navigation + topbar. Desktop-first, responsive sidebar. */
export function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  // Live active-alert count drives the sidebar badge.
  const summary = useApi(() => dashboardApi.summary(), []);
  const activeAlerts = summary.data?.data.activeAlerts ?? 0;

  const onLogout = async () => {
    await logout();
    navigate('/login');
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          Urbani
          <small>Observability & AI Troubleshooting</small>
        </div>
        <nav>
          {NAV_SECTIONS.filter((s) => s.enabled).map((s) => (
            <NavLink
              key={s.key}
              to={s.path}
              end={s.path === '/'}
              className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
            >
              <span aria-hidden>{s.icon}</span>
              <span>{s.label}</span>
              {s.key === 'alerts' && activeAlerts > 0 && (
                <span className="badge-count">{activeAlerts}</span>
              )}
            </NavLink>
          ))}
        </nav>
      </aside>

      <div className="main">
        <header className="topbar">
          <strong>Admin Dashboard</strong>
          <span className="src src-MOCK" title="Phase 1 runs on controlled mock data">
            PHASE 1 · MOCK DATA
          </span>
          <div className="spacer" />
          <span style={{ color: 'var(--text-dim)' }}>
            {user?.displayName} · {user?.role}
          </span>
          <button className="btn secondary" onClick={onLogout}>
            Logout
          </button>
        </header>
        <div className="content">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
