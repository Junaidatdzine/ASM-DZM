import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageSquareReply, RefreshCw, Sparkles, Star, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import type { CustomerReviewEntry, Platform } from '@asm/shared';
import { CUSTOMER_REVIEW_RESPONSE_MAX } from '@asm/shared';
import { api, callableMessage } from '@/lib/callables';
import { useSession } from '@/auth/AuthProvider';
import { Badge } from '@/components/ui/Badge';
import { Tooltip } from '@/components/ui/Tooltip';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { Textarea } from '@/components/ui/Textarea';
import { cn, timeAgo } from '@/lib/utils';

type StatusFilter = 'all' | 'needs-reply' | 'replied' | 'pending-publish';

const STATUS_FILTERS: Array<{ key: StatusFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'needs-reply', label: 'Needs reply' },
  { key: 'replied', label: 'Replied' },
  { key: 'pending-publish', label: 'Pending publish' },
];

function matchesStatus(review: CustomerReviewEntry, filter: StatusFilter): boolean {
  switch (filter) {
    case 'needs-reply':
      return !review.response;
    case 'replied':
      return !!review.response;
    case 'pending-publish':
      return review.response?.state === 'PENDING_PUBLISH';
    default:
      return true;
  }
}

function Stars({ rating }: { rating: number }) {
  return (
    <span className="inline-flex items-center gap-0.5" aria-label={`${rating} out of 5 stars`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <Star
          key={i}
          className={`size-3.5 ${i <= rating ? 'fill-warning text-warning' : 'text-muted-foreground/30'}`}
        />
      ))}
    </span>
  );
}

