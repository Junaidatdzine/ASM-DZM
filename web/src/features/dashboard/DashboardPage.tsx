import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { collection, limit, orderBy, query, where } from 'firebase/firestore';
import {
  AlertCircle,
  AppWindow,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  CircleCheckBig,
  CircleSlash,
  Clock4,
  Hourglass,
  Loader2,
  PencilLine,
  Rocket,
  Store as StoreIcon,
} from 'lucide-react';
import type { OperationDoc, UserDoc } from '@asm/shared';
import { db } from '@/lib/firebase';
import { useLiveQuery } from '@/lib/hooks';
import { useSession } from '@/auth/AuthProvider';
import { useMyStores } from '@/features/stores/StoresPage';
import { Page } from '@/layout/AppShell';
import { Badge } from '@/components/ui/Badge';
import { AppGlyph, StoreDot, StoreGlyph } from '@/components/StoreGlyph';
import { Avatar } from '@/components/ui/Avatar';
import { OperationDetailsDialog, type OperationSelection } from '@/features/activity/OperationDetailsDialog';
import { api, type OverviewRow } from '@/lib/callables';
import { PlatformBadges } from '@/components/PlatformBadges';
import { cn, timeAgo } from '@/lib/utils';

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return 'morning';
  if (h < 18) return 'afternoon';
  return 'evening';
}

export function DashboardPage() {
  const { uid, user } = useSession();
  const stores = useMyStores();
  const [selectedOperation, setSelectedOperation] = useState<OperationSelection | null>(null);
  const ops = useLiveQuery<OperationDoc>(
    useMemo(
      () =>
        uid
          ? user?.role === 'admin'
            ? query(collection(db, 'operations'), orderBy('startedAt', 'desc'), limit(8))
            : query(collection(db, 'operations'), where('startedBy', '==', uid), orderBy('startedAt', 'desc'), limit(8))
          : null,
      [uid, user?.role],
    ),
    `dash-ops-${uid}-${user?.role}`,
  );
  const users = useLiveQuery<UserDoc>(
    useMemo(
      () => (user?.role === 'admin' ? query(collection(db, 'users'), orderBy('name')) : null),
      [user?.role],
    ),
    `dash-users-${user?.role}`,
  );
  const actorFor = (startedBy: string) =>
    users.rows.find((row) => row.id === startedBy)?.data ?? (startedBy === uid ? user : null);

  const totalApps = stores.rows.reduce((n, s) => n + (s.data.appsCount ?? 0), 0);

  return (
    <Page
      title={`Good ${greeting()}, ${user?.name?.split(' ')[0] ?? 'there'}`}
      description="Your stores and recent activity."
      wide
    >
      <StatusOverview />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <div className="mb-3 grid grid-cols-2 gap-3">
            <div className="rounded-xl border bg-card p-4 shadow-card">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <StoreIcon className="size-3.5" /> Stores
              </div>
              <div className="mt-1 text-2xl font-semibold tabular-nums">{stores.rows.length}</div>
            </div>
            <div className="rounded-xl border bg-card p-4 shadow-card">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <AppWindow className="size-3.5" /> Apps
              </div>
              <div className="mt-1 text-2xl font-semibold tabular-nums">{totalApps}</div>
            </div>
          </div>

          <div className="space-y-2">
            {stores.rows.map((s) => (
              <Link
                key={s.id}
                to={`/stores/${s.id}`}
                className="flex items-center justify-between rounded-xl border bg-card px-4 py-3 shadow-card transition-shadow hover:shadow-pop"
              >
                <div className="flex items-center gap-3">
                  <StoreGlyph color={s.data.color} icon={s.data.icon} seed={s.id} size="md" />
                  <div>
                    <div className="flex items-center gap-2 text-[14px] font-medium">
                      {s.data.name}
                      {s.data.mock && <Badge variant="outline">mock</Badge>}
                      {s.data.status === 'auth_error' && <Badge variant="destructive">key error</Badge>}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {s.data.appsCount ?? 0} apps · synced {timeAgo(s.data.appsSyncedAt)}
                    </div>
                  </div>
                </div>
                <ArrowRight className="size-4 text-muted-foreground" />
              </Link>
            ))}
            {!stores.loading && stores.rows.length === 0 && (
              <div className="rounded-xl border border-dashed p-6 text-center text-[13px] text-muted-foreground">
                No stores yet — connect one from the Stores page.
              </div>
            )}
          </div>
        </div>

        <div className="rounded-xl border bg-card p-4 shadow-card">
          <h2 className="text-[13px] font-semibold">Recent activity</h2>
          <div className="mt-2 space-y-1.5">
            {ops.rows.length === 0 && (
              <p className="text-[13px] text-muted-foreground">Syncs, pushes and AI runs show up here.</p>
            )}
            {ops.rows.map((r) => {
              const actor = actorFor(r.data.startedBy);
              return (
              <button
                key={r.id}
                type="button"
                onClick={() => setSelectedOperation({ id: r.id, operation: r.data, actor })}
                className="flex w-full items-start gap-2 rounded-lg px-1.5 py-1.5 text-left transition-colors hover:bg-muted/60"
              >
                {r.data.status === 'running' ? (
                  <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin text-primary" />
                ) : r.data.status === 'error' ? (
                  <AlertCircle className="mt-0.5 size-3.5 shrink-0 text-destructive" />
                ) : (
                  <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" />
                )}
                <Avatar src={actor?.photoUrl} name={actor?.name ?? actor?.email ?? 'Unknown'} seed={r.data.startedBy} className="size-6" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px]">{r.data.label}</div>
                  <div className="truncate text-[11px] text-muted-foreground">
                    {actor?.name ?? actor?.email ?? 'Unknown user'} · {timeAgo(r.data.startedAt)}
                  </div>
                </div>
              </button>
            );})}
          </div>
        </div>
      </div>
      <OperationDetailsDialog selection={selectedOperation} onOpenChange={(open) => { if (!open) setSelectedOperation(null); }} />
    </Page>
  );
}

