import { useState } from 'react';
import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import { NAV_SECTIONS } from '../navigation';
import { useAuth } from '../auth/AuthContext';
import { useApi } from '../hooks/useApi';
import { dashboardApi } from '../api/endpoints';
import { Button } from './ui';
import { IconLogout, IconMenu, IconChevronLeft, IconChevronRight } from './icons';
import { AssistantChatProvider } from './assistant/useAssistantChat';
import { AssistantWidget } from './assistant/AssistantWidget';

/**
 * App shell (Parts 12, 13): light sidebar with #D1990A active state, alert
 * badge, collapse toggle + mobile drawer, and a clean top header. Preserves all
 * navigation destinations from Phase 1.
 */
export function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  // Live active-alert count drives the sidebar badge.
  const summary = useApi(() => dashboardApi.summary(), []);
  const activeAlerts = summary.data?.data.activeAlerts ?? 0;

  const current =
    NAV_SECTIONS.find((s) => s.path !== '/' && location.pathname.startsWith(s.path)) ??
    NAV_SECTIONS.find((s) => s.path === location.pathname) ??
    NAV_SECTIONS[0];

  const onLogout = async () => {
    await logout();
    navigate('/login');
  };

  const initials =
    (user?.displayName ?? user?.email ?? 'U')
      .split(/\s+/)
      .map((p) => p[0])
      .slice(0, 2)
      .join('')
      .toUpperCase();

  return (
    <AssistantChatProvider>
    <div className="app-shell">
      {mobileOpen && <div className="scrim show" onClick={() => setMobileOpen(false)} />}

      <aside className={`sidebar ${collapsed ? 'collapsed' : ''} ${mobileOpen ? 'open' : ''}`} aria-label="Primary">
        <div className="brand">
          <div className="brand-mark" aria-hidden>U</div>
          <div className="brand-text">
            <div className="brand-name">URBANI</div>
            <div className="brand-sub">Proactive Observability &amp; AI Troubleshooting</div>
          </div>
        </div>

        <nav className="nav">
          {NAV_SECTIONS.filter((s) => s.enabled).map((s) => {
            const Icon = s.icon;
            return (
              <NavLink
                key={s.key}
                to={s.path}
                end={s.path === '/'}
                title={collapsed ? s.label : undefined}
                onClick={() => setMobileOpen(false)}
                className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
              >
                <span className="nav-icon"><Icon size={18} /></span>
                <span className="nav-label">{s.label}</span>
                {s.key === 'alerts' && activeAlerts > 0 && (
                  <span className="nav-count" aria-label={`${activeAlerts} active alerts`}>{activeAlerts}</span>
                )}
              </NavLink>
            );
          })}
        </nav>

        <div className="sidebar-foot">
          <button
            className="collapse-btn"
            onClick={() => setCollapsed((c) => !c)}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? <IconChevronRight size={18} /> : <IconChevronLeft size={18} />}
            {!collapsed && <span>Collapse</span>}
          </button>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <button className="menu-btn" onClick={() => setMobileOpen(true)} aria-label="Open navigation">
            <IconMenu size={20} />
          </button>
          <div className="topbar-title">{current.title}</div>
          <div className="spacer" />
          <span className="src src-LIVE" title="Connected to the live Urbani AWS backend">
            ENV · LIVE
          </span>
          <div className="topbar-user">
            <div className="avatar" aria-hidden>{initials}</div>
            <div style={{ lineHeight: 1.2 }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>{user?.displayName}</div>
              <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{user?.role}</div>
            </div>
            <Button variant="ghost" size="sm" onClick={onLogout} aria-label="Log out">
              <IconLogout size={16} /> Logout
            </Button>
          </div>
        </header>

        <main className="content">
          <Outlet />
        </main>
      </div>

      {/* Floating AI Log Assistant — mounted once; every authenticated page gets
          it, Login (outside Layout) never does. */}
      <AssistantWidget />
    </div>
    </AssistantChatProvider>
  );
}
