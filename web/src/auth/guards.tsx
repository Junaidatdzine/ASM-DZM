import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useSession } from './AuthProvider';
import { Spinner } from '@/components/ui/Skeleton';
import { AppMark } from '@/components/AppMark';

function FullScreenLoader() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6">
      <AppMark hero />
      <Spinner />
    </div>
  );
}

/** Wraps everything that needs an active, provisioned session. */
export function RequireAuth() {
  const { status } = useSession();
  const location = useLocation();

  if (status === 'loading') return <FullScreenLoader />;
  if (status === 'unprovisioned' || status === 'domainBlocked') return <Navigate to="/request-access" replace />;
  if (status !== 'ready') return <Navigate to="/login" replace state={{ from: location }} />;
  return <Outlet />;
}

/** Admin-only subtree. */
export function RequireAdmin() {
  const { status, user } = useSession();
  if (status !== 'ready') return <FullScreenLoader />;
  if (user?.role !== 'admin') return <Navigate to="/" replace />;
  return <Outlet />;
}
