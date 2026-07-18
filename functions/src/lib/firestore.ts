import { getFirestore, Timestamp, FieldValue, type Firestore } from 'firebase-admin/firestore';
import type {
  AllowlistDoc,
  AppDoc,
  AuditLogDoc,
  DraftDoc,
  LocaleDoc,
  OperationDoc,
  ScreenshotSetDoc,
  StoreDoc,
  StoreSecretDoc,
  UserDoc,
} from '@asm/shared';

export { Timestamp, FieldValue };

let _db: Firestore | null = null;
export function db(): Firestore {
  if (!_db) _db = getFirestore();
  return _db;
}

// Typed collection helpers (admin SDK is structurally typed via withConverter-free casts;
// all writes go through these so shapes stay consistent with @asm/shared).
export const refs = {
  user: (uid: string) => db().collection('users').doc(uid),
  userPrefs: (uid: string) => db().collection('userPrefs').doc(uid),
  allowlist: (email: string) => db().collection('allowlist').doc(email.toLowerCase()),
  accessRequest: (uid: string) => db().collection('accessRequests').doc(uid),
  store: (sid: string) => db().collection('stores').doc(sid),
  storeSecret: (sid: string) => db().collection('storeSecrets').doc(sid),
  app: (sid: string, aid: string) => refs.store(sid).collection('apps').doc(aid),
  locale: (sid: string, aid: string, locale: string) =>
    refs.app(sid, aid).collection('locales').doc(locale),
  draft: (sid: string, aid: string, locale: string) =>
    refs.app(sid, aid).collection('drafts').doc(locale),
  screenshotSet: (sid: string, aid: string, key: string) =>
    refs.app(sid, aid).collection('screenshotSets').doc(key),
  operations: () => db().collection('operations'),
  auditLogs: () => db().collection('auditLogs'),
  settings: () => db().collection('settings').doc('global'),
  // Advertising: accounts (admin-readable, no secrets), encrypted credentials
  // (locked), workspace sync status, and daily rollups.
  adsAccounts: () => db().collection('adsAccounts'),
  adsAccount: (id: string) => db().collection('adsAccounts').doc(id),
  adsAccountSecret: (id: string) => db().collection('adsAccountSecrets').doc(id),
  adsConfig: () => db().collection('adsConfig').doc('status'),
  adsDay: (date: string) => db().collection('adsDays').doc(date),
  adsDays: () => db().collection('adsDays'),
};

export async function getUserDoc(uid: string): Promise<UserDoc | null> {
  const snap = await refs.user(uid).get();
  return snap.exists ? (snap.data() as UserDoc) : null;
}

export async function getStoreDoc(sid: string): Promise<StoreDoc | null> {
  const snap = await refs.store(sid).get();
  return snap.exists ? (snap.data() as StoreDoc) : null;
}

export async function getAppDoc(sid: string, aid: string): Promise<AppDoc | null> {
  const snap = await refs.app(sid, aid).get();
  return snap.exists ? (snap.data() as AppDoc) : null;
}

export type {
  AllowlistDoc,
  AppDoc,
  AuditLogDoc,
  DraftDoc,
  LocaleDoc,
  OperationDoc,
  ScreenshotSetDoc,
  StoreDoc,
  StoreSecretDoc,
  UserDoc,
};

/** Commit writes in chunks below Firestore's per-batch limit. */
export async function chunkedBatch(
  ops: Array<(batch: FirebaseFirestore.WriteBatch) => void>,
  chunkSize = 400,
): Promise<void> {
  for (let i = 0; i < ops.length; i += chunkSize) {
    const batch = db().batch();
    for (const op of ops.slice(i, i + chunkSize)) op(batch);
    await batch.commit();
  }
}
