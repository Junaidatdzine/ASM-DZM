import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ref as storageRef, uploadBytesResumable } from 'firebase/storage';
import { Eye, EyeOff, FileText, Loader2, Lock, Paperclip, Rocket, Trash2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import type { AgeRatingValues, AppDoc, KidsAgeBand, Platform } from '@asm/shared';
import {
  AGE_RATING_BOOL_FIELDS,
  AGE_RATING_LEVEL_FIELDS,
  AGE_RATING_LEVELS,
  AGE_RATING_LEVEL_LABELS,
  KIDS_AGE_BAND_LABELS,
  MAX_REVIEW_ATTACHMENT_BYTES,
  PHASED_RELEASE_STATE_LABELS,
  REVIEW_DETAIL_LIMITS,
  can,
  describeSubmissionState,
  phasedReleasePercent,
  type PhasedReleaseState,
} from '@asm/shared';
import { api, callableMessage, type AppExtrasResult, type ReviewDetailData } from '@/lib/callables';
import { storage } from '@/lib/firebase';
import { useSession } from '@/auth/AuthProvider';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import { FieldHint, Label } from '@/components/ui/Label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { Switch } from '@/components/ui/Switch';
import { Textarea } from '@/components/ui/Textarea';

function SectionCard({
  title,
  badge,
  children,
}: {
  title: string;
  badge?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border bg-card">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
        <h3 className="text-[13px] font-semibold">{title}</h3>
        {badge}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

function SectionError({ error }: { error: string }) {
  return <p className="text-[13px] text-muted-foreground">Couldn’t load: {error}</p>;
}

export function ReleaseTab({
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
  /** Opens the shared create-version dialog (managers only). */
  onCreateVersion?: () => void;
}) {
  const queryClient = useQueryClient();
  const extrasKey = ['appExtras', storeId, appId, platform];
  const extras = useQuery({
    queryKey: extrasKey,
    queryFn: () => api.appExtrasGet({ storeId, appId, platform }),
    staleTime: 60_000,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: extrasKey });

  const editable = app.versions?.[platform]?.editable ?? null;

  if (extras.isLoading) {
    return (
      <div className="max-w-2xl space-y-4">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-40" />
        ))}
      </div>
    );
  }
  if (extras.isError) {
    return (
      <div className="rounded-xl border border-dashed p-6 text-center text-[13px] text-muted-foreground">
        {callableMessage(extras.error)}
        <div className="mt-3">
          <Button variant="outline" size="sm" onClick={() => refresh()}>Retry</Button>
        </div>
      </div>
    );
  }
  const data = extras.data!;

  return (
    <div className="max-w-2xl space-y-4">
      {!editable && (
        <div className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-dashed p-4 text-[13px] text-muted-foreground">
          <span className="flex min-w-0 items-start gap-2">
            <Lock className="mt-0.5 size-3.5 shrink-0" />
            <span>No editable version — review details and submission are locked. Phased-release rollout controls for the live version stay available below.</span>
          </span>
          {canManage && onCreateVersion && (
            <Button size="sm" onClick={onCreateVersion}>
              Create new version
            </Button>
          )}
        </div>
      )}
      <SubmissionCard
        storeId={storeId}
        appId={appId}
        platform={platform}
        app={app}
        data={data}
        onDone={refresh}
      />
      <ReviewDetailCard
        storeId={storeId}
        appId={appId}
        platform={platform}
        detailSection={data.reviewDetail}
        canEdit={canManage && !!editable}
        onDone={refresh}
      />
      <PhasedReleaseCard
        storeId={storeId}
        appId={appId}
        platform={platform}
        data={data}
        canManage={canManage}
        onDone={refresh}
      />
      <AgeRatingCard
        storeId={storeId}
        appId={appId}
        platform={platform}
        section={data.ageRating}
        canEdit={canManage && !!app.appInfo?.editableId}
        onDone={refresh}
      />
    </div>
  );
}