/** Best-effort flag from a 3-letter Apple territory code (USA → US → 🇺🇸). */
function territoryFlag(territory: string): string {
  const two = territory.slice(0, 2).toUpperCase();
  if (!/^[A-Z]{2}$/.test(two)) return '';
  return String.fromCodePoint(...[...two].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

export function ReviewsTab({
  storeId,
  appId,
  platform,
  canRespond,
}: {
  storeId: string;
  appId: string;
  platform: Platform;
  canRespond: boolean;
}) {
  const { user } = useSession();
  const queryClient = useQueryClient();
  const key = ['customerReviews', storeId, appId];
  const reviewsQ = useQuery({
    queryKey: key,
    queryFn: () => api.customerReviewsList({ storeId, appId, platform, limit: 100 }),
    staleTime: 120_000,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: key });

  const [status, setStatus] = useState<StatusFilter>('all');
  const [ratingFilter, setRatingFilter] = useState<number>(0); // 0 = all

  const reviews = useMemo(() => reviewsQ.data?.reviews ?? [], [reviewsQ.data]);
  const average =
    reviews.length > 0 ? Math.round((reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length) * 10) / 10 : null;
  const counts = useMemo(
    () =>
      Object.fromEntries(
        STATUS_FILTERS.map(({ key: k }) => [k, reviews.filter((r) => matchesStatus(r, k)).length]),
      ) as Record<StatusFilter, number>,
    [reviews],
  );
  const visible = useMemo(
    () => reviews.filter((r) => matchesStatus(r, status) && (ratingFilter === 0 || r.rating === ratingFilter)),
    [reviews, status, ratingFilter],
  );
  const aiEnabled = canRespond && !!user?.ai?.features.generate;

  return (
    <div className="max-w-3xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          {average !== null && (
            <>
              <span className="text-2xl font-semibold tabular-nums">{average}</span>
              <div>
                <Stars rating={Math.round(average)} />
                <div className="text-[11px] text-muted-foreground">
                  {reviews.length} recent {reviews.length === 1 ? 'review' : 'reviews'}
                </div>
              </div>
            </>
          )}
        </div>
        <Button variant="outline" size="sm" onClick={() => refresh()} loading={reviewsQ.isFetching}>
          <RefreshCw className="size-3.5" /> Refresh
        </Button>
      </div>

      {/* Status + rating filters */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1.5">
          {STATUS_FILTERS.map(({ key: k, label }) => (
            <button
              key={k}
              onClick={() => setStatus(k)}
              className={cn(
                'rounded-full border px-2.5 py-1 text-[12px] font-medium transition-colors',
                status === k
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              {label}
              <span className="ml-1 tabular-nums opacity-70">{counts[k] ?? 0}</span>
            </button>
          ))}
        </div>
        <Select value={String(ratingFilter)} onValueChange={(v) => setRatingFilter(Number(v))}>
          <SelectTrigger className="h-7 w-32 rounded-full text-[12px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="0">All ratings</SelectItem>
            {[5, 4, 3, 2, 1].map((r) => (
              <SelectItem key={r} value={String(r)}>
                {r} star{r === 1 ? '' : 's'}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {reviewsQ.isLoading ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-32" />
          ))}
        </div>
      ) : reviewsQ.isError ? (
        <div className="rounded-xl border border-dashed p-6 text-center text-[13px] text-muted-foreground">
          {callableMessage(reviewsQ.error)}
        </div>
      ) : reviews.length === 0 ? (
        <div className="rounded-xl border border-dashed p-10 text-center text-[13px] text-muted-foreground">
          No customer reviews yet.
        </div>
      ) : visible.length === 0 ? (
        <div className="rounded-xl border border-dashed p-10 text-center text-[13px] text-muted-foreground">
          No reviews match this filter.
        </div>
      ) : (
        <div className="space-y-3">
          {visible.map((review) => (
            <ReviewCard
              key={review.id}
              review={review}
              storeId={storeId}
              appId={appId}
              platform={platform}
              canRespond={canRespond}
              aiEnabled={aiEnabled}
              onDone={refresh}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ReviewCard({
  review,
  storeId,
  appId,
  platform,
  canRespond,
  aiEnabled,
  onDone,
}: {
  review: CustomerReviewEntry;
  storeId: string;
  appId: string;
  platform: Platform;
  canRespond: boolean;
  aiEnabled: boolean;
  onDone: () => void;
}) {
  const [replying, setReplying] = useState(false);
  const [draft, setDraft] = useState(review.response?.body ?? '');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [aiAttempt, setAiAttempt] = useState(0);

  const aiDraft = useMutation({
    mutationFn: () =>
      api.aiReviewReply({ storeId, appId, platform, reviewId: review.id, attempt: aiAttempt }),
    onSuccess: (res) => {
      setDraft(res.reply);
      setAiAttempt((n) => n + 1);
    },
    onError: (err) => toast.error('Couldn’t draft a reply', { description: callableMessage(err) }),
  });

  const respond = useMutation({
    mutationFn: () => api.customerReviewRespond({ storeId, appId, platform, reviewId: review.id, body: draft.trim() }),
    onSuccess: () => {
      toast.success('Response sent', { description: 'Apple publishes responses within a day.' });
      setReplying(false);
      onDone();
    },
    onError: (err) => toast.error('Couldn’t send response', { description: callableMessage(err) }),
  });
  const removeResponse = useMutation({
    mutationFn: () => api.customerReviewResponseDelete({ storeId, appId, platform, responseId: review.response!.id }),
    onSuccess: () => {
      toast.success('Response deleted');
      onDone();
    },
    onError: (err) => toast.error('Couldn’t delete response', { description: callableMessage(err) }),
  });

  const when = review.createdDate ? timeAgo({ toMillis: () => Date.parse(review.createdDate) }) : '';

  return (
    <article className="rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Stars rating={review.rating} />
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{review.title || 'Untitled'}</span>
        <span className="text-[11px] text-muted-foreground">
          {territoryFlag(review.territory)} {review.reviewerNickname} · {when}
        </span>
      </div>
      <p className="mt-2 whitespace-pre-wrap text-[13px] leading-relaxed text-foreground/90">{review.body}</p>

      {review.response ? (
        <div className="mt-3 rounded-lg border-l-2 border-primary bg-muted/30 p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-medium text-muted-foreground">
              Developer response
              {review.response.state === 'PENDING_PUBLISH' && (
                <Tooltip content="Nothing to do — Apple publishes replies automatically, usually within a day. The badge clears on the next refresh once it's live.">
                  <span><Badge variant="warning" className="ml-2">Pending publish</Badge></span>
                </Tooltip>
              )}
            </span>
            {canRespond && (
              <div className="flex gap-1.5">
                <button
                  onClick={() => { setDraft(review.response!.body); setReplying(true); }}
                  className="text-[11px] text-primary hover:underline"
                >
                  Edit
                </button>
                <button
                  onClick={() => setConfirmDelete(true)}
                  className="text-muted-foreground transition-colors hover:text-destructive"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            )}
          </div>
          <p className="mt-1.5 whitespace-pre-wrap text-[13px]">{review.response.body}</p>
        </div>
      ) : canRespond && !replying ? (
        <div className="mt-3">
          <Button variant="outline" size="sm" onClick={() => setReplying(true)}>
            <MessageSquareReply className="size-3.5" /> Respond
          </Button>
        </div>
      ) : null}

      {replying && (
        <div className="mt-3 space-y-2">
          <Textarea
            rows={3}
            value={draft}
            autoFocus
            maxLength={CUSTOMER_REVIEW_RESPONSE_MAX}
            placeholder="Write a public developer response…"
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-3">
              <span className="text-[11px] tabular-nums text-muted-foreground">
                {draft.length}/{CUSTOMER_REVIEW_RESPONSE_MAX}
              </span>
              {aiEnabled && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => aiDraft.mutate()}
                  loading={aiDraft.isPending}
                >
                  <Sparkles className="size-3.5" />
                  {aiAttempt > 0 ? 'Regenerate' : 'Draft with AI'}
                </Button>
              )}
            </div>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={() => setReplying(false)} disabled={respond.isPending}>
                Cancel
              </Button>
              <Button size="sm" onClick={() => respond.mutate()} loading={respond.isPending} disabled={draft.trim() === ''}>
                Send response
              </Button>
            </div>
          </div>
          {aiEnabled && aiAttempt > 0 && (
            <p className="text-[11px] text-muted-foreground">
              AI drafts use your app’s own store metadata — review and edit before sending. Each draft uses 1 AI credit.
            </p>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete this response?"
        description="Removes your public developer response from the App Store."
        confirmLabel="Delete response"
        destructive
        loading={removeResponse.isPending}
        onConfirm={() => {
          setConfirmDelete(false);
          removeResponse.mutate();
        }}
      />
    </article>
  );
}
