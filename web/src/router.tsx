import { createBrowserRouter, Navigate } from 'react-router-dom';
import { RequireAdmin, RequireAuth } from './auth/guards';
import { LoginPage } from './auth/LoginPage';
import { RequestAccessPage } from './auth/RequestAccessPage';
import { AppShell } from './layout/AppShell';
import { RouteError } from './components/RouteError';

export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage />, errorElement: <RouteError /> },
  { path: '/request-access', element: <RequestAccessPage />, errorElement: <RouteError /> },
  {
    element: <RequireAuth />,
    errorElement: <RouteError />,
    children: [
      {
        element: <AppShell />,
        children: [
          {
            path: '/',
            lazy: async () => ({ Component: (await import('./features/dashboard/DashboardPage')).DashboardPage }),
          },
          {
            path: '/stores',
            lazy: async () => ({ Component: (await import('./features/stores/StoresPage')).StoresPage }),
          },
          {
            path: '/stores/:sid',
            lazy: async () => ({ Component: (await import('./features/apps/AppsPage')).AppsPage }),
          },
          {
            path: '/stores/:sid/apps/:aid',
            lazy: async () => ({ Component: (await import('./features/localizations/EditorPage')).EditorPage }),
          },
          {
            path: '/settings',
            lazy: async () => ({ Component: (await import('./features/settings/SettingsPage')).SettingsPage }),
          },
          {
            // Self-gated: admins or members with the explicit viewFinance grant.
            path: '/stores/:sid/finance',
            lazy: async () => ({ Component: (await import('./features/finance/FinancePage')).FinancePage }),
          },
          {
            // Self-gated: members holding manageMembers on at least one store.
            path: '/team',
            lazy: async () => ({ Component: (await import('./features/team/TeamPage')).TeamPage }),
          },
          {
            element: <RequireAdmin />,
            children: [
              {
                path: '/admin/users',
                lazy: async () => ({ Component: (await import('./features/admin/UsersPage')).UsersPage }),
              },
              {
                path: '/admin/analytics',
                lazy: async () => ({ Component: (await import('./features/admin/AnalyticsPage')).AnalyticsPage }),
              },
              {
                path: '/admin/ads',
                lazy: async () => ({ Component: (await import('./features/ads/AdsPage')).AdsPage }),
              },
              {
                path: '/oauth/admob',
                lazy: async () => ({ Component: (await import('./features/ads/OauthAdmobPage')).OauthAdmobPage }),
              },
              {
                path: '/admin/usage',
                lazy: async () => ({ Component: (await import('./features/admin/AdminUsagePage')).AdminUsagePage }),
              },
              {
                path: '/admin/audit',
                lazy: async () => ({ Component: (await import('./features/admin/AuditPage')).AuditPage }),
              },
              {
                path: '/admin/settings',
                lazy: async () => ({ Component: (await import('./features/admin/AdminSettingsPage')).AdminSettingsPage }),
              },
            ],
          },
        ],
      },
    ],
  },
  { path: '*', element: <Navigate to="/" replace /> },
]);
