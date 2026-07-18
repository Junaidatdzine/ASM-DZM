import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, arrayMove, horizontalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { collection, query, where } from 'firebase/firestore';
import { getDownloadURL, ref as storageRef, uploadBytesResumable } from 'firebase/storage';
import { ImagePlus, Loader2, Plus, Trash2, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import type { AppDoc, Platform, ScreenshotEntry, ScreenshotSetDoc } from '@asm/shared';
import {
  MAX_SCREENSHOTS_PER_SET,
  MAX_SCREENSHOT_BYTES,
  SCREENSHOT_SPECS,
  hasEditableVersion,
  screenshotSpecLabel,
  validateScreenshotDimensions,
} from '@asm/shared';
import { db, storage } from '@/lib/firebase';
import { api, callableMessage } from '@/lib/callables';
import { useLiveQuery } from '@/lib/hooks';
import { useSession } from '@/auth/AuthProvider';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu';
import { Skeleton, Spinner } from '@/components/ui/Skeleton';
import { Tooltip } from '@/components/ui/Tooltip';
import { cn } from '@/lib/utils';

export function screenshotThumbUrl(entry: ScreenshotEntry, height = 320): string | null {
  if (!entry.templateUrl) return null;
  const w = entry.width && entry.height ? Math.round((entry.width / entry.height) * height) : 148;
  return entry.templateUrl
    .replace('{w}', String(w))
    .replace('{h}', String(height))
    .replace('{f}', 'png');
}

interface UploadJob {
  id: string;
  fileName: string;
  displayType: string;
  phase: 'staging' | 'sending' | 'processing' | 'failed';
  progress: number;
  error?: string;
}

function SortableShot({
  entry,
  disabled,
  onDelete,
}: {
  entry: ScreenshotEntry;
  disabled: boolean;
  onDelete: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: entry.id,
    disabled,
  });
  const url = screenshotThumbUrl(entry);
  return (
    <div
      ref={setNodeRef}
      style={{
        transform: transform ? `translate(${transform.x}px, ${transform.y}px)` : undefined,
        transition,
      }}
      className={cn('group relative shrink-0', isDragging && 'z-10 opacity-80')}
    >
      <div
        {...attributes}
        {...listeners}
        className={cn(
          'relative h-64 overflow-hidden rounded-xl border bg-muted shadow-card',
          !disabled && 'cursor-grab active:cursor-grabbing',
        )}
        style={{ aspectRatio: entry.width && entry.height ? `${entry.width}/${entry.height}` : '9/19.5' }}
      >
        {url && entry.state === 'complete' ? (
          <img src={url} alt={entry.fileName} className="size-full object-cover" draggable={false} />
        ) : (
          <div className="flex size-full flex-col items-center justify-center gap-2 p-3 text-center">
            {entry.state === 'failed' ? (
              <>
                <TriangleAlert className="size-5 text-destructive" />
                <span className="text-[11px] text-destructive">Apple rejected this asset</span>
              </>
            ) : (
              <>
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
                <span className="text-[11px] text-muted-foreground">Processing…</span>
              </>
            )}
          </div>
        )}
        <span className="absolute left-1.5 top-1.5 rounded-md bg-black/55 px-1.5 py-0.5 text-[10px] font-semibold text-white">
          {entry.position + 1}
        </span>
      </div>
      {!disabled && (
        <button
          onClick={onDelete}
          className="absolute -right-1.5 -top-1.5 rounded-full border bg-card p-1 text-muted-foreground opacity-0 shadow-card transition-opacity hover:text-destructive group-hover:opacity-100"
        >
          <Trash2 className="size-3.5" />
        </button>
      )}
    </div>
  );
}

