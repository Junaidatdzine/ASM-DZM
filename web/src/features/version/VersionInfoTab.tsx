import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Box, Check, Loader2, Lock } from 'lucide-react';
import { toast } from 'sonner';
import type { AppDoc, BuildRef, Platform, ReleaseType } from '@asm/shared';
import {
  COPYRIGHT_MAX,
  RELEASE_TYPES,
  RELEASE_TYPE_LABELS,
  describeBuildState,
  describeReleaseType,
  describeVersionState,
  isBuildAttachable,
  isEditableState,
  releaseConfigError,
} from '@asm/shared';
import { api, callableMessage } from '@/lib/callables';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import { FieldHint, Label } from '@/components/ui/Label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/Select';
import { cn } from '@/lib/utils';

/** UTC ISO → a value the datetime-local input understands (local wall-clock, minute precision). */
function isoToLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatWhen(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** Local datetime-local value → absolute UTC ISO. Returns null for empty/invalid input. */
function localInputToIso(local: string): string | null {
  if (!local) return null;
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function BuildLine({ build }: { build: BuildRef }) {
  const ready = isBuildAttachable(build);
  return (
    <span className="inline-flex items-center gap-2">
      <span className="font-medium tabular-nums">Build {build.version}</span>
      <Badge variant={ready ? 'success' : build.processingState === 'PROCESSING' ? 'warning' : 'outline'}>
        {describeBuildState(build.processingState)}
      </Badge>
    </span>
  );
}

function ReleaseSummary({ version }: { version: { releaseType?: ReleaseType; earliestReleaseDate?: string | null } }) {
  const scheduled = version.releaseType === 'SCHEDULED' && version.earliestReleaseDate;
  return (
    <span>
      {describeReleaseType(version.releaseType)}
      {scheduled ? ` · ${formatWhen(version.earliestReleaseDate)}` : ''}
    </span>
  );
}

export function VersionInfoTab({
  storeId,
  appId,
  platform,
  app,
  canManage,
  onCreateVersion,
}: {
  storeId: string;
  appId: string;
  platform: Platform;
  app: AppDoc;
  canManage: boolean;
  /** Opens the shared create/change-version dialog (managers only). */
  onCreateVersion?: () => void;
}) {
  const branch = app.versions?.[platform];
  const editable = branch?.editable ?? null;
  const live = branch?.live ?? null;
  const unlocked = !!editable && isEditableState(editable.state);
  const readOnly = !canManage || !unlocked;

  const baseline = useMemo(
    () => ({
      copyright: editable?.copyright ?? '',
      releaseType: (editable?.releaseType ?? 'AFTER_APPROVAL') as ReleaseType,
      date: isoToLocalInput(editable?.earliestReleaseDate),
    }),
    [editable?.copyright, editable?.releaseType, editable?.earliestReleaseDate],
  );
  const baselineKey = `${baseline.copyright}|${baseline.releaseType}|${baseline.date}`;

  const [form, setForm] = useState(baseline);
  // Reset to the server value whenever it changes (after a save or a background sync).
  useEffect(() => setForm(baseline), [baselineKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const [buildOpen, setBuildOpen] = useState(false);

  const iso = form.releaseType === 'SCHEDULED' ? localInputToIso(form.date) : null;
  const cfgError = releaseConfigError(form.releaseType, iso);
  const dirty =
    form.copyright !== baseline.copyright ||
    form.releaseType !== baseline.releaseType ||
    (form.releaseType === 'SCHEDULED' && form.date !== baseline.date);

  const save = useMutation({
    mutationFn: () =>
      api.versionInfoUpdate({
        storeId,
        appId,
        platform,
        copyright: form.copyright.trim(),
        releaseType: form.releaseType,
        earliestReleaseDate: form.releaseType === 'SCHEDULED' ? iso : null,
      }),
    onSuccess: () => toast.success('Version information saved', { description: 'Changes are live on App Store Connect.' }),
    onError: (err) => toast.error('Couldn’t save version information', { description: callableMessage(err) }),
  });

  if (!editable && !live) {
    return (
      <div className="rounded-xl border border-dashed p-8 text-center text-[13px] text-muted-foreground">
        <p>No {platform.replace('_', ' ').toLowerCase()} version exists yet. Create a version to configure its release.</p>
        {canManage && onCreateVersion && (
          <Button size="sm" className="mt-4" onClick={onCreateVersion}>
            Create version
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="max-w-2xl space-y-5">
      {!unlocked && (
        <div className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-dashed p-4 text-[13px] text-muted-foreground">
          <span className="flex min-w-0 items-start gap-2">
            <Lock className="mt-0.5 size-3.5 shrink-0" />
            <span>
              {live
                ? `v${live.versionString} is live — its release settings are locked. Create a new version to change copyright, release timing, or the build.`
                : 'This version is no longer editable. Sync the app to refresh its status.'}
            </span>
          </span>
          {canManage && onCreateVersion && live && (
            <Button size="sm" onClick={onCreateVersion}>
              Create new version
            </Button>
          )}
        </div>
      )}

      {/* Editable version's release configuration (or a read-only view of the current version). */}
      <section className="rounded-xl border bg-card">
        <header className="flex items-center justify-between border-b px-4 py-3">
          <div className="flex items-center gap-2">
            <h3 className="text-[13px] font-semibold">Version Information</h3>
            {editable && (
              <Badge variant="accent">
                v{editable.versionString} · {describeVersionState(editable.state)}
              </Badge>
            )}
          </div>
        </header>

        <div className="space-y-5 p-4">
          <div>
            <Label htmlFor="copyright">Copyright</Label>
            <Input
              id="copyright"
              value={form.copyright}
              disabled={readOnly}
              maxLength={COPYRIGHT_MAX}
              placeholder="2026 Your Company, LLC"
              onChange={(e) => setForm((f) => ({ ...f, copyright: e.target.value }))}
            />
            <div className="mt-1 flex items-center justify-between">
              <FieldHint>The name of the person or entity that owns the rights to the app.</FieldHint>
              <span className="text-xs tabular-nums text-muted-foreground">
                {form.copyright.length}/{COPYRIGHT_MAX}
              </span>
            </div>
          </div>

          <div>
            <Label htmlFor="release-type">Release</Label>
            <Select
              value={form.releaseType}
              onValueChange={(v) => setForm((f) => ({ ...f, releaseType: v as ReleaseType }))}
              disabled={readOnly}
            >
              <SelectTrigger id="release-type" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RELEASE_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {RELEASE_TYPE_LABELS[t].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldHint>{RELEASE_TYPE_LABELS[form.releaseType].hint}</FieldHint>
          </div>

          {form.releaseType === 'SCHEDULED' && (
            <div>
              <Label htmlFor="release-date">Release date</Label>
              <Input
                id="release-date"
                type="datetime-local"
                value={form.date}
                disabled={readOnly}
                onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
                className="w-64"
              />
              <FieldHint>
                {cfgError && dirty
                  ? cfgError
                  : 'App Store Connect releases on the hour, in your account’s time zone, after approval.'}
              </FieldHint>
            </div>
          )}

          <div>
            <Label>Build</Label>
            <div className="flex items-center justify-between gap-3 rounded-lg border bg-muted/30 px-3 py-2.5">
              <div className="flex items-center gap-2 text-[13px]">
                <Box className="size-4 text-muted-foreground" />
                {editable?.build ? (
                  <BuildLine build={editable.build} />
                ) : (
                  <span className="text-muted-foreground">No build selected</span>
                )}
              </div>
              {!readOnly && (
                <Button variant="outline" size="sm" onClick={() => setBuildOpen(true)}>
                  {editable?.build ? 'Change build' : 'Select build'}
                </Button>
              )}
            </div>
            <FieldHint>A build must be attached before this version can be submitted for review.</FieldHint>
          </div>

          {!readOnly && (
            <div className="flex items-center justify-end gap-2 border-t pt-4">
              {dirty && (
                <Button variant="ghost" size="sm" onClick={() => setForm(baseline)} disabled={save.isPending}>
                  Discard
                </Button>
              )}
              <Button
                size="sm"
                onClick={() => save.mutate()}
                loading={save.isPending}
                disabled={!dirty || !!cfgError}
              >
                Save changes
              </Button>
            </div>
          )}
        </div>
      </section>

      {/* Live version reference, when there is a separate live version. */}
      {live && editable && live.id !== editable.id && (
        <section className="rounded-xl border">
          <header className="border-b px-4 py-2.5 text-[12px] font-medium text-muted-foreground">
            Currently live · v{live.versionString}
          </header>
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 px-4 py-3 text-[13px]">
            <dt className="text-muted-foreground">Copyright</dt>
            <dd>{live.copyright || '—'}</dd>
            <dt className="text-muted-foreground">Release</dt>
            <dd><ReleaseSummary version={live} /></dd>
            <dt className="text-muted-foreground">Build</dt>
            <dd>{live.build ? <BuildLine build={live.build} /> : '—'}</dd>
          </dl>
        </section>
      )}

      {editable && (
        <BuildPickerDialog
          open={buildOpen}
          onOpenChange={setBuildOpen}
          storeId={storeId}
          appId={appId}
          platform={platform}
          versionString={editable.versionString}
          currentBuildId={editable.build?.id ?? null}
        />
      )}
    </div>
  );
}

function BuildPickerDialog({
  open,
  onOpenChange,
  storeId,
  appId,
  platform,
  versionString,
  currentBuildId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  storeId: string;
  appId: string;
  platform: Platform;
  versionString: string;
  currentBuildId: string | null;
}) {
  const buildsQ = useQuery({
    queryKey: ['builds', storeId, appId, platform, versionString],
    queryFn: () => api.buildsList({ storeId, appId, platform }),
    enabled: open,
    staleTime: 15_000,
  });

  const [picked, setPicked] = useState<string | null>(currentBuildId);
  useEffect(() => {
    if (open) setPicked(buildsQ.data?.selectedBuildId ?? currentBuildId);
    // Re-seed the selection when the dialog opens or fresh server state arrives.
  }, [open, buildsQ.data?.selectedBuildId, currentBuildId]);

  const select = useMutation({
    mutationFn: () => api.versionInfoUpdate({ storeId, appId, platform, buildId: picked }),
    onSuccess: () => {
      toast.success(picked ? 'Build attached' : 'Build removed', {
        description: 'App Store Connect has been updated.',
      });
      onOpenChange(false);
    },
    onError: (err) => toast.error('Couldn’t change the build', { description: callableMessage(err) }),
  });

  const builds = buildsQ.data?.builds ?? [];

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!select.isPending) onOpenChange(o); }}>
      <DialogContent>
        <DialogHeader
          title="Select a build"
          description={`Builds uploaded for v${versionString}. Only fully processed builds can be attached.`}
        />
        <div className="max-h-80 space-y-1.5 overflow-y-auto">
          {buildsQ.isLoading ? (
            <div className="flex items-center justify-center gap-2 py-8 text-[13px] text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading builds from App Store Connect…
            </div>
          ) : buildsQ.isError ? (
            <p className="py-8 text-center text-[13px] text-destructive">{callableMessage(buildsQ.error)}</p>
          ) : builds.length === 0 ? (
            <p className="py-8 text-center text-[13px] text-muted-foreground">
              No builds have been uploaded for v{versionString} yet. Upload one from Xcode or Transporter.
            </p>
          ) : (
            <>
              <BuildOption
                label="No build"
                sub="Detach the current build from this version"
                selected={picked === null}
                onSelect={() => setPicked(null)}
              />
              {builds.map((b) => {
                const attachable = isBuildAttachable(b);
                return (
                  <BuildOption
                    key={b.id}
                    label={`Build ${b.version}`}
                    sub={`${describeBuildState(b.processingState)}${b.uploadedDate ? ` · uploaded ${formatWhen(b.uploadedDate)}` : ''}`}
                    badge={
                      <Badge variant={attachable ? 'success' : b.processingState === 'PROCESSING' ? 'warning' : 'outline'}>
                        {describeBuildState(b.processingState)}
                      </Badge>
                    }
                    selected={picked === b.id}
                    disabled={!attachable}
                    onSelect={() => setPicked(b.id)}
                  />
                );
              })}
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={select.isPending}>
            Cancel
          </Button>
          <Button
            onClick={() => select.mutate()}
            loading={select.isPending}
            disabled={picked === (buildsQ.data?.selectedBuildId ?? currentBuildId)}
          >
            Save build
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BuildOption({
  label,
  sub,
  badge,
  selected,
  disabled,
  onSelect,
}: {
  label: string;
  sub: string;
  badge?: ReactNode;
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        'flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors',
        selected ? 'border-primary bg-accent' : 'hover:bg-muted',
        disabled && 'cursor-not-allowed opacity-55',
      )}
    >
      <span
        className={cn(
          'flex size-4 shrink-0 items-center justify-center rounded-full border',
          selected ? 'border-primary bg-primary text-primary-foreground' : 'border-input',
        )}
      >
        {selected && <Check className="size-3" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-medium">{label}</span>
        <span className="block truncate text-[11px] text-muted-foreground">{sub}</span>
      </span>
      {badge}
    </button>
  );
}
