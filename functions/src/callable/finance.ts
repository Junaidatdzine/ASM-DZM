import { z } from 'zod';
import { isDownloadProductType, type AppDoc, type FinanceAppStat, type FinanceDayDoc, type StoreDoc, type SubsDayDoc } from '@asm/shared';
import { defineCallable } from '../lib/wrap';
import { Timestamp, db, refs } from '../lib/firestore';
import { requireAction } from '../lib/authz';
import { AppError, notFound } from '../lib/errors';
import { getAscApi, markStoreAuthError } from '../lib/asc/factory';
import { startOperation } from '../lib/operations';
import { toUsd, usdRates } from '../lib/rates';
import type { SalesRow, SubscriptionEventRow } from '../lib/asc/types';

const financeDayRef = (sid: string, date: string) =>
  refs.store(sid).collection('financeDays').doc(date);
const subsDayRef = (sid: string, date: string) =>
  refs.store(sid).collection('subscriptionDays').doc(date);

function utcDateString(daysAgo: number): string {
  const d = new Date(Date.now() - daysAgo * 24 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

const round2 = (n: number) => Math.round(n * 100) / 100;
// v5: subscription rows with a BLANK Parent Identifier (typical for renewals)
// now attribute via a learned subscription→app map + single-app fallback.
// Bump forces a rewrite of stale day docs on the next sync.
const FINANCE_SCHEMA_VERSION = 5;
const SUBS_SCHEMA_VERSION = 1;

/** A "Subscribe" event with any free-trial offer is a trial start, not a paid one. */
const isFreeTrialOffer = (offerType: string) => /free\s*trial/i.test(offerType);

/**
 * Fold a day's subscription events into trial-start / new-paid / cancellation counts.
 * Trials and paid subs are both "Subscribe" events, split by offer type, so they
 * never double-count.
 */
export function aggregateSubsDay(
  date: string,
  rows: SubscriptionEventRow[],
): Omit<SubsDayDoc, 'fetchedAt'> {
  let trialStarts = 0;
  let newPaid = 0;
  let cancellations = 0;
  for (const row of rows) {
    const event = row.event.toLowerCase();
    if (event === 'subscribe') {
      if (isFreeTrialOffer(row.offerType)) trialStarts += row.quantity;
      else newPaid += row.quantity;
    } else if (event === 'cancel') {
      cancellations += row.quantity;
    }
  }
  return { schemaVersion: SUBS_SCHEMA_VERSION, date, trialStarts, newPaid, cancellations };
}

function normalized(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** IAP / subscription product-type prefixes (iOS IA*, Mac FI*). */
const IAP_TYPE = /^(IA|FI)/;

export function resolveApp(
  row: SalesRow,
  apps: Array<{ id: string; data: AppDoc }>,
  subMap?: Record<string, string>,
): { id: string; name: string } | null {
  // 1. App rows: the row's Apple Identifier IS the app id.
  const exact = apps.find((app) => app.id === row.appleId);
  if (exact) return { id: exact.id, name: exact.data.name };
  // 2. IAP/subscription rows: "Parent Identifier" carries the parent app's SKU.
  //    This is where all proceeds live — verified against real report data.
  const parent = (row.parentIdentifier ?? '').trim().toLowerCase();
  if (parent) {
    const bySku = apps.find((app) => (app.data.sku ?? '').trim().toLowerCase() === parent);
    if (bySku) return { id: bySku.id, name: bySku.data.name };
  }
  // 3. Renewal rows ship with a BLANK Parent Identifier — use the mapping this
  //    subscription taught us on days where the parent WAS present.
  const learned = subMap?.[row.appleId];
  if (learned) {
    const byId = apps.find((app) => app.id === learned);
    if (byId) return { id: byId.id, name: byId.data.name };
  }
  // 4. A purchase in a single-app account can only belong to that app.
  if (apps.length === 1 && IAP_TYPE.test(row.productType)) {
    return { id: apps[0]!.id, name: apps[0]!.data.name };
  }
  // 5. Last resort: fuzzy title containment (helps renamed/removed apps).
  const title = normalized(row.title);
  const matches = apps
    .filter((app) => {
      const name = normalized(app.data.name);
      return name.length >= 5 && (title.includes(name) || name.includes(title));
    })
    .sort((a, b) => b.data.name.length - a.data.name.length);
  return matches[0] ? { id: matches[0].id, name: matches[0].data.name } : null;
}

/** Learn subscription→app links from rows that DO carry a Parent Identifier. */
export function learnSubscriptionMap(
  rows: SalesRow[],
  apps: Array<{ id: string; data: AppDoc }>,
  base: Record<string, string> = {},
): Record<string, string> {
  const map = { ...base };
  for (const row of rows) {
    if (!IAP_TYPE.test(row.productType)) continue;
    const parent = (row.parentIdentifier ?? '').trim().toLowerCase();
    if (!parent) continue;
    const app = apps.find((a) => (a.data.sku ?? '').trim().toLowerCase() === parent);
    if (app) map[row.appleId] = app.id;
  }
  return map;
}

/** Aggregate one day's rows into the cached doc shape (proceeds only, never prices). */
export function aggregateDay(
  date: string,
  rows: SalesRow[],
  apps: Array<{ id: string; data: AppDoc }>,
  subMap?: Record<string, string>,
): Omit<FinanceDayDoc, 'fetchedAt'> {
  let units = 0;
  let downloads = 0;
  const proceeds: Record<string, number> = {};
  const perApp: Record<string, FinanceAppStat> = {};

  for (const row of rows) {
    const isDownload = isDownloadProductType(row.productType);
    const rowProceeds = row.units * row.proceedsPerUnit;
    units += row.units;
    if (isDownload) downloads += row.units;
    if (rowProceeds !== 0) {
      proceeds[row.currency] = round2((proceeds[row.currency] ?? 0) + rowProceeds);
    }
    const resolved = resolveApp(row, apps, subMap);
    const appKey = (resolved?.id ?? row.appleId) || row.sku || 'unknown';
    const app = (perApp[appKey] ??= {
      units: 0,
      downloads: 0,
      proceeds: {},
      name: resolved?.name || row.title || appKey,
    });
    app.units += row.units;
    if (isDownload) app.downloads += row.units;
    if (rowProceeds !== 0) {
      app.proceeds[row.currency] = round2((app.proceeds[row.currency] ?? 0) + rowProceeds);
    }
  }
  return { schemaVersion: FINANCE_SCHEMA_VERSION, date, units, downloads, proceeds, perApp };
}

/**
 * Which report days a sync must fetch: the requested window's missing/stale days,
 * the 2 most recent (Apple back-fills late rows), PLUS every cached day whose doc
 * is on an old schema — so a schema bump (e.g. the IAP→parent-app attribution fix)
 * heals the whole history on the very next sync, even a quick dashboard refresh.
 */
export function planFinanceTargets(
  wanted: string[],
  existing: Set<string>,
  currentSchema: Set<string>,
): string[] {
  const staleCached = [...existing].filter((date) => !currentSchema.has(date));
  return [
    ...new Set([
      ...wanted.filter((date, i) => i < 2 || !existing.has(date) || !currentSchema.has(date)),
      ...staleCached,
    ]),
  ].sort((a, b) => b.localeCompare(a));
}

/** Shared finance refresh used by both the per-store page and admin analytics. */
export async function runFinanceSync(
  storeId: string,
  store: StoreDoc,
  dayCount: number,
  actorUid: string,
): Promise<{ fetched: number }> {
  if (!store.mock && !store.vendorNumber) {
    throw new AppError(
      'failed-precondition',
      'Add the store’s vendor number first (Stores → menu → Settings). You find it in App Store Connect → Payments and Financial Reports.',
    );
  }
  const vendor = store.vendorNumber ?? 'mock';

  // Sales reports exist up to "yesterday". Figure out which days we're missing.
  const wanted: string[] = [];
  for (let ago = 1; ago <= dayCount; ago++) wanted.push(utcDateString(ago));
  const existing = new Set<string>();
  const currentSchema = new Set<string>();
  const existingSnap = await refs.store(storeId).collection('financeDays').get();
  for (const d of existingSnap.docs) {
    existing.add(d.id);
    if ((d.data() as FinanceDayDoc).schemaVersion === FINANCE_SCHEMA_VERSION) currentSchema.add(d.id);
  }
  const targets = planFinanceTargets(wanted, existing, currentSchema);
  if (targets.length === 0) {
    await refs.store(storeId).update({ financeSyncedAt: Timestamp.now() });
    return { fetched: 0 };
  }

  const api = await getAscApi(storeId);
  const appSnap = await refs.store(storeId).collection('apps').get();
  const apps = appSnap.docs.map((doc) => ({ id: doc.id, data: doc.data() as AppDoc }));
  const op = await startOperation({
    type: 'store-sync',
    label: `Fetching finance for ${store.name} (${targets.length} days)`,
    startedBy: actorUid,
    storeId,
  });

  try {
    let done = 0;
    let fetched = 0;
    // Pass 1 learns subscription→app links from every day in this run (renewal
    // rows have no Parent Identifier — purchase rows on other days teach us).
    const fetchedRows = new Map<string, SalesRow[]>();
    for (const date of targets) {
      op.progress(done, targets.length);
      done += 1;
      const rows = await api.fetchDailySales(vendor, date);
      if (rows !== null) fetchedRows.set(date, rows);
    }
    const subMap = learnSubscriptionMap(
      [...fetchedRows.values()].flat(),
      apps,
      (store as StoreDoc & { financeSubMap?: Record<string, string> }).financeSubMap ?? {},
    );
    if (Object.keys(subMap).length > 0) {
      await refs.store(storeId).update({ financeSubMap: subMap }).catch(() => {});
    }
    for (const [date, rows] of fetchedRows) {
      const aggregate = aggregateDay(date, rows, apps, subMap);
      const currencies = [...new Set([
        ...Object.keys(aggregate.proceeds),
        ...Object.values(aggregate.perApp).flatMap((app) => Object.keys(app.proceeds)),
      ])];
      const rates = await usdRates(currencies);
      aggregate.proceedsUsd = toUsd(aggregate.proceeds, rates);
      for (const app of Object.values(aggregate.perApp)) app.proceedsUsd = toUsd(app.proceeds, rates);
      await financeDayRef(storeId, date).set({
        ...aggregate,
        fetchedAt: Timestamp.now(),
      });
      fetched += 1;
    }
    // Best-effort subscription events (trials/activations). A store with no
    // subscriptions returns null and simply gets no docs — never fails the sync.
    for (const date of targets) {
      try {
        const subRows = await api.fetchDailySubscriptionEvents(vendor, date);
        if (subRows === null) continue;
        await subsDayRef(storeId, date).set({
          ...aggregateSubsDay(date, subRows),
          fetchedAt: Timestamp.now(),
        });
      } catch (err) {
        console.warn('subscription-event sync failed', storeId, date, err instanceof Error ? err.message : err);
      }
    }
    await refs.store(storeId).update({ financeSyncedAt: Timestamp.now() });
    await op.finish('success', `Finance up to date — ${store.name}`);
    return { fetched };
  } catch (err) {
    await markStoreAuthError(storeId, err);
    await op.fail(err instanceof Error ? err.message : 'Finance sync failed');
    throw err;
  }
}

/**
 * Pull daily sales reports into the finance cache. Fetches only missing days
 * (always re-fetching the 2 most recent — Apple back-fills late rows), so repeat
 * opens cost zero ASC requests. Admin-only, like everything financial.
 */
export const financeSync = defineCallable(
  'financeSync',
  {
    input: z.object({
      storeId: z.string().min(1),
      days: z.number().int().min(1).max(90).default(35),
    }),
    usesAscKey: true,
    timeoutSeconds: 300,
    memory: '512MiB',
    // Admins always pass; members need the explicit viewFinance grant (no role default).
    authorize: (actor, input) => requireAction(actor, 'viewFinance', input.storeId),
    audit: (input, out: { fetched: number }) => ({
      action: 'finance.sync',
      storeId: input.storeId,
      detail: `${out.fetched} days`,
    }),
  },
  async (input, actor) => {
    const storeSnap = await refs.store(input.storeId).get();
    if (!storeSnap.exists) throw notFound('Store');
    const store = storeSnap.data() as StoreDoc;
    return runFinanceSync(input.storeId, store, input.days ?? 35, actor.uid);
  },
);