// ---- Submit for review ----

function SubmissionCard({
  storeId,
  appId,
  platform,
  app,
  data,
  onDone,
}: {
  storeId: string;
  appId: string;
  platform: Platform;
  app: AppDoc;
  data: AppExtrasResult;
  onDone: () => void;
}) {
  const { user } = useSession();
  const editable = app.versions?.[platform]?.editable ?? null;
  const submission = data.submission.ok ? data.submission.data : null;
  const [confirmOpen, setConfirmOpen] = useState(false);
  const canSubmit = !!user && can(user, 'manageSubmissions', storeId, appId);

  const submit = useMutation({
    mutationFn: () => api.reviewSubmit({ storeId, appId, platform }),
    onSuccess: () => {
      toast.success('Submitted for review', { description: 'Apple has received the submission.' });
      onDone();
    },
    onError: (err) => toast.error('Couldn’t submit', { description: callableMessage(err) }),
  });
  const cancel = useMutation({
    mutationFn: () => api.reviewSubmissionCancel({ storeId, appId, platform }),
    onSuccess: () => {
      toast.success('Submission canceled');
      onDone();
    },
    onError: (err) => toast.error('Couldn’t cancel', { description: callableMessage(err) }),
  });

  const buildAttached = !!editable?.build;
  const ready = !!editable && buildAttached;
  const rejected = submission?.state === 'UNRESOLVED_ISSUES';
  const openStates = new Set(['READY_FOR_REVIEW', 'WAITING_FOR_REVIEW', 'IN_REVIEW', 'UNRESOLVED_ISSUES']);
  const isOpen = !!submission && openStates.has(submission.state);
  // The submission detail page in App Store Connect — where Apple's rejection
  // message thread lives (their API doesn't expose Resolution Center messages).
  const ascUrl = submission
    ? `https://appstoreconnect.apple.com/apps/${appId}/distribution/reviewsubmissions/details/${submission.id}`
    : `https://appstoreconnect.apple.com/apps/${appId}/distribution`;

  const itemBadge = (state: string) =>
    state === 'REJECTED' ? 'destructive' : state === 'ACCEPTED' || state === 'APPROVED' ? 'success' : 'accent';

  return (
    <SectionCard
      title="App Review submission"
      badge={
        submission ? (
          <Badge variant={rejected ? 'destructive' : submission.state === 'COMPLETE' ? 'success' : 'accent'}>
            {describeSubmissionState(submission.state)}
          </Badge>
        ) : editable ? (
          <Badge variant="outline">Not submitted</Badge>
        ) : undefined
      }
    >
      {submission && isOpen ? (
        <div className="space-y-3">
          {rejected ? (
            <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-[13px] text-destructive">
              Apple rejected this submission. Read their message, fix what they flagged (metadata or a
              new build), then resubmit below.
            </div>
          ) : (
            <p className="text-[13px] text-muted-foreground">
              {submission.submittedDate
                ? `Submitted ${new Date(submission.submittedDate).toLocaleString()}.`
                : 'A submission is in progress.'}{' '}
              Apple reviews most apps within 24–48 hours.
            </p>
          )}
          {submission.items.length > 0 && (
            <ul className="space-y-1.5">
              {submission.items.map((item) => (
                <li key={item.id} className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-[13px]">
                  <span className="min-w-0 truncate">
                    {item.versionString ? `App version ${item.versionString}` : item.itemType.replace(/([A-Z])/g, ' $1').toLowerCase()}
                  </span>
                  <Badge variant={itemBadge(item.state)}>{item.state.replace(/_/g, ' ').toLowerCase()}</Badge>
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <a href={ascUrl} target="_blank" rel="noreferrer">
              <Button variant="outline" size="sm">
                <FileText className="size-3.5" /> {rejected ? 'Read Apple’s message & reply' : 'Open in App Store Connect'}
              </Button>
            </a>
            {rejected && canSubmit && (
              <Button size="sm" onClick={() => setConfirmOpen(true)} loading={submit.isPending}>
                <Rocket className="size-3.5" /> Resubmit to App Review
              </Button>
            )}
            {canSubmit && (
              <Button variant="outline" size="sm" onClick={() => cancel.mutate()} loading={cancel.isPending}>
                Withdraw from review
              </Button>
            )}
          </div>
          {rejected && (
            <p className="text-[11px] text-muted-foreground">
              Apple only shows its rejection reasons and message thread inside App Store Connect — the
              button above lands directly on this submission’s messages, where you can also reply.
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {submission && !isOpen && (
            <p className="text-[13px] text-muted-foreground">
              Last submission {describeSubmissionState(submission.state).toLowerCase()}
              {submission.submittedDate ? ` — sent ${new Date(submission.submittedDate).toLocaleDateString()}` : ''}.
            </p>
          )}
          <ul className="space-y-1.5 text-[13px]">
            <li className={editable ? 'text-foreground' : 'text-muted-foreground'}>
              {editable ? '✓' : '○'} Editable version {editable ? `v${editable.versionString}` : '(create one first)'}
            </li>
            <li className={buildAttached ? 'text-foreground' : 'text-muted-foreground'}>
              {buildAttached ? '✓' : '○'} Build attached {editable?.build ? `(build ${editable.build.version})` : '(pick one in the Version tab)'}
            </li>
          </ul>
          <Button
            size="sm"
            disabled={!canSubmit || !ready}
            onClick={() => setConfirmOpen(true)}
            loading={submit.isPending}
          >
            <Rocket className="size-3.5" /> Submit for review
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`${rejected ? 'Resubmit' : 'Submit'} v${editable?.versionString ?? ''} ${rejected ? 'to' : 'for'} App Review?`}
        description={
          rejected
            ? 'Make sure you fixed what Apple flagged — repeated identical submissions can slow down review.'
            : 'Apple will review this version. Metadata and the attached build become locked while it’s in review.'
        }
        confirmLabel={rejected ? 'Resubmit to Apple' : 'Submit to Apple'}
        loading={submit.isPending}
        onConfirm={() => {
          setConfirmOpen(false);
          submit.mutate();
        }}
      />
    </SectionCard>
  );
}

// ---- App Review details ----

function ReviewDetailCard({
  storeId,
  appId,
  platform,
  detailSection,
  canEdit,
  onDone,
}: {
  storeId: string;
  appId: string;
  platform: Platform;
  detailSection: AppExtrasResult['reviewDetail'];
  canEdit: boolean;
  onDone: () => void;
}) {
  const { uid } = useSession();
  const detail: ReviewDetailData | null = detailSection.ok ? detailSection.data : null;
  const baseline = useMemo(
    () => ({
      contactFirstName: detail?.contactFirstName ?? '',
      contactLastName: detail?.contactLastName ?? '',
      contactPhone: detail?.contactPhone ?? '',
      contactEmail: detail?.contactEmail ?? '',
      demoAccountName: detail?.demoAccountName ?? '',
      demoAccountPassword: detail?.demoAccountPassword ?? '',
      demoAccountRequired: detail?.demoAccountRequired ?? false,
      notes: detail?.notes ?? '',
    }),
    [detail],
  );
  const [form, setForm] = useState(baseline);
  const baselineKey = JSON.stringify(baseline);
  useEffect(() => setForm(baseline), [baselineKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const [showPassword, setShowPassword] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; fileName: string } | null>(null);

  const dirty = JSON.stringify(form) !== baselineKey;

  const save = useMutation({
    mutationFn: () => api.reviewDetailSave({ storeId, appId, platform, ...form }),
    onSuccess: () => {
      toast.success('Review details saved');
      onDone();
    },
    onError: (err) => toast.error('Couldn’t save review details', { description: callableMessage(err) }),
  });

  const removeAttachment = useMutation({
    mutationFn: (attachmentId: string) => api.reviewAttachmentDelete({ storeId, appId, platform, attachmentId }),
    onSuccess: () => {
      toast.success('Attachment removed');
      onDone();
    },
    onError: (err) => toast.error('Couldn’t remove attachment', { description: callableMessage(err) }),
  });

  async function uploadAttachment(file: File) {
    if (!uid) return;
    if (file.size > MAX_REVIEW_ATTACHMENT_BYTES) {
      toast.error('Attachments are limited to 30 MB.');
      return;
    }
    setUploading(true);
    try {
      const path = `staging/${uid}/att-${Date.now()}-${file.name.replace(/[^\w.-]+/g, '_')}`;
      const task = uploadBytesResumable(storageRef(storage, path), file, { contentType: file.type });
      await new Promise<void>((resolve, reject) => task.on('state_changed', undefined, reject, () => resolve()));
      await api.reviewAttachmentUpload({ storeId, appId, platform, storagePath: path, fileName: file.name });
      toast.success('Attachment uploaded');
      onDone();
    } catch (err) {
      toast.error('Upload failed', { description: callableMessage(err) });
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  if (!detailSection.ok) {
    return (
      <SectionCard title="App Review details">
        <SectionError error={detailSection.error} />
      </SectionCard>
    );
  }

  return (
    <SectionCard
      title="App Review details"
      badge={detail ? <Badge variant="success">Configured</Badge> : <Badge variant="outline">Not set</Badge>}
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="rd-first">First name</Label>
            <Input
              id="rd-first"
              value={form.contactFirstName}
              disabled={!canEdit}
              maxLength={REVIEW_DETAIL_LIMITS.contactFirstName}
              onChange={(e) => setForm((f) => ({ ...f, contactFirstName: e.target.value }))}
            />
          </div>
          <div>
            <Label htmlFor="rd-last">Last name</Label>
            <Input
              id="rd-last"
              value={form.contactLastName}
              disabled={!canEdit}
              maxLength={REVIEW_DETAIL_LIMITS.contactLastName}
              onChange={(e) => setForm((f) => ({ ...f, contactLastName: e.target.value }))}
            />
          </div>
          <div>
            <Label htmlFor="rd-phone">Phone</Label>
            <Input
              id="rd-phone"
              value={form.contactPhone}
              disabled={!canEdit}
              placeholder="+1 555 0100"
              maxLength={REVIEW_DETAIL_LIMITS.contactPhone}
              onChange={(e) => setForm((f) => ({ ...f, contactPhone: e.target.value }))}
            />
          </div>
          <div>
            <Label htmlFor="rd-email">Email</Label>
            <Input
              id="rd-email"
              type="email"
              value={form.contactEmail}
              disabled={!canEdit}
              maxLength={REVIEW_DETAIL_LIMITS.contactEmail}
              onChange={(e) => setForm((f) => ({ ...f, contactEmail: e.target.value }))}
            />
          </div>
        </div>

        <div className="rounded-lg border bg-muted/25 p-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-[13px] font-medium">Demo account</div>
              <FieldHint className="mt-0">Required when your app needs a sign-in to review.</FieldHint>
            </div>
            <Switch
              checked={form.demoAccountRequired}
              disabled={!canEdit}
              onCheckedChange={(checked) => setForm((f) => ({ ...f, demoAccountRequired: checked }))}
            />
          </div>
          {form.demoAccountRequired && (
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="rd-demo-user">Demo username</Label>
                <Input
                  id="rd-demo-user"
                  value={form.demoAccountName}
                  disabled={!canEdit}
                  autoComplete="off"
                  maxLength={REVIEW_DETAIL_LIMITS.demoAccountName}
                  onChange={(e) => setForm((f) => ({ ...f, demoAccountName: e.target.value }))}
                />
              </div>
              <div>
                <Label htmlFor="rd-demo-pass">Demo password</Label>
                <div className="relative">
                  <Input
                    id="rd-demo-pass"
                    type={showPassword ? 'text' : 'password'}
                    value={form.demoAccountPassword}
                    disabled={!canEdit}
                    autoComplete="new-password"
                    maxLength={REVIEW_DETAIL_LIMITS.demoAccountPassword}
                    className="pr-9"
                    onChange={(e) => setForm((f) => ({ ...f, demoAccountPassword: e.target.value }))}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    {showPassword ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                  </button>
                </div>
                <FieldHint>Sent only to Apple. Not shown to viewers and never logged.</FieldHint>
              </div>
            </div>
          )}
        </div>

        <div>
          <Label htmlFor="rd-notes">Notes for the reviewer</Label>
          <Textarea
            id="rd-notes"
            rows={4}
            value={form.notes}
            disabled={!canEdit}
            maxLength={REVIEW_DETAIL_LIMITS.notes}
            placeholder="Anything that helps Apple review this version (test flows, feature flags, known limitations)…"
            onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
          />
        </div>

        {/* Attachments */}
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <Label className="mb-0">Attachments</Label>
            {canEdit && (
              <>
                <input
                  ref={fileInput}
                  type="file"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void uploadAttachment(file);
                  }}
                />
                <Button variant="outline" size="sm" onClick={() => fileInput.current?.click()} loading={uploading}>
                  <Upload className="size-3.5" /> Upload
                </Button>
              </>
            )}
          </div>
          {detail?.attachments?.length ? (
            <ul className="divide-y rounded-lg border">
              {detail.attachments.map((a) => (
                <li key={a.id} className="flex items-center gap-2.5 px-3 py-2 text-[13px]">
                  <Paperclip className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{a.fileName}</span>
                  <span className="text-[11px] text-muted-foreground">
                    {a.fileSize ? `${Math.round(a.fileSize / 1024)} KB` : ''}
                  </span>
                  {canEdit && (
                    <button
                      onClick={() => setDeleteTarget({ id: a.id, fileName: a.fileName })}
                      className="text-muted-foreground transition-colors hover:text-destructive"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="rounded-lg border border-dashed px-3 py-2.5 text-[12px] text-muted-foreground">
              No attachments. Upload screen recordings or documents that help the review.
            </p>
          )}
        </div>

        {canEdit && (
          <div className="flex justify-end gap-2 border-t pt-3">
            {dirty && (
              <Button variant="ghost" size="sm" onClick={() => setForm(baseline)} disabled={save.isPending}>
                Discard
              </Button>
            )}
            <Button size="sm" onClick={() => save.mutate()} loading={save.isPending} disabled={!dirty}>
              Save review details
            </Button>
          </div>
        )}
      </div>
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={() => setDeleteTarget(null)}
        title={`Delete ${deleteTarget?.fileName ?? ''}?`}
        description="Removes this attachment from App Store Connect."
        confirmLabel="Delete"
        destructive
        loading={removeAttachment.isPending}
        onConfirm={() => {
          if (deleteTarget) removeAttachment.mutate(deleteTarget.id);
          setDeleteTarget(null);
        }}
      />
    </SectionCard>
  );
}

// ---- Phased release ----

function PhasedReleaseCard({
  storeId,
  appId,
  platform,
  data,
  canManage,
  onDone,
}: {
  storeId: string;
  appId: string;
  platform: Platform;
  data: AppExtrasResult;
  canManage: boolean;
  onDone: () => void;
}) {
  const phased = data.phasedRelease.ok ? data.phasedRelease.data : null;
  const act = useMutation({
    mutationFn: (action: 'enable' | 'pause' | 'resume' | 'complete' | 'disable') =>
      api.phasedReleaseSet({ storeId, appId, platform, action }),
    onSuccess: () => {
      toast.success('Phased release updated');
      onDone();
    },
    onError: (err) => toast.error('Couldn’t update phased release', { description: callableMessage(err) }),
  });

  if (!data.phasedRelease.ok) {
    return (
      <SectionCard title="Phased release">
        <SectionError error={data.phasedRelease.error} />
      </SectionCard>
    );
  }

  const state = phased?.state as PhasedReleaseState | undefined;
  const percent = phasedReleasePercent(phased?.currentDayNumber);

  return (
    <SectionCard
      title="Phased release"
      badge={
        state ? (
          <Badge variant={state === 'ACTIVE' ? 'success' : state === 'PAUSED' ? 'warning' : 'neutral'}>
            {PHASED_RELEASE_STATE_LABELS[state] ?? state}
          </Badge>
        ) : (
          <Badge variant="outline">Off</Badge>
        )
      }
    >
      <div className="space-y-3">
        {phased && state === 'ACTIVE' && (
          <div>
            <div className="flex justify-between text-[12px] text-muted-foreground">
              <span>Day {phased.currentDayNumber ?? '—'} of 7</span>
              <span>{percent ?? '—'}% of users</span>
            </div>
            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-primary/15">
              <div className="h-full rounded-full bg-primary" style={{ width: `${percent ?? 0}%` }} />
            </div>
          </div>
        )}
        <p className="text-[13px] text-muted-foreground">
          Releases the update gradually over 7 days (1% → 100%) to users with automatic updates on. You can pause or
          release to everyone at any time.
        </p>
        {canManage && (
          <div className="flex flex-wrap gap-2">
            {!phased && (
              <Button variant="outline" size="sm" onClick={() => act.mutate('enable')} loading={act.isPending}>
                Enable 7-day rollout
              </Button>
            )}
            {phased && state === 'INACTIVE' && (
              <Button variant="outline" size="sm" onClick={() => act.mutate('disable')} loading={act.isPending}>
                Turn off
              </Button>
            )}
            {phased && state === 'ACTIVE' && (
              <>
                <Button variant="outline" size="sm" onClick={() => act.mutate('pause')} loading={act.isPending}>
                  Pause
                </Button>
                <Button variant="outline" size="sm" onClick={() => act.mutate('complete')} loading={act.isPending}>
                  Release to everyone
                </Button>
              </>
            )}
            {phased && state === 'PAUSED' && (
              <>
                <Button variant="outline" size="sm" onClick={() => act.mutate('resume')} loading={act.isPending}>
                  Resume
                </Button>
                <Button variant="outline" size="sm" onClick={() => act.mutate('complete')} loading={act.isPending}>
                  Release to everyone
                </Button>
              </>
            )}
          </div>
        )}
      </div>
    </SectionCard>
  );
}

// ---- Age rating ----

function AgeRatingCard({
  storeId,
  appId,
  platform,
  section,
  canEdit,
  onDone,
}: {
  storeId: string;
  appId: string;
  platform: Platform;
  section: AppExtrasResult['ageRating'];
  canEdit: boolean;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  if (!section.ok) {
    return (
      <SectionCard title="Age rating">
        <SectionError error={section.error} />
      </SectionCard>
    );
  }
  const rating = section.data;
  const flagged = rating
    ? AGE_RATING_LEVEL_FIELDS.filter(({ key }) => rating.levels[key] !== 'NONE').length +
      AGE_RATING_BOOL_FIELDS.filter(({ key }) => rating.booleans[key]).length
    : 0;

  return (
    <SectionCard
      title="Age rating"
      badge={
        rating ? (
          <Badge variant={flagged > 0 ? 'accent' : 'success'}>
            {flagged > 0 ? `${flagged} declared` : 'All none'}
          </Badge>
        ) : (
          <Badge variant="outline">Unavailable</Badge>
        )
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13px] text-muted-foreground">
          {rating
            ? rating.kidsAgeBand
              ? `Made for Kids (${KIDS_AGE_BAND_LABELS[rating.kidsAgeBand]}).`
              : 'Apple derives the storefront age rating from these declarations.'
            : 'The age rating questionnaire could not be loaded.'}
        </p>
        {rating && canEdit && (
          <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
            <FileText className="size-3.5" /> Edit declarations
          </Button>
        )}
      </div>
      {rating && (
        <AgeRatingDialog
          open={open}
          onOpenChange={setOpen}
          storeId={storeId}
          appId={appId}
          platform={platform}
          initial={rating}
          onDone={onDone}
        />
      )}
    </SectionCard>
  );
}

function AgeRatingDialog({
  open,
  onOpenChange,
  storeId,
  appId,
  platform,
  initial,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  storeId: string;
  appId: string;
  platform: Platform;
  initial: AgeRatingValues & { id: string };
  onDone: () => void;
}) {
  const [levels, setLevels] = useState(initial.levels);
  const [booleans, setBooleans] = useState(initial.booleans);
  const [kidsAgeBand, setKidsAgeBand] = useState<KidsAgeBand | null>(initial.kidsAgeBand);
  useEffect(() => {
    if (open) {
      setLevels(initial.levels);
      setBooleans(initial.booleans);
      setKidsAgeBand(initial.kidsAgeBand);
    }
  }, [open, initial]);

  const save = useMutation({
    mutationFn: () => api.ageRatingSave({ storeId, appId, platform, levels, booleans, kidsAgeBand }),
    onSuccess: () => {
      toast.success('Age rating saved');
      onDone();
      onOpenChange(false);
    },
    onError: (err) => toast.error('Couldn’t save age rating', { description: callableMessage(err) }),
  });

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!save.isPending) onOpenChange(o); }}>
      <DialogContent wide className="max-h-[85vh] overflow-y-auto">
        <DialogHeader
          title="Age rating declarations"
          description="Answer Apple's content questionnaire. The App Store shows the resulting age rating automatically."
        />
        <div className="space-y-2.5">
          {AGE_RATING_LEVEL_FIELDS.map(({ key, label }) => (
            <div key={key} className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
              <span className="text-[13px]">{label}</span>
              <Select
                value={levels[key] ?? 'NONE'}
                onValueChange={(v) => setLevels((prev) => ({ ...prev, [key]: v as typeof AGE_RATING_LEVELS[number] }))}
              >
                <SelectTrigger className="w-full sm:w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {AGE_RATING_LEVELS.map((lvl) => (
                    <SelectItem key={lvl} value={lvl}>
                      {AGE_RATING_LEVEL_LABELS[lvl]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ))}
          <div className="border-t pt-2.5" />
          {AGE_RATING_BOOL_FIELDS.map(({ key, label }) => (
            <div key={key} className="flex items-center justify-between">
              <span className="text-[13px]">{label}</span>
              <Switch
                checked={booleans[key] ?? false}
                onCheckedChange={(checked) => setBooleans((prev) => ({ ...prev, [key]: checked }))}
              />
            </div>
          ))}
          <div className="flex items-center justify-between border-t pt-2.5">
            <span className="text-[13px]">Made for Kids age band</span>
            <Select
              value={kidsAgeBand ?? 'none'}
              onValueChange={(v) => setKidsAgeBand(v === 'none' ? null : (v as KidsAgeBand))}
            >
              <SelectTrigger className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Not in Kids category</SelectItem>
                {(Object.keys(KIDS_AGE_BAND_LABELS) as KidsAgeBand[]).map((band) => (
                  <SelectItem key={band} value={band}>
                    {KIDS_AGE_BAND_LABELS[band]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={save.isPending}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending}>
            Save declarations
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ExtrasLoadingHint() {
  return (
    <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
      <Loader2 className="size-4 animate-spin" /> Loading from App Store Connect…
    </div>
  );
}
