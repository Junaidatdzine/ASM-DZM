import { useCallback, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { collection, doc, orderBy, query } from 'firebase/firestore';
import { AppWindow, Clock3, Hammer, LineChart, RefreshCw, Search, Zap } from 'lucide-react';
import { toast } from 'sonner';
import type { AppDoc, StoreDoc } from '@asm/shared';
import { can, describeVersionState, hasEditableVersion, versionBucket } from '@asm/shared';
import { db } from '@/lib/firebase';
import { api, callableMessage } from '@/lib/callables';
import { useLiveDoc, useLiveQuery } from '@/lib/hooks';
import { STALE_APPS_LIST_MS, isStale, useAutoSync } from '@/lib/staleness';
import { useSession } from '@/auth/AuthProvider';
import { Page } from '@/layout/AppShell';
import { AppGlyph, StoreGlyph } from '@/components/StoreGlyph';
import { PlatformBadges } from '@/components/PlatformBadges';
import { DeveloperDialog } from '@/features/apps/DeveloperDialog';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { Skeleton } from '@/components/ui/Skeleton';
import { timeAgo } from '@/lib/utils';

export function AppsPage() {
  const { sid } = useParams<{ sid: string }>();
  const { user } = useSession();
  const store = useLiveDoc<StoreDoc>(sid ? doc(db, 'stores', sid) : null);
  const apps = useLiveQuery<AppDoc>(
    useMemo(() => (sid ? query(collection(db, 'stores', sid, 'apps'), orderBy('name')) : null), [sid]),
    `apps-${sid}`,
  );
  const [search, setSearch] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [devOpen, setDevOpen] = useState(false);
  const [hardSyncing, setHardSyncing] = useState(false);
  const canSync = !!user && !!sid && can(user, 'forceSync', sid);
  const canProvision = !!user && !!sid && can(user, 'manageProvisioning', sid);
  const isAdminUser = user?.role === 'admin';

  const runHardSync = useCallback(async () => {
    if (!sid) return;
    setHardSyncing(true);
    toast.info('Hard sync started', { description: 'Re-fetching the app list, every app in depth, and finance. Watch progress in Activity.' });
    try {
      const res = await api.storesHardSync({ storeId: sid });
      if (res.skipped) {
        toast.warning('Hard sync skipped', { description: res.reason === 'already_running' ? 'A sync is already running for this store.' : 'The store\u2019s API key needs attention first.' });
      } else {
        toast.success('Hard sync complete', {
          description: `${res.deepSynced}/${res.apps} apps deep-synced${res.failed ? `, ${res.failed} failed` : ''}${res.financeDays ? ` \u00b7 ${res.financeDays} finance days refreshed` : ''}.`,
        });
      }
    } catch (err) {
      toast.error('Hard sync failed', { description: callableMessage(err) });
    } finally {
      setHardSyncing(false);
    }
  }, [sid]);

  const runSync = useCallback(async () => {
    if (!sid) return;
    setSyncing(true);
    try {
      const res = await api.storesSync({ storeId: sid });
      if (res.skipped && res.reason === 'auth_error') {
        toast.error('This store’s API key was rejected', { description: 'Replace the key in Stores → menu → Replace API key.' });
      }
    } catch (err) {
      toast.error('Sync failed', { description: callableMessage(err) });
    } finally {
      setSyncing(false);
    }
  }, [sid]);

  useAutoSync(
    canSync ? (sid ?? null) : null,
    store.exists === true && isStale(store.data?.appsSyncedAt, STALE_APPS_LIST_MS),
    runSync,
  );

  const visible = apps.rows.filter(
    (a) =>
      !a.data.removedFromAsc &&
      (search.trim() === '' ||
        a.data.name.toLowerCase().includes(search.trim().toLowerCase()) ||
        a.data.bundleId.toLowerCase().includes(search.trim().toLowerCase())),
  ).sort((a, b) => {
    const activity = (row: typeof a) =>
      row.data.lastActivityAt?.toMillis()
      ?? row.data.lastEditedAt?.toMillis()
      ?? row.data.deepSyncedAt?.toMillis()
      ?? 0;
    return activity(b) - activity(a) || a.data.name.localeCompare(b.data.name);
  });

  return (
    <Page
      wide
      title={
        <span className="flex items-center gap-2.5">
          {store.data && <StoreGlyph color={store.data.color} icon={store.data.icon} seed={sid} size="md" />}
          {store.data?.name ?? '…'}
        </span>
      }
      description={
        store.data
          ? `${visible.length} apps · list synced ${timeAgo(store.data.appsSyncedAt)}`
          : undefined
      }
      actions={
        <>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="w-56 pl-8"
              placeholder="Search apps…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          {canProvision && (
            <Button variant="outline" onClick={() => setDevOpen(true)}>
              <Hammer className="size-3.5" /> Developer
            </Button>
          )}
          {isAdminUser && (
            <Button variant="outline" onClick={() => void runHardSync()} loading={hardSyncing} title="Re-fetch everything: app list, every app in depth, finance">
              <Zap className="size-3.5" /> Hard sync
            </Button>
          )}
          {canSync && (
            <Button variant="outline" onClick={() => void runSync()} loading={syncing}>
              <RefreshCw className="size-3.5" /> Sync
            </Button>
          )}
          {user?.role === 'admin' && (
            <Link to={`/stores/${sid}/finance`}>
              <Button variant="outline">
                <LineChart className="size-3.5" /> Finance
              </Button>
            </Link>
          )}
        </>
      }
    >
      {sid && <DeveloperDialog storeId={sid} open={devOpen} onOpenChange={setDevOpen} />}
      {store.data?.status === 'auth_error' && (
        <div className="mb-4 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-[13px] text-destructive">
          The API key for this store was rejected by Apple. Syncing is paused — replace the key from
          the Stores page.
        </div>
      )}

      {apps.loading ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <EmptyState
          icon={AppWindow}
          title={apps.rows.length === 0 ? 'No apps synced yet' : 'No apps match your search'}
          description={apps.rows.length === 0 ? 'Hit Sync to pull the app list from App Store Connect.' : undefined}
          action={
            apps.rows.length === 0 && canSync ? (
              <Button onClick={() => void runSync()} loading={syncing}>
                <RefreshCw className="size-3.5" /> Sync now
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {visible.map((a) => {
            const ios = a.data.versions?.IOS;
            const editable = hasEditableVersion(a.data, 'IOS');
            const syncing = (a.data.sync?.leaseUntil?.toMillis() ?? 0) > Date.now();
            const activityAt = a.data.lastActivityAt ?? a.data.lastEditedAt ?? a.data.deepSyncedAt;
            const editedRecently = !!a.data.lastEditedAt && Date.now() - a.data.lastEditedAt.toMillis() < 86_400_000;
            return (
              <Link
                key={a.id}
                to={`/stores/${sid}/apps/${a.id}`}
                className="flex items-center gap-4 rounded-xl border bg-card p-4 shadow-card transition-shadow hover:shadow-pop"
              >
                <AppGlyph name={a.data.name} iconUrl={a.data.iconUrl} seed={a.id} size="lg" className="rounded-[22%]" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[14px] font-semibold">{a.data.name}</div>
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate text-xs text-muted-foreground">{a.data.bundleId}</span>
                    <PlatformBadges platforms={a.data.platforms} devices={a.data.devices} className="shrink-0" />
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    {syncing && <Badge variant="warning"><RefreshCw className="size-3 animate-spin" /> Syncing</Badge>}
                    {(a.data.pendingDraftFields ?? 0) > 0 && (
                      <Badge variant="accent">{a.data.pendingDraftFields} pending</Badge>
                    )}
                    {editedRecently && <Badge variant="success">Recently edited</Badge>}
                    {ios?.live && <Badge variant="success">v{ios.live.versionString} live</Badge>}
                    {ios?.editable && (
                      <Badge variant={versionBucket(ios.editable.state) === 'rejected' ? 'destructive' : 'accent'}>
                        v{ios.editable.versionString} {describeVersionState(ios.editable.state).toLowerCase()}
                      </Badge>
                    )}
                    {!editable && !ios?.editable && <Badge variant="outline">no draft version</Badge>}
                    <Badge variant="neutral">{a.data.locales?.length ?? 0} languages</Badge>
                  </div>
                  <div className="mt-1.5 flex items-center gap-1 text-[11px] text-muted-foreground">
                    <Clock3 className="size-3" />
                    {a.data.lastEditedAt
                      ? `Edited ${timeAgo(a.data.lastEditedAt)}`
                      : `Synced ${timeAgo(activityAt)}`}
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </Page>
  );
}