// ---- Version status overview (big cards + drill-down) ----

const BUCKETS = [
  { key: 'rejected', label: 'Rejected', hint: 'Needs your attention', icon: CircleSlash, tone: 'text-destructive', bg: 'border-destructive/40 bg-destructive/10', chip: 'bg-destructive text-white' },
  { key: 'waiting', label: 'Waiting for review', hint: 'Queued at Apple', icon: Clock4, tone: 'text-sky-600 dark:text-sky-400', bg: 'border-sky-500/40 bg-sky-500/10', chip: 'bg-sky-500 text-white' },
  { key: 'inReview', label: 'In review', hint: 'With Apple now', icon: Hourglass, tone: 'text-warning', bg: 'border-warning/40 bg-warning/10', chip: 'bg-warning text-white' },
  { key: 'approved', label: 'Approved', hint: 'Ready to release', icon: CircleCheckBig, tone: 'text-primary', bg: 'border-primary/30 bg-primary/5', chip: 'bg-primary text-primary-foreground' },
  { key: 'live', label: 'Live', hint: 'On the App Store', icon: Rocket, tone: 'text-success', bg: 'border-success/40 bg-success/10', chip: 'bg-success text-white' },
  { key: 'draft', label: 'Drafts', hint: 'Being prepared', icon: PencilLine, tone: 'text-muted-foreground', bg: 'border-border bg-card', chip: 'bg-muted text-foreground' },
] as const;

function describeRowState(state: string): string {
  return state.replace(/_/g, ' ').toLowerCase();
}

