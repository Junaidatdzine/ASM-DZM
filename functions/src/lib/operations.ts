import type { OperationStatus, OperationType, Platform } from '@asm/shared';
import { Timestamp, refs } from './firestore';

const OPERATION_TTL_DAYS = 7;

export interface OperationHandle {
  id: string;
  progress(
    done: number,
    total: number,
    counts?: { added?: number; skipped?: number; failed?: number },
  ): void;
  finish(status: Extract<OperationStatus, 'success' | 'partial'>, label?: string): Promise<void>;
  fail(error: string): Promise<void>;
}

/** Live progress doc powering the Activity UI. Writes are throttled and best-effort. */
export async function startOperation(opts: {
  type: OperationType;
  label: string;
  startedBy: string;
  storeId?: string;
  appId?: string;
  locale?: string;
  platform?: Platform;
}): Promise<OperationHandle> {
  const ref = refs.operations().doc();
  const expireAt = Timestamp.fromMillis(Date.now() + OPERATION_TTL_DAYS * 24 * 3600 * 1000);
  await ref.set({
    type: opts.type,
    status: 'running',
    label: opts.label,
    ...(opts.storeId ? { storeId: opts.storeId } : {}),
    ...(opts.appId ? { appId: opts.appId } : {}),
    ...(opts.locale ? { locale: opts.locale } : {}),
    ...(opts.platform ? { platform: opts.platform } : {}),
    startedBy: opts.startedBy,
    startedAt: Timestamp.now(),
    expireAt,
  });

  let lastWrite = 0;
  return {
    id: ref.id,
    progress(done, total, counts) {
      const now = Date.now();
      if (now - lastWrite < 900 && done < total) return; // throttle
      lastWrite = now;
      ref.update({ progress: { done, total, ...counts } }).catch(() => {});
    },
    async finish(status, label) {
      await ref
        .update({ status, finishedAt: Timestamp.now(), ...(label ? { label } : {}) })
        .catch(() => {});
    },
    async fail(error: string) {
      await ref
        .update({ status: 'error', error: error.slice(0, 500), finishedAt: Timestamp.now() })
        .catch(() => {});
    },
  };
}

/**
 * Transaction lease on a doc's `sync` field — prevents concurrent syncs of the same
 * target. Returns false when someone else holds a live lease.
 */
export async function acquireLease(
  ref: FirebaseFirestore.DocumentReference,
  by: string,
  seconds = 600,
): Promise<boolean> {
  const dbRef = ref.firestore;
  return dbRef.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return false;
    const sync = snap.get('sync') as { leaseUntil?: Timestamp | null } | undefined;
    if (sync?.leaseUntil && sync.leaseUntil.toMillis() > Date.now()) return false;
    tx.update(ref, { sync: { leaseUntil: Timestamp.fromMillis(Date.now() + seconds * 1000), by } });
    return true;
  });
}

export async function releaseLease(ref: FirebaseFirestore.DocumentReference): Promise<void> {
  await ref.update({ sync: { leaseUntil: null, by: null } }).catch(() => {});
}
