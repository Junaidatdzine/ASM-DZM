import { z } from 'zod';
import type { StoreDoc } from '@asm/shared';
import { defineCallable } from '../lib/wrap';
import { refs } from '../lib/firestore';
import { requireAction, requireAdmin } from '../lib/authz';
import { notFound } from '../lib/errors';
import { markStoreAuthError } from '../lib/asc/factory';
import { acquireLease, releaseLease, startOperation } from '../lib/operations';
import { runStoreSync } from '../lib/sync/storeSync';
import { runAppSync } from '../lib/sync/appSync';
import { runFinanceSync } from './finance';

/** Refresh the app list of a store. Only explicitly authorized operators may trigger it. */
export const storesSync = defineCallable(
  'storesSync',
  {
    input: z.object({ storeId: z.string().min(1) }),
    usesAscKey: true,
    timeoutSeconds: 300,
    memory: '512MiB',
    authorize: (actor, input) => requireAction(actor, 'forceSync', input.storeId),
  },
  async (input, actor) => {
    const storeRef = refs.store(input.storeId);
    const snap = await storeRef.get();
    if (!snap.exists) throw notFound('Store');
    const store = snap.data() as StoreDoc;

    if (store.status === 'auth_error') {
      return { skipped: true as const, reason: 'auth_error' };
    }
    if (!(await acquireLease(storeRef, actor.uid))) {
      return { skipped: true as const, reason: 'already_running' };
    }

    const op = await startOperation({
      type: 'store-sync',
      label: `Syncing ${store.name}`,
      startedBy: actor.uid,
      storeId: input.storeId,
    });
    try {
      const { apps } = await runStoreSync(input.storeId, !!store.mock);
      await op.finish('success', `Synced ${store.name} — ${apps} apps`);
      return { skipped: false as const, apps };
    } catch (err) {
      await markStoreAuthError(input.storeId, err);
      await op.fail(err instanceof Error ? err.message : 'Sync failed');
      throw err;
    } finally {
      await releaseLease(storeRef);
    }
  },
);

/** Deep-sync one app (versions, appInfo, all localizations on both branches). */
export const appsSyncOne = defineCallable(
  'appsSyncOne',
  {
    input: z.object({ storeId: z.string().min(1), appId: z.string().min(1) }),
    usesAscKey: true,
    timeoutSeconds: 300,
    memory: '512MiB',
    authorize: (actor, input) => requireAction(actor, 'view', input.storeId, input.appId),
  },
  async (input, actor) => {
    const appRef = refs.app(input.storeId, input.appId);
    const appSnap = await appRef.get();
    if (!appSnap.exists) throw notFound('App');
    const appName = (appSnap.data() as { name?: string }).name ?? 'app';

    if (!(await acquireLease(appRef, actor.uid, 300))) {
      return { skipped: true as const, reason: 'already_running' };
    }

    const op = await startOperation({
      type: 'app-sync',
      label: `Syncing ${appName}`,
      startedBy: actor.uid,
      storeId: input.storeId,
      appId: input.appId,
    });
    try {
      const { locales } = await runAppSync(input.storeId, input.appId);
      await op.finish('success', `Synced ${appName} — ${locales} languages`);
      return { skipped: false as const, locales };
    } catch (err) {
      await markStoreAuthError(input.storeId, err);
      await op.fail(err instanceof Error ? err.message : 'Sync failed');
      throw err;
    } finally {
      await releaseLease(appRef);
    }
  },
);

/**
 * Admin-only HARD sync: refresh the app list, deep-sync EVERY app (versions,
 * localizations, both branches), then finance history when a vendor number is
 * set. Heavy by design — the everyday flows stay lazy/cheap; this is the
 * "make absolutely everything fresh right now" button.
 */
export const storesHardSync = defineCallable(
  'storesHardSync',
  {
    input: z.object({ storeId: z.string().min(1) }),
    usesAscKey: true,
    timeoutSeconds: 540,
    memory: '1GiB',
    authorize: (actor) => requireAdmin(actor),
    audit: (input) => ({ action: 'store.hard-sync', storeId: input.storeId }),
  },
  async (input, actor) => {
    const storeRef = refs.store(input.storeId);
    const snap = await storeRef.get();
    if (!snap.exists) throw notFound('Store');
    const store = snap.data() as StoreDoc;
    if (store.status === 'auth_error') return { skipped: true as const, reason: 'auth_error' };
    if (!(await acquireLease(storeRef, actor.uid))) {
      return { skipped: true as const, reason: 'already_running' };
    }

    const op = await startOperation({
      type: 'store-sync',
      label: `Hard sync — ${store.name}`,
      startedBy: actor.uid,
      storeId: input.storeId,
    });
    try {
      const { apps } = await runStoreSync(input.storeId, !!store.mock);
      const appsSnap = await storeRef.collection('apps').get();
      const ids = appsSnap.docs.filter((d) => !(d.data() as { removedFromAsc?: boolean }).removedFromAsc).map((d) => d.id);
      let synced = 0;
      let failed = 0;
      // Small concurrency: thorough but polite to Apple's rate budget.
      const queue = [...ids];
      await Promise.all(
        Array.from({ length: Math.min(3, queue.length) }, async () => {
          for (let appId = queue.shift(); appId; appId = queue.shift()) {
            try {
              await runAppSync(input.storeId, appId);
              synced += 1;
            } catch {
              failed += 1;
            }
            op.progress(synced + failed, ids.length);
          }
        }),
      );
      let financeDays = 0;
      if (store.mock || store.vendorNumber) {
        financeDays = (await runFinanceSync(input.storeId, store, 90, actor.uid).catch(() => ({ fetched: 0 }))).fetched;
      }
      await op.finish('success', `Hard-synced ${store.name} — ${apps} apps listed, ${synced} deep-synced${failed ? `, ${failed} failed` : ''}`);
      return { skipped: false as const, apps, deepSynced: synced, failed, financeDays };
    } catch (err) {
      await markStoreAuthError(input.storeId, err);
      await op.fail(err instanceof Error ? err.message : 'Hard sync failed');
      throw err;
    } finally {
      await releaseLease(storeRef);
    }
  },
);
