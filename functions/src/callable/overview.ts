import {
  effectiveRole,
  isAdminUser,
  versionBucket,
  type AppDoc,
  type AppleDeviceFamily,
  type Platform,
  type StoreDoc,
  type StoreRole,
} from '@asm/shared';
import { defineCallable } from '../lib/wrap';
import { db, refs } from '../lib/firestore';

export interface OverviewRow {
  storeId: string;
  storeName: string;
  storeColor: string | null;
  storeIcon: string | null;
  appId: string;
  appName: string;
  iconUrl: string | null;
  platform: Platform;
  /** All platforms the app ships on + finer device families — for badge rendering. */
  platforms: Platform[];
  devices: AppleDeviceFamily[] | null;
  versionString: string;
  state: string;
  bucket: 'rejected' | 'waiting' | 'inReview' | 'approved' | 'draft' | 'live' | 'none';
}

/**
 * One compact row per (app, platform, version-branch) across every store the
 * caller can see — powers the dashboard status cards. Reads cached app docs
 * only (no Apple calls), so it's fast and cheap; freshness comes from the
 * regular store/app syncs.
 */
export const appsOverview = defineCallable(
  'appsOverview',
  {
    timeoutSeconds: 60,
    memory: '512MiB',
    // No authorize hook: any active user may call; visibility is filtered per store below.
  },
  async (_input: Record<string, never>, actor) => {
    const admin = isAdminUser(actor.user);
    const storesSnap = admin
      ? await db().collection('stores').get()
      : { docs: [] as FirebaseFirestore.QueryDocumentSnapshot[] };

    let stores: Array<{ id: string; data: StoreDoc }>;
    if (admin) {
      stores = storesSnap.docs.map((doc) => ({ id: doc.id, data: doc.data() as StoreDoc }));
    } else {
      const ids = Object.keys(actor.user.grants ?? {}).filter(
        (sid) => effectiveRole(actor.user, sid) !== null || actor.user.grants?.[sid]?.apps,
      );
      const snaps = await Promise.all(ids.map((sid) => refs.store(sid).get()));
      stores = snaps.flatMap((snap) => (snap.exists ? [{ id: snap.id, data: snap.data() as StoreDoc }] : []));
    }

    const rows: OverviewRow[] = [];
    await Promise.all(
      stores.map(async (store) => {
        const appsSnap = await refs.store(store.id).collection('apps').get();
        for (const appDoc of appsSnap.docs) {
          const app = appDoc.data() as AppDoc;
          if (app.removedFromAsc) continue;
          if (!admin) {
            // Per-app grant narrowing + per-app ACL override, same as the UI.
            if (effectiveRole(actor.user, store.id, appDoc.id) === null) continue;
            const acl = app.acl?.[actor.uid] as StoreRole | 'none' | undefined;
            if (acl === 'none') continue;
          }
          const base = {
            storeId: store.id,
            storeName: store.data.name,
            storeColor: store.data.color ?? null,
            storeIcon: store.data.icon ?? null,
            appId: appDoc.id,
            appName: app.name,
            iconUrl: app.iconUrl ?? null,
            platforms: app.platforms ?? [],
            devices: app.devices ?? null,
          };
          let emitted = 0;
          for (const [platform, branches] of Object.entries(app.versions ?? {})) {
            const editable = branches?.editable;
            const live = branches?.live;
            if (editable) {
              const bucket = versionBucket(editable.state);
              if (bucket) {
                emitted += 1;
                rows.push({
                  ...base,
                  platform: platform as Platform,
                  versionString: editable.versionString,
                  state: editable.state,
                  bucket,
                });
              }
            }
            // Versions with Apple (waiting / in review / approved) are cached on
            // their own `review` branch — the header reads it, so must the cards.
            const review = branches?.review;
            if (review) {
              const bucket = versionBucket(review.state);
              if (bucket) {
                emitted += 1;
                rows.push({
                  ...base,
                  platform: platform as Platform,
                  versionString: review.versionString,
                  state: review.state,
                  bucket,
                });
              }
            }
            if (live) {
              emitted += 1;
              rows.push({
                ...base,
                platform: platform as Platform,
                versionString: live.versionString,
                state: live.state,
                bucket: 'live',
              });
            }
          }
          // Apps with no synced version data (fresh stores) must still exist for
          // global search — a placeholder row the status cards simply ignore.
          if (emitted === 0) {
            rows.push({
              ...base,
              platform: (app.platforms?.[0] ?? 'IOS') as Platform,
              versionString: '',
              state: 'NOT_SYNCED',
              bucket: 'none',
            });
          }
        }
      }),
    );

    // Rejected first inside each bucket list; the client group-bys on `bucket`.
    rows.sort((a, b) => a.storeName.localeCompare(b.storeName) || a.appName.localeCompare(b.appName));
    return { rows };
  },
);