export function ScreenshotsTab({
  storeId,
  appId,
  platform,
  locale,
  app,
  canEdit,
  initialDisplayType,
}: {
  storeId: string;
  appId: string;
  platform: Platform;
  locale: string;
  app: AppDoc;
  canEdit: boolean;
  initialDisplayType?: string | null;
}) {
  const { uid } = useSession();
  const editable = hasEditableVersion(app, platform);
  const branch = editable ? 'editable' : 'live';

  const setsQ = useLiveQuery<ScreenshotSetDoc>(
    useMemo(
      () =>
        query(
          collection(db, 'stores', storeId, 'apps', appId, 'screenshotSets'),
          where('locale', '==', locale),
          where('platform', '==', platform),
          where('branch', '==', branch),
        ),
      [storeId, appId, locale, platform, branch],
    ),
    `shots-${storeId}-${appId}-${locale}-${branch}`,
  );

  const [selectedType, setSelectedType] = useState<string | null>(initialDisplayType ?? null);
  const [uploads, setUploads] = useState<UploadJob[]>([]);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; displayType: string } | null>(null);
  const [order, setOrder] = useState<string[] | null>(null); // optimistic order
  const syncedOnce = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);

  // Lazy sync on first open of the tab for this locale.
  useEffect(() => {
    syncedOnce.current = false;
  }, [locale, branch]);
  useEffect(() => {
    if (initialDisplayType) setSelectedType(initialDisplayType);
  }, [initialDisplayType]);
  useEffect(() => {
    if (syncedOnce.current) return;
    syncedOnce.current = true;
    api.screenshotsSyncLocale({ storeId, appId, platform, locale }).catch(() => {});
  }, [storeId, appId, platform, locale, branch]);

  const sets = useMemo(
    () => [...setsQ.rows].sort((a, b) => {
      const oa = SCREENSHOT_SPECS.find((s) => s.displayType === a.data.displayType)?.order ?? 99;
      const ob = SCREENSHOT_SPECS.find((s) => s.displayType === b.data.displayType)?.order ?? 99;
      return oa - ob;
    }),
    [setsQ.rows],
  );

  const activeType = selectedType ?? sets[0]?.data.displayType ?? null;
  const activeSet = sets.find((s) => s.data.displayType === activeType) ?? null;
  const shots = useMemo(() => {
    const list = [...(activeSet?.data.screenshots ?? [])].sort((a, b) => a.position - b.position);
    if (!order) return list;
    const byId = new Map(list.map((s) => [s.id, s]));
    const ordered = order.map((id) => byId.get(id)).filter(Boolean) as ScreenshotEntry[];
    for (const s of list) if (!order.includes(s.id)) ordered.push(s);
    return ordered;
  }, [activeSet, order]);

  useEffect(() => setOrder(null), [activeType, locale]);

  const missingTypes = SCREENSHOT_SPECS.filter(
    (spec) => !sets.some((s) => s.data.displayType === spec.displayType),
  );

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const onDragEnd = useCallback(
    async (event: DragEndEvent) => {
      if (!activeSet || !activeType) return;
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const ids = shots.map((s) => s.id);
      const from = ids.indexOf(String(active.id));
      const to = ids.indexOf(String(over.id));
      if (from < 0 || to < 0) return;
      const next = arrayMove(ids, from, to);
      setOrder(next);
      try {
        await api.screenshotsReorder({ storeId, appId, platform, locale, displayType: activeType, orderedIds: next });
      } catch (err) {
        setOrder(null);
        toast.error('Reorder failed', { description: callableMessage(err) });
      }
    },
    [activeSet, activeType, shots, storeId, appId, platform, locale],
  );

  const startUpload = useCallback(
    async (files: FileList | File[]) => {
      if (!activeType || !uid) return;
      const list = [...files].slice(0, MAX_SCREENSHOTS_PER_SET - shots.length);
      if (list.length === 0) {
        toast.warning('This device size already has 10 screenshots.');
        return;
      }
      for (const file of list) {
        const jobId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const job: UploadJob = { id: jobId, fileName: file.name, displayType: activeType, phase: 'staging', progress: 0 };
        setUploads((u) => [...u, job]);
        const update = (patch: Partial<UploadJob>) =>
          setUploads((u) => u.map((j) => (j.id === jobId ? { ...j, ...patch } : j)));
        const finish = () => setTimeout(() => setUploads((u) => u.filter((j) => j.id !== jobId)), 4000);

        try {
          if (file.size > MAX_SCREENSHOT_BYTES) throw new Error('Image exceeds 12 MB.');
          if (!/image\/(png|jpeg)/.test(file.type)) throw new Error('Only PNG and JPEG are supported.');
          const bitmap = await createImageBitmap(file).catch(() => null);
          if (!bitmap) throw new Error('Could not read this image.');
          const dimError = validateScreenshotDimensions(activeType, bitmap.width, bitmap.height);
          bitmap.close();
          if (dimError) throw new Error(dimError);

          // 1. Stage in Firebase Storage (resumable → real progress for the big hop).
          const path = `staging/${uid}/${jobId}-${file.name.replace(/[^\w.-]+/g, '_')}`;
          const task = uploadBytesResumable(storageRef(storage, path), file, { contentType: file.type });
          await new Promise<void>((resolve, reject) => {
            task.on(
              'state_changed',
              (snap) => update({ progress: Math.round((snap.bytesTransferred / snap.totalBytes) * 100) }),
              reject,
              () => resolve(),
            );
          });

          // 2. Function streams it through Apple's upload operations.
          update({ phase: 'sending', progress: 100 });
          const res = await api.screenshotsUpload({
            storeId,
            appId,
            platform,
            locale,
            displayType: activeType,
            storagePath: path,
            fileName: file.name,
          });

          // 3. Poll processing state while the tab is open.
          update({ phase: 'processing' });
          for (let i = 0; i < 12; i++) {
            await new Promise((r) => setTimeout(r, 2500));
            const poll = await api
              .screenshotsPollState({ storeId, appId, platform, locale, displayType: activeType, screenshotId: res.screenshotId })
              .catch(() => null);
            if (!poll) break;
            if (poll.state === 'COMPLETE') break;
            if (poll.state === 'FAILED') throw new Error('Apple rejected the asset during processing.');
          }
          finish();
        } catch (err) {
          update({ phase: 'failed', error: err instanceof Error ? err.message : callableMessage(err) });
          setTimeout(() => setUploads((u) => u.filter((j) => j.id !== jobId)), 8000);
        }
      }
    },
    [activeType, uid, shots.length, storeId, appId, platform, locale],
  );

  const deleteShot = useCallback(async () => {
    if (!deleteTarget) return;
    try {
      await api.screenshotsDelete({
        storeId,
        appId,
        platform,
        locale,
        displayType: deleteTarget.displayType,
        screenshotId: deleteTarget.id,
      });
      toast.success('Screenshot deleted');
    } catch (err) {
      toast.error('Delete failed', { description: callableMessage(err) });
    } finally {
      setDeleteTarget(null);
    }
  }, [deleteTarget, storeId, appId, platform, locale]);

  const editingAllowed = canEdit && editable;

  return (
    <div>
      {!editable && (
        <div className="mb-4 rounded-xl border border-dashed px-4 py-3 text-[13px] text-muted-foreground">
          Viewing the <span className="font-medium text-foreground">live version’s</span> screenshots —
          read-only. Create a new version to change screenshots.
        </div>
      )}

      {/* Device size tabs */}
      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        {sets.map((s) => (
          <button
            key={s.id}
            onClick={() => setSelectedType(s.data.displayType)}
            className={cn(
              'rounded-lg px-3 py-1.5 text-[13px] font-medium transition-colors',
              activeType === s.data.displayType
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            {screenshotSpecLabel(s.data.displayType)}
            <span className="ml-1.5 text-[11px] text-muted-foreground">{s.data.screenshots.length}</span>
          </button>
        ))}
        {editingAllowed && missingTypes.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger className="flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
              <Plus className="size-3.5" /> Device size
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              {missingTypes.map((spec) => (
                <DropdownMenuItem key={spec.displayType} onSelect={() => setSelectedType(spec.displayType)}>
                  {spec.label}
                  {spec.required && <span className="ml-auto text-[10px] text-warning">required</span>}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {setsQ.loading && sets.length === 0 ? (
        <div className="flex gap-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-64 w-32" />
          ))}
        </div>
      ) : !activeType ? (
        <div className="rounded-xl border border-dashed p-10 text-center text-[13px] text-muted-foreground">
          {editingAllowed
            ? 'No screenshots yet for this language — pick a device size above to start uploading.'
            : 'No screenshots for this language.'}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-start gap-3">
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
              <SortableContext items={shots.map((s) => s.id)} strategy={horizontalListSortingStrategy}>
                {shots.map((entry) => (
                  <SortableShot
                    key={entry.id}
                    entry={entry}
                    disabled={!editingAllowed}
                    onDelete={() => setDeleteTarget({ id: entry.id, displayType: activeType })}
                  />
                ))}
              </SortableContext>
            </DndContext>

            {uploads
              .filter((j) => j.displayType === activeType)
              .map((j) => (
                <div
                  key={j.id}
                  className="flex h-64 w-32 shrink-0 flex-col items-center justify-center gap-2 rounded-xl border border-dashed bg-muted/40 p-3 text-center"
                >
                  {j.phase === 'failed' ? (
                    <>
                      <TriangleAlert className="size-5 text-destructive" />
                      <span className="line-clamp-4 text-[10px] text-destructive">{j.error}</span>
                    </>
                  ) : (
                    <>
                      <Spinner />
                      <span className="text-[11px] font-medium">
                        {j.phase === 'staging' ? `${j.progress}%` : j.phase === 'sending' ? 'Sending to Apple…' : 'Processing…'}
                      </span>
                      <span className="line-clamp-2 max-w-full break-all text-[10px] text-muted-foreground">{j.fileName}</span>
                    </>
                  )}
                </div>
              ))}

            {editingAllowed && shots.length + uploads.filter((j) => j.displayType === activeType && j.phase !== 'failed').length < MAX_SCREENSHOTS_PER_SET && (
              <button
                onClick={() => fileInput.current?.click()}
                className="flex h-64 w-32 shrink-0 flex-col items-center justify-center gap-2 rounded-xl border border-dashed text-muted-foreground transition-colors hover:border-primary/50 hover:bg-accent/40 hover:text-foreground"
              >
                <ImagePlus className="size-6" />
                <span className="px-2 text-center text-[11px]">Add screenshots</span>
              </button>
            )}
          </div>

          {editingAllowed && (
            <p className="mt-3 text-[11px] text-muted-foreground">
              {screenshotSpecLabel(activeType)} accepts:{' '}
              {SCREENSHOT_SPECS.find((s) => s.displayType === activeType)
                ?.sizes.slice(0, 4)
                .map(([w, h]) => `${w}×${h}`)
                .join(', ')}
              {' '}· PNG or JPEG · drag to reorder · max {MAX_SCREENSHOTS_PER_SET}
            </p>
          )}

          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files?.length) void startUpload(e.target.files);
              e.target.value = '';
            }}
          />
        </>
      )}

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={() => setDeleteTarget(null)}
        title="Delete this screenshot?"
        description="It is removed from the draft version on App Store Connect immediately. There is no undo — Apple doesn't keep a copy."
        confirmLabel="Delete screenshot"
        destructive
        onConfirm={deleteShot}
      />

      <Button
        variant="ghost"
        size="sm"
        className="mt-4 text-muted-foreground"
        onClick={() => {
          syncedOnce.current = false;
          void api.screenshotsSyncLocale({ storeId, appId, platform, locale }).then(
            () => toast.success('Screenshots refreshed'),
            (err) => toast.error('Refresh failed', { description: callableMessage(err) }),
          );
        }}
      >
        Refresh from App Store Connect
      </Button>
    </div>
  );
}
