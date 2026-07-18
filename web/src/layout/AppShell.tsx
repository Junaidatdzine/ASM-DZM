import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  BarChart3,
  LayoutDashboard,
  LogOut,
  Megaphone,
  Menu,
  Moon,
  Monitor,
  ScrollText,
  Settings,
  SlidersHorizontal,
  Store,
  Sun,
  TrendingUp,
  Users,
  X,
} from 'lucide-react';
import { hasAnyManageMembers } from '@asm/shared';
import { useSession } from '@/auth/AuthProvider';
import { useTheme, type ThemePref } from '@/theme/ThemeProvider';
import { AppMark } from '@/components/AppMark';
import { GlobalSearch } from '@/components/GlobalSearch';
import { Avatar } from '@/components/ui/Avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu';
import { cn } from '@/lib/utils';
import { ActivityButton } from '@/features/activity/ActivityButton';
import { ActivityBar } from '@/features/activity/ActivityBar';
import { ConnectionBanner } from '@/components/ConnectionBanner';

function NavItem({
  to,
  icon: Icon,
  label,
  end,
}: {
  to: string;
  icon: typeof LayoutDashboard;
  label: string;
  end?: boolean;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cn(
          'flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] font-medium transition-colors',
          isActive
            ? 'bg-accent text-accent-foreground'
            : 'text-muted-foreground hover:bg-muted hover:text-foreground',
        )
      }
    >
      <Icon className="size-4" />
      {label}
    </NavLink>
  );
}

/** Native-app style bottom navigation, shown only on small screens. */
function BottomNavItem({
  to,
  icon: Icon,
  label,
  end,
}: {
  to: string;
  icon: typeof LayoutDashboard;
  label: string;
  end?: boolean;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cn(
          'flex min-w-0 flex-1 flex-col items-center gap-0.5 rounded-lg py-1.5 text-[10px] font-medium transition-colors',
          isActive ? 'text-primary' : 'text-muted-foreground',
        )
      }
    >
      {({ isActive }) => (
        <>
          <span
            className={cn(
              'flex h-6 w-12 items-center justify-center rounded-full transition-colors',
              isActive && 'bg-primary/12',
            )}
          >
            <Icon className="size-4.5" />
          </span>
          <span className="truncate">{label}</span>
        </>
      )}
    </NavLink>
  );
}

const themeIcons: Record<ThemePref, typeof Sun> = { light: Sun, dark: Moon, system: Monitor };

function ThemeToggle() {
  const { pref, setPref } = useTheme();
  const Icon = themeIcons[pref];
  const next: Record<ThemePref, ThemePref> = { light: 'dark', dark: 'system', system: 'light' };
  return (
    <button
      title={`Theme: ${pref}`}
      onClick={() => setPref(next[pref])}
      className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      <Icon className="size-4" />
    </button>
  );
}

