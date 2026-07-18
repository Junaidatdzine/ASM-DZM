import { useCallback, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { collection, doc, query } from 'firebase/firestore';
import { ArrowLeft, ChevronRight, Columns3, Glasses, LayoutList, Monitor, Plus, RefreshCw, Rocket, Smartphone, Tv } from 'lucide-react';
import { toast } from 'sonner';
import type { AppDoc, DraftDoc, LocaleDoc, MetadataField, Platform, StoreDoc } from '@asm/shared';
import {
  ALL_FIELDS,
  can,
  describeVersionState,
  versionBucket,
  fieldKeyFor,
  hasEditableVersion,
  primaryLocalizedAppName,
} from '@asm/shared';
import { db } from '@/lib/firebase';
import { api, callableMessage } from '@/lib/callables';
import { useLiveDoc, useLiveQuery } from '@/lib/hooks';
import { STALE_APP_DEEP_MS, isStale, useAutoSync } from '@/lib/staleness';
import { useSession } from '@/auth/AuthProvider';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/Tabs';
import { Tooltip } from '@/components/ui/Tooltip';
import { cn, timeAgo } from '@/lib/utils';
import { LocaleSidebar } from './LocaleSidebar';
import { MetadataFieldRow } from './MetadataField';
import { buildFieldViews, cacheValue } from './model';
import { useDraftEditor } from './useDraftEditor';
import { PushDrawer } from './PushDrawer';
import { AddLanguageDialog, CreateVersionDialog, RemoveLanguageDialog } from './LanguageOps';
import { ScreenshotsMatrixView } from '@/features/screenshots/ScreenshotsMatrixView';
import { VersionInfoTab } from '@/features/version/VersionInfoTab';
import { ReleaseTab } from '@/features/release/ReleaseTab';
import { ReviewsTab } from '@/features/reviews/ReviewsTab';
import { StoreExtrasTab } from '@/features/store-extras/StoreExtrasTab';
import { AiDialog } from '@/features/ai/AiDialog';
import { MatrixView } from './MatrixView';
import { StoreDot } from '@/components/StoreGlyph';

const PLATFORM_META: Record<string, { label: string; icon: typeof Smartphone }> = {
  IOS: { label: 'iOS', icon: Smartphone },
  MAC_OS: { label: 'Mac', icon: Monitor },
  TV_OS: { label: 'TV', icon: Tv },
  VISION_OS: { label: 'Vision', icon: Glasses },
};

export function EditorPage() {
  const { sid, aid } = useParams<{ sid: string; aid: string }>();
  const [params, setParams] = useSearchParams();
  const { user } = useSession();

  const store = useLiveDoc<StoreDoc>(sid ? doc(db, 'stores', sid) : null);
  const app = useLiveDoc<AppDoc>(sid && aid ? doc(db, 'stores', sid, 'apps', aid) : null);
  const localesQ = useLiveQuery<LocaleDoc>(
    useMemo(() => (sid && aid ? query(collection(db, 'stores', sid, 'apps', aid, 'locales')) : null), [sid, aid]),
    `locales-${sid}-${aid}`,
  );
  const draftsQ = useLiveQuery<DraftDoc>(
    useMemo(() => (sid && aid ? query(collection(db, 'stores', sid, 'apps', aid, 'drafts')) : null), [sid, aid]),
    `drafts-${sid}-${aid}`,
  );

  const locales = useMemo(() => new Map(localesQ.rows.map((r) => [r.id, r.data])), [localesQ.rows]);
  const drafts = useMemo(() => new Map(draftsQ.rows.map((r) => [r.id, r.data])), [draftsQ.rows]);

  // Multi-platform apps (iOS + Mac) keep separate metadata/screenshots per
  // platform — the selected one lives in the URL so links keep their context.
  const appPlatforms = (app.data?.platforms?.length ? app.data.platforms : ['IOS']) as Platform[];
  const platformParam = params.get('platform') as Platform | null;
  const platform: Platform = platformParam && appPlatforms.includes(platformParam) ? platformParam : appPlatforms[0]!;
  const setPlatform = (next: Platform) =>
    setParams((p) => {
      p.set('platform', next);
      return p;
    });
  const selectedLocale = params.get('locale') ?? app.data?.primaryLocale ?? null;
  const tab = params.get('tab') ?? 'text';
  const screenshotType = params.get('device');
  // Field-first is the primary workflow: operators usually need to compare one
  // metadata value across every market before drilling into a single language.
  const view = params.get('view') === 'language' ? 'language' : 'field';
  const setView = (v: 'field' | 'language') => setParams((p) => { p.set('view', v); return p; });
  const fieldParam = params.get('field');
  const selectedField: MetadataField = ALL_FIELDS.includes(fieldParam as MetadataField)
    ? (fieldParam as MetadataField)
    : 'name';

  const [syncing, setSyncing] = useState(false);
  const [pushOpen, setPushOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<string | null>(null);
  const [createVersionOpen, setCreateVersionOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const runSync = useCallback(async () => {
    if (!sid || !aid) return;
    setSyncing(true);
    try {
      await api.appsSyncOne({ storeId: sid, appId: aid });
    } catch (err) {
      toast.error('Sync failed', { description: callableMessage(err) });
    } finally {
      setSyncing(false);
    }
  }, [sid, aid]);

  useAutoSync(
    sid && aid ? `${sid}/${aid}` : null,
    app.exists === true && (app.data?.deepSyncSchemaVersion !== 2 || isStale(app.data?.deepSyncedAt, STALE_APP_DEEP_MS)),
    runSync,
  );

  const canEdit = !!user && !!sid && can(user, 'editDrafts', sid, aid);
  const canPush = !!user && !!sid && can(user, 'push', sid, aid);
  const canUseAi = !!user && !!sid && can(user, 'useAi', sid, aid);
  const canAddLanguage = !!user && !!sid && can(user, 'addLanguage', sid, aid);
  const canManageVersion = !!user && !!sid && can(user, 'createVersion', sid, aid);
  const localeDoc = selectedLocale ? (locales.get(selectedLocale) ?? null) : null;
  const draft = selectedLocale ? (drafts.get(selectedLocale) ?? null) : null;
  const headerName = app.data
    ? primaryLocalizedAppName(
        app.data,
        platform,
        locales.get(app.data.primaryLocale) ?? null,
        drafts.get(app.data.primaryLocale) ?? null,
      )
    : '…';

  const cacheFor = useCallback(
    (key: string): string => {
      if (!app.data || !localeDoc) return '';
      const field = ALL_FIELDS.find((f) => fieldKeyFor(platform, f) === key);
      if (!field) return '';
      const views = buildFieldViews(app.data, platform, localeDoc, null, [field]);
      return views[0]?.cache ?? cacheValue(localeDoc, platform, field, views[0]!.status);
    },
    [app.data, localeDoc, platform],
  );

  const editor = useDraftEditor(sid ?? '', aid ?? '', selectedLocale, draft, cacheFor);

  const totalDraftFields = useMemo(
    () => draftsQ.rows.reduce((n, r) => n + Object.keys(r.data.fields ?? {}).length, 0),
    [draftsQ.rows],
  );

  if (!sid || !aid) return null;
  if (app.exists === false) {
    return (
      <div className="p-10 text-center text-[13px] text-muted-foreground">App not found.</div>
    );
  }

  const ios = app.data?.versions?.[platform];
  const editable = app.data ? hasEditableVersion(app.data, platform) : false;
  const views =
    app.data && selectedLocale
      ? buildFieldViews(app.data, platform, localeDoc, draft, ALL_FIELDS)
      : [];

  return (
    <div className="mx-auto w-full max-w-[1400px] px-6 py-5">
      {/* Header */}
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <Link
            to={`/stores/${sid}`}
            className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <ArrowLeft className="size-4" />
          </Link>
          {app.data?.iconUrl ? (
            <img src={app.data.iconUrl} alt="" className="size-10 rounded-[22%] border object-cover" />
          ) : (
            <div className="flex size-10 items-center justify-center rounded-[22%] border bg-accent text-base font-bold text-accent-foreground">
              {app.data?.name?.slice(0, 1) ?? '…'}
            </div>
          )}
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <StoreDot color={store.data?.color} seed={sid} />
              <span className="truncate">{store.data?.name}</span>
              <ChevronRight className="size-3" />
              <span>App workspace</span>
            </div>
            <h1 className="truncate text-[16px] font-semibold leading-tight">{headerName}</h1>
          </div>
          <div className="flex w-full flex-wrap items-center gap-1.5 sm:ml-2 sm:w-auto">
            {appPlatforms.length > 1 ? (
              <div className="mr-1 inline-flex rounded-lg border bg-muted p-0.5" title="This app ships on several platforms — each has its own metadata and screenshots">
                {appPlatforms.map((p) => {
                  const Icon = PLATFORM_META[p]?.icon ?? Smartphone;
                  const on = platform === p;
                  return (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setPlatform(p)}
                      className={cn(
                        'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] font-semibold transition-colors',
                        on ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                      )}
                    >
                      <Icon className="size-3.5" /> {PLATFORM_META[p]?.label ?? p}
                    </button>
                  );
                })}
              </div>
            ) : (
              <Badge variant="neutral" className="mr-1">
                {(() => { const Icon = PLATFORM_META[platform]?.icon ?? Smartphone; return <Icon className="size-3" />; })()}
                {PLATFORM_META[platform]?.label ?? platform}
              </Badge>
            )}
            {ios?.live && <Badge variant="success">v{ios.live.versionString} live</Badge>}
            {ios?.review && (
              <Badge variant={versionBucket(ios.review.state) === 'rejected' ? 'destructive' : 'accent'}>
                v{ios.review.versionString} · {describeVersionState(ios.review.state)}
              </Badge>
            )}
            {ios?.editable ? (
              <Tooltip content={canManageVersion ? 'Change editable version number' : describeVersionState(ios.editable.state)}>
                <button onClick={() => (canManageVersion ? setCreateVersionOpen(true) : undefined)}>
                  <Badge variant={versionBucket(ios.editable.state) === 'rejected' ? 'destructive' : 'accent'}>
                    v{ios.editable.versionString} · {describeVersionState(ios.editable.state)}
                  </Badge>
                </button>
              </Tooltip>
            ) : !ios?.review ? (
              canManageVersion ? (
                <Button size="sm" variant="outline" onClick={() => setCreateVersionOpen(true)}>
                  <Plus className="size-3.5" /> New version
                </Button>
              ) : (
                <Tooltip content="Only promotional text can change while nothing is in preparation. A manager can create a new version to unlock everything.">
                  <Badge variant="outline">no editable version</Badge>
                </Tooltip>
              )
            ) : null}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground">synced {timeAgo(app.data?.deepSyncedAt)}</span>
          <Button variant="outline" size="sm" onClick={() => void runSync()} loading={syncing}>
            <RefreshCw className="size-3.5" /> Sync
          </Button>
          <Button size="sm" disabled={!canPush || totalDraftFields === 0} onClick={() => setPushOpen(true)}>
            <Rocket className="size-3.5" /> Review & Push
            {totalDraftFields > 0 && (
              <span className="rounded-full bg-primary-foreground/20 px-1.5 text-[11px] tabular-nums">
                {totalDraftFields}
              </span>
            )}
          </Button>
        </div>
      </div>

      {/* Body */}
      <div className="flex flex-col gap-6 lg:flex-row">
        {tab === 'text' && view === 'language' && app.data ? (
          <LocaleSidebar
            app={app.data}
            platform={platform}
            locales={locales}
            drafts={drafts}
            selected={selectedLocale}
            onSelect={(loc) => setParams((p) => {
              p.set('locale', loc);
              return p;
            })}
            onAddLanguage={() => setAddOpen(true)}
            onRemoveLanguage={(loc) => setRemoveTarget(loc)}
            canAdd={canAddLanguage}
            canRemove={!!user && !!sid && can(user, 'removeLanguage', sid, aid)}
          />
        ) : tab === 'text' && view === 'language' ? (
          <Skeleton className="h-80 w-60" />
        ) : null}

        <div className="min-w-0 flex-1">
          <Tabs
            value={tab}
            onValueChange={(v) => setParams((p) => {
              p.set('tab', v);
              // Screenshots always use the device-first inline matrix.
              if (v === 'screenshots') p.delete('shotLocale');
              return p;
            })}
          >
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <div className="max-w-full overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                <TabsList>
                  <TabsTrigger value="text">Metadata</TabsTrigger>
                  <TabsTrigger value="screenshots">Screenshots</TabsTrigger>
                  <TabsTrigger value="version">Version</TabsTrigger>
                  <TabsTrigger value="release">Release</TabsTrigger>
                  <TabsTrigger value="reviews">Reviews</TabsTrigger>
                  <TabsTrigger value="store">Store</TabsTrigger>
                </TabsList>
              </div>
              {tab === 'text' ? (
                <div className="flex items-center gap-2">
                  {canAddLanguage && (
                    <Button variant="outline" size="sm" onClick={() => setAddOpen(true)}>
                      <Plus className="size-3.5" /> Add language
                    </Button>
                  )}
                  <div className="inline-flex rounded-lg bg-muted p-0.5">
                    <button
                      onClick={() => setView('language')}
                      className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors ${
                        view === 'language' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      <LayoutList className="size-3.5" /> By language
                    </button>
                    <button
                      onClick={() => setView('field')}
                      className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors ${
                        view === 'field' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      <Columns3 className="size-3.5" /> By field
                    </button>
                  </div>
                </div>
              ) : tab === 'screenshots' && canAddLanguage ? (
                <Button variant="outline" size="sm" onClick={() => setAddOpen(true)}>
                  <Plus className="size-3.5" /> Add language
                </Button>
              ) : null}
            </div>

            <TabsContent value="text">
              {app.loading || localesQ.loading ? (
                <div className="space-y-3">
                  {[0, 1, 2].map((i) => (
                    <Skeleton key={i} className="h-28" />
                  ))}
                </div>
              ) : view === 'field' && app.data ? (
                <MatrixView
                  storeId={sid}
                  appId={aid}
                  platform={platform}
                  app={app.data}
                  locales={locales}
                  drafts={drafts}
                  canEdit={canEdit}
                  selectedField={selectedField}
                  onSelectField={(field) => setParams((p) => { p.set('field', field); return p; })}
                  aiEnabled={canEdit && canUseAi && !!(user?.ai?.features.translate || user?.ai?.features.generate)}
                  onOpenAi={() => setAiOpen(true)}
                  onFocusLocale={(loc) => setParams((p) => { p.set('locale', loc); p.set('view', 'language'); return p; })}
                />
              ) : !selectedLocale ? (
                <p className="py-10 text-center text-[13px] text-muted-foreground">Pick a language on the left.</p>
              ) : !editable && views.every((v) => !v.status.editable) ? (
                <div className="space-y-3">
                  <div className="rounded-xl border border-dashed p-4 text-[13px] text-muted-foreground">
                    v{ios?.live?.versionString} is live — Apple locks its metadata. Promotional text stays
                    editable below; everything else needs a new version.
                  </div>
                  {views.map((v) => (
                    <MetadataFieldRow
                      key={v.key}
                      view={{ ...v, value: editor.overlay(v.key, v.value) }}
                      canEdit={canEdit}
                      onChange={(value) => editor.set(v.key, value)}
                      onRevert={() => void editor.revert(v.key)}
                      onKeepMine={() => void editor.keepMine(v.key)}
                    />
                  ))}
                </div>
              ) : (
                <div className="space-y-3">
                  {views.map((v) => (
                    <MetadataFieldRow
                      key={v.key}
                      view={{ ...v, value: editor.overlay(v.key, v.value) }}
                      canEdit={canEdit}
                      onChange={(value) => editor.set(v.key, value)}
                      onRevert={() => void editor.revert(v.key)}
                      onKeepMine={() => void editor.keepMine(v.key)}
                    />
                  ))}
                </div>
              )}
            </TabsContent>

            <TabsContent value="version">
              {app.data ? (
                <VersionInfoTab
                  storeId={sid}
                  appId={aid}
                  platform={platform}
                  app={app.data}
                  canManage={canManageVersion}
                  onCreateVersion={() => setCreateVersionOpen(true)}
                />
              ) : (
                <Skeleton className="h-96" />
              )}
            </TabsContent>

            <TabsContent value="release">
              {app.data ? (
                <ReleaseTab
                  storeId={sid}
                  appId={aid}
                  platform={platform}
                  app={app.data}
                  canManage={canManageVersion}
                  onCreateVersion={() => setCreateVersionOpen(true)}
                />
              ) : (
                <Skeleton className="h-96" />
              )}
            </TabsContent>

            <TabsContent value="reviews">
              <ReviewsTab storeId={sid} appId={aid} platform={platform} canRespond={canPush} />
            </TabsContent>

            <TabsContent value="store">
              <StoreExtrasTab storeId={sid} appId={aid} platform={platform} />
            </TabsContent>

            <TabsContent value="screenshots">
              {app.data ? (
                <ScreenshotsMatrixView
                  storeId={sid}
                  appId={aid}
                  platform={platform}
                  app={app.data}
                  canEdit={!!user && can(user, 'manageScreenshots', sid, aid)}
                  selectedType={screenshotType}
                  onSelectType={(displayType) => setParams((p) => { p.set('device', displayType); return p; })}
                />
              ) : (
                <Skeleton className="h-96" />
              )}
            </TabsContent>
          </Tabs>
        </div>
      </div>

      {app.data && sid && aid && (
        <>
          <PushDrawer
            open={pushOpen}
            onOpenChange={setPushOpen}
            storeId={sid}
            appId={aid}
            platform={platform}
            app={app.data}
            locales={locales}
            drafts={drafts}
          />
          <AddLanguageDialog
            open={addOpen}
            onOpenChange={setAddOpen}
            storeId={sid}
            appId={aid}
            platform={platform}
            app={app.data}
          />
          <RemoveLanguageDialog
            locale={removeTarget}
            onOpenChange={() => setRemoveTarget(null)}
            storeId={sid}
            appId={aid}
            platform={platform}
          />
          <CreateVersionDialog
            open={createVersionOpen}
            onOpenChange={setCreateVersionOpen}
            storeId={sid}
            appId={aid}
            platform={platform}
            app={app.data}
          />
          <AiDialog
            open={aiOpen}
            onOpenChange={setAiOpen}
            storeId={sid}
            appId={aid}
            platform={platform}
            app={app.data}
            currentLocale={selectedLocale}
            selectedField={view === 'field' ? selectedField : null}
            onApplyToDraft={(fieldKey, value) => editor.set(fieldKey, value)}
          />
        </>
      )}
    </div>
  );
}
