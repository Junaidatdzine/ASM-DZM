import { useEffect, useMemo, useRef, useState } from 'react';
import { collection, query, where } from 'firebase/firestore';
import { ref as storageRef, uploadBytesResumable } from 'firebase/storage';
import { Eye, ImagePlus, Images, Loader2, RefreshCw, Search, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import type { AppDoc, Platform, ScreenshotSetDoc } from '@asm/shared';
import {
  MAX_SCREENSHOTS_PER_SET,
  MAX_SCREENSHOT_BYTES,
  SCREENSHOT_SPECS,
  hasEditableVersion,
  localeInfo,
  screenshotSpecLabel,
  sortLocales,
  validateScreenshotDimensions,
} from '@asm/shared';
import { db, storage } from '@/lib/firebase';
import { api, callableMessage } from '@/lib/callables';
import { useLiveQuery } from '@/lib/hooks';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { cn } from '@/lib/utils';
import { screenshotThumbUrl } from './ScreenshotsTab';
import { useSession } from '@/auth/AuthProvider';
import { Dialog, DialogContent, DialogHeader } from '@/components/ui/Dialog';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';

type InlineUpload = { locale: string; fileName: string; phase: string; progress: number; error?: string };

export function ScreenshotsMatrixView({
  storeId,
  appId,
  platform,
  app,
  canEdit,
  selectedType,
  onSelectType,
}: {
  storeId: string;
  appId: string;
  platform: Platform;
  app: AppDoc;
  canEdit: boolean;
  selectedType: string | null;
  onSelectType: (displayType: string) => void;
}) {
  const { uid } = useSession();
  const branch = hasEditableVersion(app, platform) ? 'editable' : 'live';
  const setsQ = useLiveQuery<ScreenshotSetDoc>(
    useMemo(
      () =>
        query(
          collection(db, 'stores', storeId, 'apps', appId, 'screenshotSets'),
          where('platform', '==', platform),
          where('branch', '==', branch),
        ),
      [storeId, appId, platform, branch],
    ),
    `shot-matrix-${storeId}-${appId}-${platform}-${branch}`,
  );
  const [queryText, setQueryText] = useState('');
  const [filter, setFilter] = useState<'all' | 'attention' | 'ready'>('all');
  const [syncing, setSyncing] = useState(false);
  const [uploads, setUploads] = useState<Record<string, InlineUpload>>({});
  const [preview, setPreview] = useState<{ url: string; name: string; locale: string } | null>(null);
  const [draggedShot, setDraggedShot] = useState<{ locale: string; id: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ locale: string; id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const syncedOnce = useRef(false);
  const locales = sortLocales(app.locales ?? [], app.primaryLocale);

  const syncAll = async (announce = false) => {
    setSyncing(true);
    try {
      const result = await api.screenshotsSyncAll({ storeId, appId, platform });
      if (announce) {
        toast.success('Screenshots refreshed', {
          description: `${result.localesSynced} languages · ${result.sets} device-size sets`,
        });
      }
    } catch (error) {
      if (announce) toast.error('Refresh failed', { description: callableMessage(error) });
    } finally {
      setSyncing(false);
    }
  };

  useEffect(() => {
    if (syncedOnce.current) return;
    syncedOnce.current = true;
    void syncAll(false);
    // One background reconciliation per mounted matrix.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId, appId, platform, branch]);

  const displayTypes = useMemo(() => {
    const types = [...new Set(setsQ.rows.map((row) => row.data.displayType))];
    return types.sort((a, b) => {
      const aOrder = SCREENSHOT_SPECS.find((spec) => spec.displayType === a)?.order ?? 999;
      const bOrder = SCREENSHOT_SPECS.find((spec) => spec.displayType === b)?.order ?? 999;
      return aOrder - bOrder || screenshotSpecLabel(a).localeCompare(screenshotSpecLabel(b));
    });
  }, [setsQ.rows]);
  const activeType = selectedType && displayTypes.includes(selectedType) ? selectedType : (displayTypes[0] ?? null);

  useEffect(() => {
    if (activeType && activeType !== selectedType) onSelectType(activeType);
  }, [activeType, selectedType, onSelectType]);

  const rows = locales.map((locale) => {
    const set = activeType
      ? setsQ.rows.find((row) => row.data.locale === locale && row.data.displayType === activeType)?.data ?? null
      : null;
    const screenshots = [...(set?.screenshots ?? [])].sort((a, b) => a.position - b.position);
    const failed = screenshots.some((shot) => shot.state === 'failed');
    const processing = screenshots.some((shot) => shot.state !== 'complete' && shot.state !== 'failed');
    const state = failed ? 'error' : processing ? 'processing' : screenshots.length === 0 ? 'missing' : 'ready';
    return { locale, set, screenshots, state };
  });
  const counts = {
    ready: rows.filter((row) => row.state === 'ready').length,
    attention: rows.filter((row) => row.state !== 'ready').length,
    screenshots: rows.reduce((sum, row) => sum + row.screenshots.length, 0),
  };
  const visibleRows = rows.filter((row) => {
    const info = localeInfo(row.locale);
    const needle = queryText.trim().toLowerCase();
    const queryMatches = needle === '' || info.name.toLowerCase().includes(needle) || row.locale.toLowerCase().includes(needle);
    const filterMatches = filter === 'all' || (filter === 'ready' && row.state === 'ready') || (filter === 'attention' && row.state !== 'ready');
    return queryMatches && filterMatches;
  });

  const uploadFiles = async (locale: string, files: FileList | File[], currentCount: number) => {
    if (!activeType || !uid || !canEdit || branch !== 'editable') return;
    const list = [...files].slice(0, MAX_SCREENSHOTS_PER_SET - currentCount);
    if (!list.length) return toast.warning('This set already has 10 screenshots.');
    for (const file of list) {
      const id = `${locale}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const update = (patch: Partial<InlineUpload>) => setUploads((prev) => ({
        ...prev,
        [id]: { ...(prev[id] ?? { locale, fileName: file.name, phase: 'Validating', progress: 0 }), ...patch },
      }));
      update({});
      try {
        if (file.size > MAX_SCREENSHOT_BYTES) throw new Error('Image exceeds 12 MB.');
        if (!/image\/(png|jpeg)/.test(file.type)) throw new Error('Only PNG and JPEG are supported.');
        const bitmap = await createImageBitmap(file);
        const error = validateScreenshotDimensions(activeType, bitmap.width, bitmap.height);
        bitmap.close();
        if (error) throw new Error(error);
        const path = `staging/${uid}/${id}-${file.name.replace(/[^\w.-]+/g, '_')}`;
        const task = uploadBytesResumable(storageRef(storage, path), file, { contentType: file.type });
        await new Promise<void>((resolve, reject) => task.on('state_changed', (snap) => {
          update({ phase: 'Uploading', progress: Math.round((snap.bytesTransferred / snap.totalBytes) * 100) });
        }, reject, resolve));
        update({ phase: 'Sending to Apple', progress: 100 });
        const result = await api.screenshotsUpload({ storeId, appId, platform, locale, displayType: activeType, storagePath: path, fileName: file.name });
        update({ phase: 'Processing', progress: 100 });
        for (let attempt = 0; attempt < 12; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 2500));
          const poll = await api.screenshotsPollState({ storeId, appId, platform, locale, displayType: activeType, screenshotId: result.screenshotId });
          if (poll.state === 'COMPLETE') break;
          if (poll.state === 'FAILED') throw new Error('Apple rejected this screenshot.');
        }
        setUploads((prev) => { const next = { ...prev }; delete next[id]; return next; });
      } catch (error) {
        update({ phase: 'Failed', error: error instanceof Error ? error.message : callableMessage(error) });
      }
    }
  };

  const reorder = async (locale: string, screenshots: typeof rows[number]['screenshots'], overId: string) => {
    if (!activeType || !draggedShot || draggedShot.locale !== locale || draggedShot.id === overId) return;
    const ids = screenshots.map((shot) => shot.id);
    const from = ids.indexOf(draggedShot.id);
    const to = ids.indexOf(overId);
    if (from < 0 || to < 0) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]!);
    setDraggedShot(null);
    try {
      await api.screenshotsReorder({ storeId, appId, platform, locale, displayType: activeType, orderedIds: ids });
    } catch (error) {
      toast.error('Reorder failed', { description: callableMessage(error) });
    }
  };

  if (setsQ.loading && setsQ.rows.length === 0) {
    return <Skeleton className="h-96" />;
  }

  return (
    <div className="space-y-4">
      {displayTypes.length > 0 && (
        <div className="overflow-x-auto border-b">
          <div className="flex min-w-max gap-1" role="tablist" aria-label="Screenshot device sizes">
            {displayTypes.map((displayType) => {
              const covered = setsQ.rows.filter(
                (row) => row.data.displayType === displayType && row.data.screenshots.length > 0,
              ).length;
              const active = displayType === activeType;
              return (
                <button
                  key={displayType}
                  role="tab"
                  aria-selected={active}
                  onClick={() => onSelectType(displayType)}
                  className={cn(
                    'relative min-w-32 px-3 pb-3 pt-1 text-left transition-colors',
                    active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  <span className="block text-[12px] font-semibold">{screenshotSpecLabel(displayType)}</span>
                  <span className="mt-0.5 block text-[10px] tabular-nums">{covered}/{locales.length} languages</span>
                  {active && <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-primary" />}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <section className="overflow-hidden rounded-xl border bg-card shadow-card">
        <div className="border-b px-4 py-3.5 sm:px-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-[15px] font-semibold">
                  {activeType ? screenshotSpecLabel(activeType) : 'Screenshots'}
                </h2>
                <Badge variant={branch === 'editable' ? 'accent' : 'outline'}>
                  {branch === 'editable' ? 'Editable version' : 'Live · read only'}
                </Badge>
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">
                Compare the same device-size screenshot set across every App Store language.
              </p>
            </div>
            <div className="flex items-center gap-x-4 text-[11px] tabular-nums text-muted-foreground">
              <span><strong className="font-semibold text-foreground">{counts.ready}</strong> ready</span>
              <span><strong className={cn('font-semibold', counts.attention ? 'text-warning' : 'text-foreground')}>{counts.attention}</strong> need attention</span>
              <span><strong className="font-semibold text-foreground">{counts.screenshots}</strong> images</span>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <div className="inline-flex rounded-lg bg-muted p-0.5">
                {([
                  ['all', `All ${locales.length}`],
                  ['attention', `Needs attention ${counts.attention}`],
                  ['ready', `Ready ${counts.ready}`],
                ] as const).map(([key, label]) => (
                  <button
                    key={key}
                    onClick={() => setFilter(key)}
                    className={cn(
                      'rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors',
                      filter === key ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <Button variant="outline" size="sm" onClick={() => void syncAll(true)} loading={syncing}>
                <RefreshCw className="size-3.5" /> Refresh all
              </Button>
            </div>
            <label className="relative block w-full sm:w-56">
              <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                value={queryText}
                onChange={(event) => setQueryText(event.target.value)}
                placeholder="Find language…"
                className="h-8 w-full rounded-md border bg-background pl-8 pr-3 text-[12px] outline-none transition-shadow focus:ring-2 focus:ring-ring/30"
              />
            </label>
          </div>
        </div>

        {!activeType ? (
          <div className="flex flex-col items-center justify-center gap-3 px-5 py-14 text-center">
            <Images className="size-5 text-muted-foreground" />
            <div>
              <p className="text-[13px] font-medium">{syncing ? 'Loading screenshot sets…' : 'No screenshot sets found'}</p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {syncing ? 'Reconciling every language with App Store Connect.' : 'Open a language to add the first device size.'}
              </p>
            </div>
            {!syncing && <Button size="sm" variant="outline" onClick={() => void syncAll(true)}>Refresh device sizes</Button>}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <div className="min-w-[900px]">
              <div className="grid grid-cols-[190px_minmax(480px,1fr)_110px_86px] gap-3 border-b bg-muted/35 px-4 py-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground sm:px-5">
                <span>Language</span>
                <span>Screenshot set</span>
                <span>Status</span>
                <span className="text-right">Action</span>
              </div>
              <div className="divide-y">
                {visibleRows.map((row) => {
                  const info = localeInfo(row.locale);
                  const isPrimary = row.locale === app.primaryLocale;
                  const status =
                    row.state === 'ready'
                      ? { label: `${row.screenshots.length}/${MAX_SCREENSHOTS_PER_SET} Ready`, variant: 'success' as const }
                      : row.state === 'processing'
                        ? { label: 'Processing', variant: 'accent' as const }
                        : row.state === 'error'
                          ? { label: 'Error', variant: 'destructive' as const }
                          : { label: 'Missing', variant: 'warning' as const };
                  return (
                    <div key={row.locale} className="grid min-h-28 grid-cols-[190px_minmax(480px,1fr)_110px_86px] items-center gap-3 px-4 py-2.5 sm:px-5">
                      <div className="flex min-w-0 items-center gap-2 text-left">
                        <span className="text-base leading-none">{info.flag}</span>
                        <span className="min-w-0">
                          <span className="flex items-center gap-1.5">
                            <span className="truncate text-[12px] font-medium">{info.name}</span>
                            {isPrimary && <span className="text-[10px] text-warning">★</span>}
                          </span>
                          <span className="block text-[10px] text-muted-foreground">{row.locale}</span>
                        </span>
                      </div>
                      <div
                        className="flex min-w-0 items-center gap-2 overflow-x-auto overscroll-x-contain py-1 [scrollbar-width:thin]"
                        onDragOver={(event) => event.preventDefault()}
                        onDrop={(event) => {
                          event.preventDefault();
                          if (event.dataTransfer.files.length) void uploadFiles(row.locale, event.dataTransfer.files, row.screenshots.length);
                        }}
                      >
                        {row.screenshots.map((shot) => {
                          const url = screenshotThumbUrl(shot, 120);
                          return (
                            <div
                              key={shot.id}
                              role="button"
                              tabIndex={0}
                              draggable={canEdit && branch === 'editable'}
                              onDragStart={() => setDraggedShot({ locale: row.locale, id: shot.id })}
                              onDragOver={(event) => event.preventDefault()}
                              onDrop={(event) => { event.preventDefault(); event.stopPropagation(); void reorder(row.locale, row.screenshots, shot.id); }}
                              onClick={() => {
                                const full = screenshotThumbUrl(shot, 1200);
                                if (full) setPreview({ url: full, name: shot.fileName, locale: info.name });
                              }}
                              onKeyDown={(event) => {
                                if (event.key !== 'Enter' && event.key !== ' ') return;
                                event.preventDefault();
                                const full = screenshotThumbUrl(shot, 1200);
                                if (full) setPreview({ url: full, name: shot.fileName, locale: info.name });
                              }}
                              className="group relative h-20 shrink-0 overflow-hidden rounded-md border bg-muted text-left"
                              style={{ aspectRatio: shot.width && shot.height ? `${shot.width}/${shot.height}` : '9/19.5' }}
                              title={shot.fileName}
                            >
                              {url && shot.state === 'complete' ? (
                                <img src={url} alt="" className="size-full object-cover" />
                              ) : (
                                <div className="flex size-full items-center justify-center">
                                  <Loader2 className={cn('size-3.5 text-muted-foreground', shot.state !== 'failed' && 'animate-spin')} />
                                </div>
                              )}
                              <span className="absolute left-1 top-1 rounded bg-black/60 px-1 text-[9px] font-semibold text-white">{shot.position + 1}</span>
                              {url && <span className="absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition group-hover:bg-black/25 group-hover:opacity-100"><Eye className="size-4 text-white" /></span>}
                              {canEdit && branch === 'editable' && (
                                <button
                                  type="button"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    setDeleteTarget({ locale: row.locale, id: shot.id, name: shot.fileName });
                                  }}
                                  aria-label={`Delete ${shot.fileName}`}
                                  className="absolute right-1 top-1 rounded bg-black/65 p-1 text-white opacity-0 hover:bg-destructive group-hover:opacity-100"
                                ><Trash2 className="size-3" /></button>
                              )}
                            </div>
                          );
                        })}
                        {Object.entries(uploads).filter(([, job]) => job.locale === row.locale).map(([id, job]) => (
                          <div key={id} className="flex h-20 w-28 shrink-0 flex-col items-center justify-center rounded-md border border-dashed bg-muted/40 px-2 text-center">
                            <Loader2 className={cn('size-3.5', job.phase !== 'Failed' && 'animate-spin')} />
                            <span className="mt-1 text-[9px] font-medium">{job.phase === 'Uploading' ? `${job.progress}%` : job.phase}</span>
                            <span className="line-clamp-1 text-[8px] text-destructive">{job.error}</span>
                          </div>
                        ))}
                        {canEdit && branch === 'editable' && row.screenshots.length < MAX_SCREENSHOTS_PER_SET ? (
                          <label className="flex h-20 min-w-40 shrink-0 cursor-pointer flex-col items-center justify-center rounded-md border border-dashed text-[11px] text-muted-foreground hover:border-primary/40 hover:bg-accent/30 hover:text-foreground">
                            <ImagePlus className="mb-1 size-4" /> Drop or add images
                            <input type="file" accept="image/png,image/jpeg" multiple className="hidden" onChange={(event) => {
                              if (event.target.files?.length) void uploadFiles(row.locale, event.target.files, row.screenshots.length);
                              event.target.value = '';
                            }} />
                          </label>
                        ) : row.screenshots.length === 0 ? <span className="text-[11px] text-muted-foreground">No screenshots</span> : null}
                      </div>
                      <div><Badge variant={status.variant}>{status.label}</Badge></div>
                      <div className="text-right">
                        <span className="text-[10px] text-muted-foreground">Drag to reorder</span>
                      </div>
                    </div>
                  );
                })}
                {visibleRows.length === 0 && (
                  <p className="px-5 py-10 text-center text-[12px] text-muted-foreground">No languages match this filter.</p>
                )}
              </div>
            </div>
          </div>
        )}
      </section>
      <Dialog open={!!preview} onOpenChange={(open) => { if (!open) setPreview(null); }}>
        <DialogContent wide className="max-h-[92vh] max-w-5xl overflow-auto bg-black/95 p-4 text-white">
          <DialogHeader title={preview?.name ?? 'Screenshot preview'} description={preview?.locale} />
          {preview && <img src={preview.url} alt={preview.name} className="mx-auto max-h-[80vh] max-w-full object-contain" />}
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title="Delete this screenshot?"
        description={deleteTarget ? `${deleteTarget.name} is removed from the draft version on App Store Connect immediately. This cannot be undone.` : undefined}
        confirmLabel="Delete screenshot"
        destructive
        loading={deleting}
        onConfirm={async () => {
          if (!deleteTarget || !activeType) return;
          setDeleting(true);
          try {
            await api.screenshotsDelete({
              storeId,
              appId,
              platform,
              locale: deleteTarget.locale,
              displayType: activeType,
              screenshotId: deleteTarget.id,
            });
            toast.success('Screenshot deleted');
            setDeleteTarget(null);
          } catch (error) {
            toast.error('Delete failed', { description: callableMessage(error) });
          } finally {
            setDeleting(false);
          }
        }}
      />
    </div>
  );
}
