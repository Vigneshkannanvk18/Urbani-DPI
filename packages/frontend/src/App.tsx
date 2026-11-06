import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './auth/AuthContext';
import { RequireAuth } from './auth/RequireAuth';
import { Layout } from './components/Layout';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { Alerts } from './pages/Alerts';
import { AlertDetail } from './pages/AlertDetail';
import { Logs } from './pages/Logs';
import { Metrics } from './pages/Metrics';
import { AIInsights } from './pages/AIInsights';
import { Assistant } from './pages/Assistant';
import { Services } from './pages/Services';
import { Usage } from './pages/Usage';
import { Audit } from './pages/Audit';
import { Settings } from './pages/Settings';
import { Users } from './pages/Users';
import { Security } from './pages/Security';
import { SsoCallback } from './pages/SsoCallback';
import { RequirePermission } from './auth/RequirePermission';

/** App router. All dashboard routes are nested under the authenticated Layout. */
export function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/sso-callback" element={<SsoCallback />} />
          <Route
            element={
              <RequireAuth>
                <Layout />
              </RequireAuth>
            }
          >
            <Route path="/" element={<RequirePermission permission="dashboard:view"><Dashboard /></RequirePermission>} />
            <Route path="/alerts" element={<RequirePermission permission="alerts:view"><Alerts /></RequirePermission>} />
            <Route path="/alerts/:id" element={<RequirePermission permission="alerts:view"><AlertDetail /></RequirePermission>} />
            <Route path="/logs" element={<RequirePermission permission="logs:view"><Logs /></RequirePermission>} />
            <Route path="/metrics" element={<RequirePermission permission="metrics:view"><Metrics /></RequirePermission>} />
            <Route path="/ai" element={<RequirePermission permission="ai:view"><AIInsights /></RequirePermission>} />
            <Route path="/assistant" element={<RequirePermission permission="chat:use"><Assistant /></RequirePermission>} />
            <Route path="/services" element={<RequirePermission permission="services:view"><Services /></RequirePermission>} />
            <Route path="/usage" element={<RequirePermission permission="usage:view"><Usage /></RequirePermission>} />
            <Route path="/audit" element={<RequirePermission permission="audit:view"><Audit /></RequirePermission>} />
            <Route path="/users" element={<RequirePermission permission="users:manage"><Users /></RequirePermission>} />
            <Route path="/security" element={<Security />} />
            <Route path="/settings" element={<RequirePermission permission="settings:view"><Settings /></RequirePermission>} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
