import { useEffect, useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { collection, orderBy, query, where } from 'firebase/firestore';
import { Search } from 'lucide-react';
import { toast } from 'sonner';
import type { AppDoc, OperationDoc, Platform } from '@asm/shared';
import { APP_STORE_CONNECT_API_LOCALES, localeInfo } from '@asm/shared';
import { api, callableMessage } from '@/lib/callables';
import { useSession } from '@/auth/AuthProvider';
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/Select';
import { db } from '@/lib/firebase';
import { useLiveQuery } from '@/lib/hooks';
import { cn } from '@/lib/utils';

export function AddLanguageDialog({
  open,
  onOpenChange,
  storeId,
  appId,
  platform,
  app,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  storeId: string;
  appId: string;
  platform: Platform;
  app: AppDoc;
}) {
  const { uid } = useSession();
  const existing = useMemo(() => new Set(app.locales ?? []), [app.locales]);
  const candidates = APP_STORE_CONNECT_API_LOCALES.filter((l) => !existing.has(l.code));
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [copyFrom, setCopyFrom] = useState<string>(app.primaryLocale);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const runningOps = useLiveQuery<OperationDoc>(
    useMemo(
      () =>
        open && uid
          ? query(
              collection(db, 'operations'),
              where('startedBy', '==', uid),
              where('status', '==', 'running'),
              orderBy('startedAt', 'desc'),
            )
          : null,
      [open, uid],
    ),
    `add-language-progress-${uid}-${open}`,
  );

  const reconcile = useMutation({
    mutationFn: () => api.appsSyncOne({ storeId, appId }),
    onError: (err) => toast.error('Couldn’t refresh Apple languages', { description: callableMessage(err) }),
  });

  useEffect(() => {
    if (open) {
      setPicked(new Set());
      setSearch('');
      setCopyFrom(app.primaryLocale);
      setStartedAt(null);
      reconcile.mutate();
    }
    // Refresh exactly once whenever this dialog opens for an app.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, app.primaryLocale]);

  const mutation = useMutation({
    mutationFn: () =>
      api.locAddLanguage({
        storeId,
        appId,
        platform,
        locales: [...picked],
        ...(copyFrom ? { copyFrom } : {}),
      }),
    onSuccess: (res) => {
      if (res.failed.length > 0) {
        toast.warning(`${res.added.length} added, ${res.skipped.length} already present, ${res.failed.length} failed`, {
          description: res.failed[0]?.error,
        });
      } else {
        toast.success(`${res.added.length} added${res.skipped.length ? `, ${res.skipped.length} already present` : ''}`, {
          description: res.added.length
            ? 'Content was seeded from the copy-from language — translate and push when ready.'
            : 'Everything selected was already present on App Store Connect and has been reconciled.',
        });
      }
      onOpenChange(false);
    },
    onError: (err) => toast.error('Couldn’t add languages', { description: callableMessage(err) }),
  });

  const activeOperation = startedAt === null
    ? null
    : runningOps.rows.find(({ data }) =>
        data.type === 'add-language' &&
        data.storeId === storeId &&
        data.appId === appId &&
        data.startedAt.toMillis() >= startedAt - 5_000,
      )?.data ?? null;
  const progress = activeOperation?.progress;
  const progressPercent = progress && progress.total > 0
    ? Math.round((progress.done / progress.total) * 100)
    : 0;

  const visible = candidates.filter(
    (l) =>
      search.trim() === '' ||
      l.name.toLowerCase().includes(search.trim().toLowerCase()) ||
      l.code.toLowerCase().includes(search.trim().toLowerCase()),
  );

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!mutation.isPending) onOpenChange(next); }}>
      <DialogContent
        wide
        className="max-h-[85vh] overflow-y-auto"
        onEscapeKeyDown={(event) => { if (mutation.isPending) event.preventDefault(); }}
        onPointerDownOutside={(event) => { if (mutation.isPending) event.preventDefault(); }}
      >
        <DialogHeader
          title="Add App Store languages"
          description={reconcile.isPending
            ? 'Checking this app’s current localizations with App Store Connect…'
            : `Only languages Apple’s public API can create are shown. ${candidates.length} of ${APP_STORE_CONNECT_API_LOCALES.length} remain available for this app.`}
        />
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-8"
                placeholder="Search languages…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                disabled={reconcile.isPending}
              />
            </div>
            <div className="flex gap-2 text-[12px]">
              <button
                className="text-primary hover:underline disabled:opacity-50"
                disabled={reconcile.isPending}
                onClick={() => setPicked(new Set(candidates.map((l) => l.code)))}
              >
                Add all
              </button>
              <button className="text-muted-foreground hover:underline" onClick={() => setPicked(new Set())}>
                None
              </button>
            </div>
            <div className="flex items-center gap-2">
              <Label className="mb-0 whitespace-nowrap text-[12px] text-muted-foreground">Copy content from</Label>
              <Select value={copyFrom} onValueChange={setCopyFrom}>
                <SelectTrigger className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(app.locales ?? []).map((code) => (
                    <SelectItem key={code} value={code}>
                      {localeInfo(code).flag} {localeInfo(code).name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid max-h-72 grid-cols-2 gap-1 overflow-y-auto rounded-lg border p-2 md:grid-cols-3">
            {visible.map((l) => {
              const checked = picked.has(l.code);
              return (
                <button
                  key={l.code}
                  type="button"
                  disabled={reconcile.isPending}
                  onClick={() => {
                    const next = new Set(picked);
                    if (checked) next.delete(l.code);
                    else next.add(l.code);
                    setPicked(next);
                  }}
                  className={cn(
                    'flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors',
                    checked ? 'bg-accent text-accent-foreground' : 'hover:bg-muted',
                    reconcile.isPending && 'cursor-wait opacity-50',
                  )}
                >
                  <span>{l.flag}</span>
                  <span className="truncate">{l.name}</span>
                </button>
              );
            })}
            {visible.length === 0 && (
              <p className="col-span-full py-6 text-center text-[13px] text-muted-foreground">
                Every App Store language is already added.
              </p>
            )}
          </div>
          {mutation.isPending && (
            <div className="rounded-lg border bg-muted/35 px-3 py-2.5" aria-live="polite">
              <div className="flex items-center justify-between text-[12px] font-medium">
                <span>{activeOperation?.label ?? 'Starting language manager…'}</span>
                <span className="tabular-nums text-muted-foreground">
                  {progress ? `${progress.done}/${progress.total}` : 'Connecting…'}
                </span>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-primary/15">
                <div
                  className={cn(
                    'h-full rounded-full bg-primary transition-[width] duration-300',
                    !progress && 'w-1/3 animate-pulse',
                  )}
                  style={progress ? { width: `${progressPercent}%` } : undefined}
                />
              </div>
              <div className="mt-2 flex gap-4 text-[11px] tabular-nums text-muted-foreground">
                <span><strong className="font-medium text-emerald-700">{progress?.added ?? 0}</strong> added</span>
                <span><strong className="font-medium text-foreground">{progress?.skipped ?? 0}</strong> already present</span>
                <span><strong className="font-medium text-destructive">{progress?.failed ?? 0}</strong> failed</span>
              </div>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              const count = picked.size;
              setStartedAt(Date.now());
              mutation.mutate();
              onOpenChange(false);
              toast.info(`Adding ${count} ${count === 1 ? 'language' : 'languages'}`, {
                description: 'Live progress is shown at the top of the workspace.',
              });
            }}
            disabled={picked.size === 0 || mutation.isPending || reconcile.isPending}
          >
            {mutation.isPending
              ? progress ? `Adding ${progress.done}/${progress.total}…` : 'Starting…'
              : `Add ${picked.size > 0 ? picked.size : ''} ${picked.size === 1 ? 'language' : 'languages'}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function RemoveLanguageDialog({
  locale,
  onOpenChange,
  storeId,
  appId,
  platform,
}: {
  locale: string | null;
  onOpenChange: (o: boolean) => void;
  storeId: string;
  appId: string;
  platform: Platform;
}) {
  const mutation = useMutation({
    mutationFn: () => api.locRemoveLanguage({ storeId, appId, platform, locale: locale! }),
    onSuccess: (res) => {
      toast.success(`Removed ${locale ? localeInfo(locale).name : ''}`, {
        description: res.removedFromLive
          ? undefined
          : 'It still exists on the live version; only the draft localization was deleted.',
      });
      onOpenChange(false);
    },
    onError: (err) => toast.error('Couldn’t remove language', { description: callableMessage(err) }),
  });

  return (
    <ConfirmDialog
      open={!!locale}
      onOpenChange={onOpenChange}
      title={`Remove ${locale ? localeInfo(locale).name : ''}?`}
      description="Deletes this language from the draft version on App Store Connect, along with any local edits. This can’t be undone."
      confirmLabel="Remove language"
      destructive
      typeToConfirm={locale ?? undefined}
      loading={mutation.isPending}
      onConfirm={() => mutation.mutate()}
    />
  );
}

export function CreateVersionDialog({
  open,
  onOpenChange,
  storeId,
  appId,
  platform,
  app,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  storeId: string;
  appId: string;
  platform: Platform;
  app: AppDoc;
}) {
  const live = app.versions?.[platform]?.live?.versionString;
  const editable = app.versions?.[platform]?.editable;
  const changing = !!editable;
  const suggested = useMemo(() => {
    if (editable?.versionString) return editable.versionString;
    if (!live) return '1.0';
    const parts = live.split('.').map((n) => parseInt(n, 10));
    if (parts.length === 1) return `${parts[0]! + 1}.0`;
    parts[parts.length - 1] = (parts[parts.length - 1] ?? 0) + 1;
    return parts.join('.');
  }, [editable?.versionString, live]);
  const [version, setVersion] = useState(suggested);
  useEffect(() => {
    if (open) setVersion(suggested);
  }, [open, suggested]);

  const mutation = useMutation({
    mutationFn: () => changing
      ? api.versionsUpdate({ storeId, appId, platform, versionString: version.trim() })
      : api.versionsCreate({ storeId, appId, platform, versionString: version.trim() }),
    onSuccess: (res) => {
      toast.success(changing ? `Version changed to ${res.versionString}` : `Version ${res.versionString} created`, {
        description: changing
          ? 'The new version number is saved on App Store Connect.'
          : 'Apple copied the live metadata over — everything is editable now.',
      });
      onOpenChange(false);
    },
    onError: (err) => toast.error('Couldn’t create version', { description: callableMessage(err) }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader
          title={changing ? 'Change version number' : 'Create a new version'}
          description={changing
            ? `Updates the editable App Store Connect version${live ? ` (currently live: v${live})` : ''}. This does not submit the app.`
            : `Starts a new draft version on App Store Connect${live ? ` (currently live: v${live})` : ''}. Metadata becomes editable; nothing goes public until you submit it for review in ASC.`}
        />
        <div>
          <Label htmlFor="version-string">Version number</Label>
          <Input
            id="version-string"
            value={version}
            onChange={(e) => setVersion(e.target.value)}
            placeholder="2.4"
            autoFocus
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              const requestedVersion = version.trim();
              mutation.mutate();
              onOpenChange(false);
              toast.info(changing ? `Changing version to ${requestedVersion}` : `Creating version ${requestedVersion}`, {
                description: 'Live progress is shown at the top of the workspace.',
              });
            }}
            loading={mutation.isPending}
            disabled={!/^\d+(\.\d+){0,3}$/.test(version.trim()) || (changing && version.trim() === editable?.versionString)}
          >
            {changing ? 'Save version' : 'Create version'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