function StatusOverview() {
  const { user } = useSession();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState<(typeof BUCKETS)[number]['key'] | null>(null);
  const overview = useQuery({
    queryKey: ['apps-overview'],
    queryFn: () => api.appsOverview({}),
    staleTime: 5 * 60_000,
  });

  // Apps in the 'none' bucket have no version statuses cached yet. One cheap
  // list sync per affected store fills them (1 API request per 200 apps) —
  // run it automatically so the cards are complete without touching 60 stores.
  const sweepRef = useRef(false);
  useEffect(() => {
    if (user?.role !== 'admin' || sweepRef.current || !overview.data) return;
    // Cooldown: some apps legitimately have no versions — don't re-sync those
    // stores on every dashboard visit. One attempt per store per 6 hours.
    const swept: Record<string, number> = JSON.parse(localStorage.getItem('asm-status-sweep') ?? '{}');
    const cutoff = Date.now() - 6 * 3600 * 1000;
    const storeIds = [...new Set(overview.data.rows.filter((r) => r.bucket === 'none').map((r) => r.storeId))]
      .filter((sid) => (swept[sid] ?? 0) < cutoff);
    if (storeIds.length === 0) return;
    for (const sid of storeIds) swept[sid] = Date.now();
    localStorage.setItem('asm-status-sweep', JSON.stringify(swept));
    sweepRef.current = true;
    toast.info(`Filling in app statuses for ${storeIds.length} store${storeIds.length === 1 ? '' : 's'}…`, {
      description: 'One quick sync per store — the cards update when it finishes.',
    });
    void (async () => {
      const queue = [...storeIds];
      await Promise.all(
        Array.from({ length: Math.min(2, queue.length) }, async () => {
          for (let sid = queue.shift(); sid; sid = queue.shift()) {
            await api.storesSync({ storeId: sid }).catch(() => {});
          }
        }),
      );
      await queryClient.invalidateQueries({ queryKey: ['apps-overview'] });
      toast.success('App statuses are up to date');
    })();
  }, [user?.role, overview.data, queryClient]);

  const byBucket = useMemo(() => {
    const map = new Map<string, OverviewRow[]>();
    for (const row of overview.data?.rows ?? []) {
      map.set(row.bucket, [...(map.get(row.bucket) ?? []), row]);
    }
    return map;
  }, [overview.data]);

  const openRows = open ? (byBucket.get(open) ?? []) : [];

  return (
    <div className="mb-4">
      <div className="flex flex-wrap gap-3">
        {BUCKETS.map(({ key, label, hint, icon: Icon, tone, bg }) => {
          const count = byBucket.get(key)?.length ?? 0;
          const active = open === key;
          // Empty buckets are noise at this scale — only real work shows.
          if (count === 0 && !overview.isLoading) return null;
          return (
            <button
              key={key}
              type="button"
              onClick={() => setOpen(active ? null : count > 0 ? key : null)}
              className={cn(
                'min-w-44 flex-1 rounded-xl border p-4 text-left shadow-card transition-all sm:max-w-64',
                bg,
                active ? 'ring-2 ring-ring' : count > 0 ? 'hover:shadow-pop' : 'opacity-70',
              )}
            >
              <div className={cn('flex items-center justify-between gap-2 text-xs font-medium', tone)}>
                <span className="flex items-center gap-1.5"><Icon className="size-3.5" /> {label}</span>
                {count > 0 && <ChevronDown className={cn('size-3.5 transition-transform', active && 'rotate-180')} />}
              </div>
              <div className="mt-1 text-3xl font-semibold tabular-nums tracking-tight">
                {overview.isLoading ? '…' : count}
              </div>
              <div className="mt-0.5 text-[11px] text-muted-foreground">{hint}</div>
            </button>
          );
        })}
      </div>

      {open && openRows.length > 0 && (
        <div className="mt-3 overflow-hidden rounded-xl border bg-card shadow-card">
          <div className="border-b px-4 py-2.5 text-[12px] font-medium text-muted-foreground">
            {BUCKETS.find((b) => b.key === open)?.label} · {openRows.length} version{openRows.length === 1 ? '' : 's'}
          </div>
          <ul className="max-h-80 divide-y overflow-y-auto">
            {openRows.map((row) => (
              <li key={`${row.storeId}-${row.appId}-${row.platform}-${row.bucket}-${row.versionString}`}>
                <Link
                  to={`/stores/${row.storeId}/apps/${row.appId}`}
                  className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-muted/50"
                >
                  <AppGlyph name={row.appName} iconUrl={row.iconUrl} seed={row.appId} size="md" className="rounded-[22%]" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium">{row.appName}</div>
                    <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                      <StoreDot color={row.storeColor ?? undefined} seed={row.storeId} />
                      <span className="truncate">{row.storeName}</span>
                      <PlatformBadges platforms={row.platforms as never} devices={row.devices as never} className="shrink-0" />
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="text-[13px] font-medium tabular-nums">v{row.versionString}</div>
                    <div className="text-[11px] capitalize text-muted-foreground">{describeRowState(row.state)}</div>
                  </div>
                  <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" />
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
