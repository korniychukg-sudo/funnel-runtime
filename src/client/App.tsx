import { lazy, Suspense } from 'react';

const FunnelPage = lazy(() => import('./funnel/FunnelPage'));
const AdminPage = lazy(() => import('./pages/AdminPage'));
const DashboardPage = lazy(() => import('./pages/DashboardPage'));

function route(pathname: string) {
  if (pathname.startsWith('/admin')) return <AdminPage />;
  if (pathname.startsWith('/dashboard')) return <DashboardPage />;
  return <FunnelPage />;
}

export function App() {
  return <Suspense fallback={<div className="page-loading" />}>{route(window.location.pathname)}</Suspense>;
}