export function AppShell() {
  const { user, email, signOut } = useSession();
  const isAdmin = user?.role === 'admin';
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();

  // Close the mobile drawer on navigation.
  useEffect(() => setMobileOpen(false), [location.pathname]);

  const canManageTeam = !isAdmin && !!user && hasAnyManageMembers(user);

  const nav = (
    <>
      <nav className="mt-4 flex flex-1 flex-col gap-0.5 px-2.5">
        <NavItem to="/" icon={LayoutDashboard} label="Dashboard" end />
        <NavItem to="/stores" icon={Store} label="Stores" />
        {canManageTeam && <NavItem to="/team" icon={Users} label="Team" />}
        {isAdmin && (
          <>
            <div className="mb-1 mt-4 px-2.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
              Admin
            </div>
            <NavItem to="/admin/users" icon={Users} label="Users & Access" />
            <NavItem to="/admin/analytics" icon={TrendingUp} label="Analytics" />
            <NavItem to="/admin/ads" icon={Megaphone} label="Ads & Spend" />
            <NavItem to="/admin/usage" icon={BarChart3} label="Usage & Stats" />
            <NavItem to="/admin/audit" icon={ScrollText} label="Audit Log" />
            <NavItem to="/admin/settings" icon={SlidersHorizontal} label="Workspace" />
          </>
        )}
      </nav>
      <div className="border-t px-2.5 py-2.5">
        <NavItem to="/settings" icon={Settings} label="Settings" />
      </div>
    </>
  );

  return (
    <div className="flex min-h-screen">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-56 flex-col border-r bg-card/60 backdrop-blur lg:flex">
        <div className="px-4 pb-2 pt-4">
          <AppMark />
        </div>
        {nav}
      </aside>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/50" onClick={() => setMobileOpen(false)} />
          <aside className="absolute inset-y-0 left-0 flex w-64 flex-col border-r bg-card shadow-pop">
            <div className="flex items-center justify-between px-4 pb-2 pt-4">
              <AppMark />
              <button
                onClick={() => setMobileOpen(false)}
                className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            </div>
            {nav}
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col lg:pl-56">
        <header className="sticky top-0 z-20 flex h-13 items-center gap-1 border-b bg-background/80 px-3 backdrop-blur sm:px-4">
          <button
            onClick={() => setMobileOpen(true)}
            className="mr-1 flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground lg:hidden"
          >
            <Menu className="size-4.5" />
          </button>
          {/* On phones the search wins the header space; tablets keep the mark. */}
          <span className="hidden sm:inline lg:hidden">
            <AppMark compact />
          </span>
          <div className="flex flex-1 justify-center px-2">
            <GlobalSearch />
          </div>
          <ActivityButton />
          <ThemeToggle />
          <DropdownMenu>
            <DropdownMenuTrigger className="ml-1 rounded-full outline-none ring-ring/40 focus-visible:ring-2">
              <Avatar src={user?.photoUrl} name={user?.name ?? email ?? '?'} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>
                <div className="text-[13px] font-medium text-foreground">{user?.name}</div>
                <div className="text-xs">{email}</div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => void signOut()}>
                <LogOut className="size-3.5" /> Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </header>
        <ConnectionBanner />
        <ActivityBar />
        {/* pb keeps content clear of the mobile bottom bar (+ device safe area). */}
        <main className="min-w-0 flex-1 pb-[calc(64px+env(safe-area-inset-bottom))] lg:pb-0">
          <Outlet />
        </main>
      </div>

      {/* Mobile bottom tab bar — like a native app. Admin gets Analytics; Menu opens the drawer. */}
      <nav
        className="fixed inset-x-0 bottom-0 z-30 flex items-stretch gap-1 border-t bg-card/95 px-2 pt-1 backdrop-blur lg:hidden"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 4px)' }}
      >
        <BottomNavItem to="/" icon={LayoutDashboard} label="Home" end />
        <BottomNavItem to="/stores" icon={Store} label="Stores" />
        {isAdmin && <BottomNavItem to="/admin/analytics" icon={TrendingUp} label="Analytics" />}
        {canManageTeam && <BottomNavItem to="/team" icon={Users} label="Team" />}
        <BottomNavItem to="/settings" icon={Settings} label="Settings" />
        <button
          onClick={() => setMobileOpen(true)}
          className="flex min-w-0 flex-1 flex-col items-center gap-0.5 rounded-lg py-1.5 text-[10px] font-medium text-muted-foreground"
        >
          <span className="flex h-6 w-12 items-center justify-center rounded-full">
            <Menu className="size-4.5" />
          </span>
          <span>More</span>
        </button>
      </nav>
    </div>
  );
}

/** Standard page wrapper: consistent width, header row, content spacing. */
export function Page({
  title,
  description,
  actions,
  children,
  wide,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div className={cn('mx-auto w-full px-4 py-5 sm:px-6 sm:py-6', wide ? 'max-w-[1400px]' : 'max-w-5xl')}>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
          {description && <p className="mt-0.5 text-[13px] text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
      {children}
    </div>
  );
}
