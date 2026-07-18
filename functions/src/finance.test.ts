import { describe, expect, it } from 'vitest';
import type { AppDoc } from '../../shared/src/index';
import { parseSalesTsv } from './lib/asc/client';
import { aggregateDay, learnSubscriptionMap, perCountryUsd, planFinanceTargets, resolveApp } from './callable/finance';

const apps = [
  { id: '6754688919', data: { name: 'AI Detector, Humanize AI Text', sku: 'aidetector' } as AppDoc },
  { id: '6754454093', data: { name: 'PetFun AI - Pet Talk & Camera', sku: 'petfun' } as AppDoc },
];

/** Mirrors Apple's daily sales summary: IAP rows have their own Apple ID and a Parent Identifier = app SKU. */
const TSV = [
  'Provider\tProvider Country\tSKU\tDeveloper\tTitle\tVersion\tProduct Type Identifier\tUnits\tDeveloper Proceeds\tBegin Date\tEnd Date\tCustomer Currency\tCountry Code\tCurrency of Proceeds\tApple Identifier\tCustomer Price\tPromo Code\tParent Identifier\tSubscription\tPeriod',
  'APPLE\tUS\taidetector\tRvira\tAI Detector, Humanize AI Text\t1.0.3\t1\t42\t0\t07/16/2026\t07/16/2026\tUSD\tUS\tUSD\t6754688919\t0\t\t\t\t',
  'APPLE\tUS\taidetector.weekly\tRvira\tWeekly Premium\t\tIA9\t3\t2.8\t07/16/2026\t07/16/2026\tUSD\tUS\tUSD\t6754867080\t3.99\t\taidetector\t\t',
  'APPLE\tUS\taidetector.weekly\tRvira\tWeekly Premium\t\tIA9\t2\t2.52\t07/16/2026\t07/16/2026\tEUR\tDE\tEUR\t6754867080\t3.99\t\taidetector\t\t',
  'APPLE\tUS\tunrelated.iap\tOther\tMystery Pack\t\tIA1\t1\t0.7\t07/16/2026\t07/16/2026\tUSD\tUS\tUSD\t6799999999\t0.99\t\tno-such-sku\t\t',
].join('\n');

describe('parseSalesTsv with Parent Identifier', () => {
  it('extracts parentIdentifier for IAP rows and omits it for app rows', () => {
    const rows = parseSalesTsv(TSV);
    expect(rows).toHaveLength(4);
    expect(rows[0]!.parentIdentifier).toBeUndefined();
    expect(rows[1]!.parentIdentifier).toBe('aidetector');
    expect(rows[1]!.appleId).toBe('6754867080');
  });
});

describe('resolveApp', () => {
  it('matches app rows by Apple ID', () => {
    const rows = parseSalesTsv(TSV);
    expect(resolveApp(rows[0]!, apps)?.id).toBe('6754688919');
  });

  it('attributes IAP rows to the parent app via SKU (case-insensitive)', () => {
    const rows = parseSalesTsv(TSV);
    expect(resolveApp(rows[1]!, apps)?.id).toBe('6754688919');
    expect(resolveApp({ ...rows[1]!, parentIdentifier: 'AIDETECTOR' }, apps)?.id).toBe('6754688919');
  });

  it('leaves rows with unknown parents unresolved', () => {
    const rows = parseSalesTsv(TSV);
    expect(resolveApp(rows[3]!, apps)).toBeNull();
  });
});

describe('country attribution', () => {
  it('parses the Country Code column (uppercased)', () => {
    const rows = parseSalesTsv(TSV);
    expect(rows[0]!.country).toBe('US');
    expect(rows[2]!.country).toBe('DE');
  });

  it('perCountryUsd sums proceeds per country and converts to USD', () => {
    const rows = parseSalesTsv(TSV);
    // rates are "currency per USD": US = 3×$2.80 + 1×$0.70 = $9.10; DE = €5.04 / 1.1.
    const perCountry = perCountryUsd(rows, { USD: 1, EUR: 1.1 });
    expect(perCountry.US).toBeCloseTo(9.1, 2);
    expect(perCountry.DE).toBeCloseTo(5.04 / 1.1, 2);
  });
});

