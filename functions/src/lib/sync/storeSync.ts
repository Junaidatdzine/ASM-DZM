import type { AppDoc, VersionRef } from '@asm/shared';
import { Timestamp, chunkedBatch, db, refs } from '../firestore';
import { getAscApi } from '../asc/factory';
import type { AscApp, AscVersion } from '../asc/types';
import { fetchPublicMeta, type PublicAppMeta } from '../appleLookup';
import { pickVersions } from './appSync';

/**
 * Lightweight version branches from the list call's included versions — enough
 * for status cards and search on apps nobody has opened yet. Deep sync remains
 * authoritative and overwrites this with build info etc. when it runs.
 */
function summaryVersionsField(versions: AscVersion[] | undefined): AppDoc['versions'] | null {
  if (!versions || versions.length === 0) return null;
  const lite = (v: AscVersion | null): VersionRef | null =>
    v ? { id: v.id, versionString: v.versionString, state: v.state, copyright: '', earliestReleaseDate: null } : null;
  const out: AppDoc['versions'] = {};
  for (const [platform, pick] of pickVersions(versions)) {
    out[platform] = { editable: lite(pick.editable), live: lite(pick.live), review: lite(pick.review) };
  }
  return out;
}

/** Public-listing lookups are best-effort; keep them polite and bounded. */
async function lookupMany(bundleIds: string[], concurrency = 8): Promise<Map<string, PublicAppMeta>> {
  const out = new Map<string, PublicAppMeta>();
  const queue = [...bundleIds];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let id = queue.shift(); id; id = queue.shift()) {
      out.set(id, await fetchPublicMeta(id));
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Reconcile the store's app list with ASC. Cheap (1 request per 200 apps).
 * Deep per-app data is synced lazily by appSync when an app is opened.
 */
export async function runStoreSync(storeId: string, mock: boolean): Promise<{ apps: number }> {
  const api = await getAscApi(storeId);
  const remote = await api.listApps();
  const remoteById = new Map<string, AscApp>(remote.map((a) => [a.id, a]));

  const existingSnap = await refs.store(storeId).collection('apps').get();
  const existingById = new Map(existingSnap.docs.map((d) => [d.id, d.data() as AppDoc]));

  // Public listing fills what ASC can't tell us cheaply (icon, iPhone/iPad split).
  // New apps always; existing apps only while icon or devices are still unknown.
  const wantLookup = mock
    ? []
    : remote.filter((a) => {
        const ex = existingById.get(a.id);
        return !ex || !ex.iconUrl || !ex.devices;
      });
  const publicMeta = await lookupMany(wantLookup.map((a) => a.bundleId));

  const ops: Array<(b: FirebaseFirestore.WriteBatch) => void> = [];

  for (const app of remote) {
    const existing = existingById.get(app.id);
    const pub = publicMeta.get(app.bundleId);
    // Status branches ride along free on the list call — but only for apps the
    // deep sync hasn't enriched yet (it stores builds and more; never clobber it).
    const summary = existing?.deepSyncedAt ? null : summaryVersionsField(app.versionsIncluded);
    const base = {
      name: app.name,
      bundleId: app.bundleId,
      ...(app.sku ? { sku: app.sku } : {}),
      primaryLocale: app.primaryLocale,
      removedFromAsc: false,
      // ASC versions are authoritative for platforms; [] means "no versions yet"
      // — keep the previous value (or the IOS default) rather than blanking it.
      ...(app.platforms?.length ? { platforms: app.platforms } : {}),
      ...(pub?.devices?.length ? { devices: pub.devices } : {}),
      ...(summary ? { versions: summary } : {}),
    };
    if (!existing) {
      ops.push((b) =>
        b.set(refs.app(storeId, app.id), {
          platforms: ['IOS'],
          ...base,
          iconUrl: pub?.iconUrl ?? null,
          appInfo: { editableId: null, editableState: null, liveId: null },
          versions: {},
          locales: [],
        } satisfies Omit<AppDoc, 'deepSyncedAt' | 'sync'>),
      );
    } else {
      ops.push((b) =>
        b.update(refs.app(storeId, app.id), {
          ...base,
          ...(pub?.iconUrl && !existing.iconUrl ? { iconUrl: pub.iconUrl } : {}),
        }),
      );
    }
  }

  for (const [id] of existingById) {
    if (!remoteById.has(id)) {
      ops.push((b) => b.update(refs.app(storeId, id), { removedFromAsc: true }));
    }
  }

  await chunkedBatch(ops);
  await refs.store(storeId).update({
    appsCount: remote.length,
    appsSyncedAt: Timestamp.now(),
    status: 'ok',
  });
  return { apps: remote.length };
}

export { db };
