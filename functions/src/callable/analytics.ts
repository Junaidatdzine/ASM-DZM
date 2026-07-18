import { z } from 'zod';
import type { AppDoc, FinanceDayDoc, StoreDoc } from '@asm/shared';
import { defineCallable } from '../lib/wrap';
import { db, refs } from '../lib/firestore';
import { requireAdmin } from '../lib/authz';
import { runFinanceSync } from './finance';

const round2 = (n: number) => Math.round(n * 100) / 100;

function addInto(target: Record<string, number>, src: Record<string, number>) {
  for (const [key, value] of Object.entries(src)) target[key] = round2((target[key] ?? 0) + value);
}

function normalized(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

interface StoreRoll {
  storeId: string;
  name: string;
  color?: string;
  icon?: string;
  proceeds: Record<string, number>;
  downloads: number;
  units: number;
  hasFinance: boolean;
  /** Finance sync is possible (mock store or vendor number configured). */
  canSync: boolean;
  /** Last finance sync attempt (ms) — even a 0-report attempt counts, so clients don't loop. */
  financeSyncedAt: number | null;
  /** The report day this store's "latest" numbers come from (dates vary per store). */
  latestReportDate: string | null;
}

interface AppEntry {
  id: string;
  data: AppDoc;
}

interface AppRoll {
  storeId: string;
  appId: string;
  name: string;
  iconUrl: string | null;
  platforms: string[];
  devices: string[] | null;
  proceeds: Record<string, number>;
  downloads: number;
  units: number;
}

let usdRateCache: { at: number; date: string; rates: Record<string, number> } | null = null;

async function usdRates(currencies: string[]): Promise<{ date: string; rates: Record<string, number> }> {
  const wanted = [...new Set(currencies.filter((currency) => currency !== 'USD'))];
  if (wanted.length === 0) return { date: new Date().toISOString().slice(0, 10), rates: { USD: 1 } };
  if (usdRateCache && Date.now() - usdRateCache.at < 6 * 3600_000 && wanted.every((currency) => usdRateCache!.rates[currency])) {
    return { date: usdRateCache.date, rates: usdRateCache.rates };
  }
  try {
    const response = await fetch(
      `https://api.frankfurter.dev/v1/latest?base=USD&symbols=${encodeURIComponent(wanted.join(','))}`,
      { signal: AbortSignal.timeout(8_000) },
    );
    if (!response.ok) throw new Error(`rates ${response.status}`);
    const body = (await response.json()) as { date?: string; rates?: Record<string, number> };
    const rates = { USD: 1, ...(body.rates ?? {}) };
    usdRateCache = { at: Date.now(), date: body.date ?? new Date().toISOString().slice(0, 10), rates };
    return { date: usdRateCache.date, rates };
  } catch {
    // Preserve a warm value across a brief provider outage. Unknown currencies are
    // excluded rather than being mislabeled as USD.
    return usdRateCache
      ? { date: usdRateCache.date, rates: usdRateCache.rates }
      : { date: new Date().toISOString().slice(0, 10), rates: { USD: 1 } };
  }
}

function toUsd(values: Record<string, number>, rates: Record<string, number>): number {
  return round2(
    Object.entries(values).reduce((total, [currency, amount]) => {
      if (currency === 'USD') return total + amount;
      const perDollar = rates[currency];
      return perDollar && perDollar > 0 ? total + amount / perDollar : total;
    }, 0),
  );
}

function resolveApp(
  appId: string,
  nameHint: string | undefined,
  catalog: AppEntry[],
): AppEntry | null {
  const direct = catalog.find((app) => app.id === appId);
  if (direct) return direct;
  const hint = normalized(nameHint ?? '');
  if (!hint) return null;
  return catalog
    .filter((app) => {
      const name = normalized(app.data.name);
      return name.length >= 5 && (hint.includes(name) || name.includes(hint));
    })
    .sort((a, b) => b.data.name.length - a.data.name.length)[0] ?? null;
}

/** Admin-only business rollup with an optional store scope and normalized USD values. */
export const analyticsOverview = defineCallable(
  'analyticsOverview',
  {
    input: z.object({
      days: z.number().int().min(1).max(90).default(30),
      sync: z.boolean().default(false),
      /** When set, sync only these stores (first-time backfills) instead of every store in scope. */
      syncStoreIds: z.array(z.string().min(1)).max(200).nullish(),
      // Firebase callable serialization can turn an explicit `undefined` property
      // into null. Treat both omitted and null as the all-stores scope.
      storeId: z.string().min(1).nullish(),
    }),
    usesAscKey: true,
    timeoutSeconds: 540,
    memory: '512MiB',
    authorize: (actor) => requireAdmin(actor),
  },
  async (input, actor) => {
    const days = input.days ?? 30;
    const storesSnap = await db().collection('stores').get();
    const allStores = storesSnap.docs.map((doc) => ({ id: doc.id, data: doc.data() as StoreDoc }));
    const selectedStoreId = input.storeId ?? null;
    const stores = selectedStoreId ? allStores.filter((store) => store.id === selectedStoreId) : allStores;
    const availableStores = allStores.map((store) => ({
      storeId: store.id,
      name: store.data.name,
      color: store.data.color,
      icon: store.data.icon,
    }));

    if (input.sync ?? false) {
      // Cost control: a targeted sync (new stores) never re-syncs the whole fleet.
      const only = new Set(input.syncStoreIds ?? []);
      for (const store of stores) {
        if (only.size > 0 && !only.has(store.id)) continue;
        if (store.data.mock || store.data.vendorNumber) {
          await runFinanceSync(store.id, store.data, Math.max(days + 2, 35), actor.uid).catch(() => {});
        }
      }
    }

    const catalogs = new Map<string, AppEntry[]>();
    await Promise.all(stores.map(async (store) => {
      const snap = await refs.store(store.id).collection('apps').get();
      catalogs.set(store.id, snap.docs.map((doc) => ({ id: doc.id, data: doc.data() as AppDoc })));
    }));

    const now = new Date();
    const iso = (date: Date) => date.toISOString().slice(0, 10);
    const cutCurrent = iso(new Date(now.getTime() - days * 86400_000));
    const cutPrev = iso(new Date(now.getTime() - 2 * days * 86400_000));
    const perStore: StoreRoll[] = [];
    const perApp = new Map<string, AppRoll>();
    const seriesMap = new Map<string, { proceeds: Record<string, number>; downloads: number }>();
    const totals = { proceeds: {} as Record<string, number>, downloads: 0, units: 0 };
    const prev = { proceeds: {} as Record<string, number>, downloads: 0, units: 0 };

    for (const store of stores) {
      const daysSnap = await refs.store(store.id).collection('financeDays').get();
      const catalog = catalogs.get(store.id) ?? [];
      // "Latest report" = this store's newest available report day (Apple publishes
      // a day's report the NEXT day, so a fixed calendar window always misses it).
      const storeDates = daysSnap.docs.map((d) => (d.data() as FinanceDayDoc).date ?? d.id).sort();
      const latestDate = storeDates[storeDates.length - 1] ?? null;
      const prevLatestDate = storeDates[storeDates.length - 2] ?? null;
      const roll: StoreRoll = {
        storeId: store.id,
        name: store.data.name,
        color: store.data.color,
        icon: store.data.icon,
        proceeds: {},
        downloads: 0,
        units: 0,
        hasFinance: daysSnap.size > 0,
        canSync: !!(store.data.mock || store.data.vendorNumber),
        financeSyncedAt: store.data.financeSyncedAt?.toMillis() ?? null,
        latestReportDate: latestDate,
      };
      for (const dayDoc of daysSnap.docs) {
        const day = dayDoc.data() as FinanceDayDoc;
        const date = day.date ?? dayDoc.id;
        const inCurrent = days === 1 ? date === latestDate : date > cutCurrent;
        const inPrev = days === 1 ? date === prevLatestDate : date > cutPrev && date <= cutCurrent;
        if (!inCurrent && !inPrev) continue;
        if (inCurrent) {
          addInto(totals.proceeds, day.proceeds ?? {});
          totals.downloads += day.downloads ?? 0;
          totals.units += day.units ?? 0;
          addInto(roll.proceeds, day.proceeds ?? {});
          roll.downloads += day.downloads ?? 0;
          roll.units += day.units ?? 0;
          const series = seriesMap.get(date) ?? { proceeds: {}, downloads: 0 };
          addInto(series.proceeds, day.proceeds ?? {});
          series.downloads += day.downloads ?? 0;
          seriesMap.set(date, series);

          for (const [rawAppId, stat] of Object.entries(day.perApp ?? {})) {
            const app = resolveApp(rawAppId, stat.name, catalog);
            if (!app) continue; // Never present an IAP/product id as an app.
            const key = `${store.id}::${app.id}`;
            const appRoll = perApp.get(key) ?? {
              storeId: store.id,
              appId: app.id,
              name: app.data.name,
              iconUrl: app.data.iconUrl ?? null,
              platforms: app.data.platforms ?? [],
              devices: app.data.devices ?? null,
              proceeds: {},
              downloads: 0,
              units: 0,
            };
            addInto(appRoll.proceeds, stat.proceeds ?? {});
            appRoll.downloads += stat.downloads ?? 0;
            appRoll.units += stat.units ?? 0;
            perApp.set(key, appRoll);
          }
        } else {
          addInto(prev.proceeds, day.proceeds ?? {});
          prev.downloads += day.downloads ?? 0;
          prev.units += day.units ?? 0;
        }
      }
      perStore.push(roll);
    }

    const currencies = [...new Set([
      ...Object.keys(totals.proceeds),
      ...Object.keys(prev.proceeds),
      ...perStore.flatMap((store) => Object.keys(store.proceeds)),
      ...[...perApp.values()].flatMap((app) => Object.keys(app.proceeds)),
    ])];
    const exchange = await usdRates(currencies);
    const usd = (values: Record<string, number>) => toUsd(values, exchange.rates);
    const currentUsd = usd(totals.proceeds);
    const previousUsd = usd(prev.proceeds);
    const topApps = [...perApp.values()]
      .map((app) => ({ ...app, proceeds: usd(app.proceeds) }))
      .sort((a, b) => b.proceeds - a.proceeds || b.downloads - a.downloads)
      .slice(0, 12)
      .map(({ units: _units, ...app }) => app);
    const series = [...seriesMap.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, value]) => ({ date, proceeds: usd(value.proceeds), downloads: value.downloads }));
    const appsTotal = [...catalogs.values()].reduce((total, catalog) => total + catalog.length, 0);

    return {
      days,
      selectedStoreId,
      availableStores,
      primaryCurrency: 'USD' as const,
      exchangeRateDate: exchange.date,
      totals: {
        proceeds: { USD: currentUsd },
        proceedsPrimary: currentUsd,
        downloads: totals.downloads,
        units: totals.units,
      },
      growth: {
        proceeds: pctGrowth(currentUsd, previousUsd),
        downloads: pctGrowth(totals.downloads, prev.downloads),
        hasPrev: prev.downloads > 0 || previousUsd > 0,
      },
      series,
      perStore: perStore
        .map((store) => ({
          storeId: store.storeId,
          name: store.name,
          color: store.color,
          icon: store.icon,
          proceeds: { USD: usd(store.proceeds) },
          proceedsPrimary: usd(store.proceeds),
          downloads: store.downloads,
          units: store.units,
          hasFinance: store.hasFinance,
          canSync: store.canSync,
          financeSyncedAt: store.financeSyncedAt,
          latestReportDate: store.latestReportDate,
        }))
        .sort((a, b) => b.proceedsPrimary - a.proceedsPrimary || b.downloads - a.downloads),
      topApps,
      storesTotal: stores.length,
      storesWithFinance: perStore.filter((store) => store.hasFinance).length,
      appsTotal,
    };
  },
);

function pctGrowth(current: number, previous: number): number | null {
  if (previous <= 0) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}
