import type { ReactNode } from 'react';
import type { Permission } from '@urbani/shared';
import { useAuth } from './AuthContext';

/** Route guard for RBAC (DPI 2 item 2). The API enforces permissions too; this gives a clear screen. */
export function RequirePermission({ permission, children }: { permission: Permission; children: ReactNode }) {
  const { can, user } = useAuth();
  if (can(permission)) return <>{children}</>;
  return (
    <div className="stack" role="alert">
      <h1 style={{ margin: 0 }}>You do not have permission</h1>
      <p className="text-secondary">
        Your role ({user?.rbacRoleName ?? user?.role}) cannot open this page. Ask a Super Admin if you need access.
      </p>
    </div>
  );
}