describe('planFinanceTargets (schema self-heal)', () => {
  it('rebuilds stale-schema cached days even when they are outside the requested window', () => {
    const wanted = ['2026-07-17', '2026-07-16']; // a quick 2-day dashboard sync
    const existing = new Set(['2026-07-17', '2026-07-16', '2026-05-01', '2026-03-01']);
    const currentSchema = new Set(['2026-07-17', '2026-07-16', '2026-05-01']); // 03-01 is old
    const targets = planFinanceTargets(wanted, existing, currentSchema);
    expect(targets).toContain('2026-03-01'); // ← the heal: out-of-window but stale
    expect(targets).toContain('2026-07-17'); // most-recent always refetched
    expect(targets).not.toContain('2026-05-01'); // current schema, outside always-refetch → skipped
  });

  it('with everything current only the 2 newest + missing days are fetched', () => {
    const wanted = ['2026-07-17', '2026-07-16', '2026-07-15', '2026-07-14'];
    const existing = new Set(['2026-07-17', '2026-07-16', '2026-07-15']); // 07-14 missing
    const currentSchema = new Set(existing);
    expect(planFinanceTargets(wanted, existing, currentSchema)).toEqual([
      '2026-07-17',
      '2026-07-16',
      '2026-07-14',
    ]);
  });

  it('a full-history schema bump targets every cached day exactly once, newest first', () => {
    const wanted = ['2026-07-17', '2026-07-16'];
    const existing = new Set(['2026-07-17', '2026-07-16', '2026-07-15']);
    const targets = planFinanceTargets(wanted, existing, new Set());
    expect(targets).toEqual(['2026-07-17', '2026-07-16', '2026-07-15']);
  });
});

describe('aggregateDay attribution', () => {
  it('rolls IAP proceeds into the parent app, not the IAP Apple ID', () => {
    const rows = parseSalesTsv(TSV);
    const day = aggregateDay('2026-07-16', rows, apps);

    // The regression this guards: proceeds must land on the APP id.
    const appStat = day.perApp['6754688919']!;
    expect(appStat).toBeDefined();
    expect(appStat.proceeds['USD']).toBeCloseTo(3 * 2.8, 2);
    expect(appStat.proceeds['EUR']).toBeCloseTo(2 * 2.52, 2);
    expect(appStat.downloads).toBe(42);
    expect(day.perApp['6754867080']).toBeUndefined(); // no orphan IAP bucket

    // Day totals unchanged by attribution.
    expect(day.proceeds['USD']).toBeCloseTo(3 * 2.8 + 0.7, 2);
    expect(day.downloads).toBe(42);
    expect(day.units).toBe(48);

    // Unknown-parent proceeds stay visible under their own key rather than vanishing.
    expect(day.perApp['6799999999']!.proceeds['USD']).toBeCloseTo(0.7, 2);
  });
});

describe('v5 subscription attribution (blank Parent Identifier)', () => {
  const apps: Array<{ id: string; data: AppDoc }> = [
    { id: 'app1', data: { name: 'AI Flashcards & Quizzes Maker', sku: 'flashcards' } as AppDoc },
  ];
  const renewal = {
    appleId: '6755324148',
    sku: 'FL.yearly',
    title: 'yearly',
    productType: 'IAY',
    units: 3,
    proceedsPerUnit: 24.5,
    currency: 'USD',
    country: 'US',
    // no parentIdentifier — exactly how Apple ships renewal rows
  };

  it('learns the parent from purchase rows and applies it to renewals', () => {
    const purchase = { ...renewal, productType: 'IA1', parentIdentifier: 'flashcards' };
    const map = learnSubscriptionMap([purchase], apps);
    expect(map['6755324148']).toBe('app1');
    expect(resolveApp(renewal, apps, map)?.id).toBe('app1');
  });

  it('falls back to the only app for IAP rows in single-app accounts', () => {
    expect(resolveApp(renewal, apps)?.id).toBe('app1');
    // Mac IAP product types resolve the same way
    expect(resolveApp({ ...renewal, productType: 'FI1' }, apps)?.id).toBe('app1');
    // but a NON-IAP unknown row must not be force-attributed
    expect(resolveApp({ ...renewal, productType: '1', appleId: '999', title: 'zzz' }, apps)).toBeNull();
  });

  it('multi-app accounts without any hint stay unresolved (never guess)', () => {
    const two = [...apps, { id: 'app2', data: { name: 'Other App Name Here', sku: 'other' } as AppDoc }];
    expect(resolveApp(renewal, two)).toBeNull();
  });

  it('aggregateDay books learned renewals under the parent app', () => {
    const map = { '6755324148': 'app1' };
    const day = aggregateDay('2026-07-17', [renewal], apps, map);
    expect(Object.keys(day.perApp)).toEqual(['app1']);
    expect(day.perApp['app1']!.proceeds.USD).toBeCloseTo(73.5);
  });
});
