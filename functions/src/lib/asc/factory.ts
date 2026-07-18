import type { StoreDoc, StoreSecretDoc } from '@asm/shared';
import { AppError, notFound } from '../errors';
import { Timestamp, refs } from '../firestore';
import { decryptSecret } from '../crypto';
import { mockAscEnabled } from '../../config';
import { AscClient } from './client';
import { getMockAsc } from './mock';
import type { AscApi } from './types';

const lastRateWrite = new Map<string, number>();

/**
 * Resolve the ASC API for a store: fixture mock (emulator / store.mock) or the real
 * client with decrypted credentials. Rate headers are persisted (throttled) so the UI
 * can show remaining budget and background syncs can yield.
 */
export async function getAscApi(storeId: string): Promise<AscApi> {
  const storeSnap = await refs.store(storeId).get();
  if (!storeSnap.exists) throw notFound('Store');
  const store = storeSnap.data() as StoreDoc;

  if (store.mock || mockAscEnabled()) return getMockAsc(storeId);

  const secretSnap = await refs.storeSecret(storeId).get();
  if (!secretSnap.exists) {
    throw new AppError('failed-precondition', 'This store has no API key — add one in store settings.');
  }
  const secret = secretSnap.data() as StoreSecretDoc;
  const p8 = decryptSecret(secret.p8, storeId);

  return new AscClient({ issuerId: secret.issuerId, keyId: secret.keyId, p8 }, (rate) => {
    const last = lastRateWrite.get(storeId) ?? 0;
    if (Date.now() - last < 15_000) return;
    lastRateWrite.set(storeId, Date.now());
    refs
      .store(storeId)
      .update({ rate: { limit: rate.limit, remaining: rate.remaining, at: Timestamp.now() } })
      .catch(() => {});
  });
}

/** Flag a store whose key Apple rejected; background syncs stop until the key is fixed. */
export async function markStoreAuthError(storeId: string, err: unknown): Promise<boolean> {
  if (err instanceof AppError && (err.details as { ascAuth?: boolean } | undefined)?.ascAuth) {
    await refs.store(storeId).update({ status: 'auth_error' }).catch(() => {});
    return true;
  }
  return false;
}
