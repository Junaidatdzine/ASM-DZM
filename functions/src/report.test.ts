import { describe, expect, it, vi } from 'vitest';

/**
 * In-memory Firestore stand-in for buildDailyReport. Fixtures are built in
 * vi.hoisted so they exist before the mock factory runs during import.
 *
 * Store US: 30 days @ $10/day proceeds (app Alpha $6, Beta $4), 5 downloads, 6 units.
 * Store DE: 30 days @ $20/day proceeds (app Alpha $20),          5 downloads, 6 units.
 * Ads:      30 days @ $2 spend / 3 installs / $1 AdMob per day.
 *
 * Expected 7-day totals:  proceeds $210, downloads 70, units 84.
 * Expected 30-day totals: proceeds $900, downloads 300, units 360.
 */
const fx = vi.hoisted(() => {
  const financeDay = (
    date: string,
    proceedsUsd: number,
    perApp: Record<string, { proceedsUsd: number; downloads: number; name: string }>,
  ) => ({
    date,
    proceedsUsd,
    downloads: 5,
    units: 6,
    proceeds: {},
    perApp: Object.fromEntries(
      Object.entries(perApp).map(([id, a]) => [id, { ...a, units: 0, proceeds: {} }]),
    ),
    fetchedAt: null,
  });

  const days = (proceedsUsd: number, perApp: (d: string) => Record<string, { proceedsUsd: number; downloads: number; name: string }>) => {
    const arr = [] as { id: string; data: ReturnType<typeof financeDay> }[];
    for (let dom = 30; dom >= 1; dom--) {
      const date = `2026-06-${String(dom).padStart(2, '0')}`;
      arr.push({ id: date, data: financeDay(date, proceedsUsd, perApp(date)) });
    }
    return arr; // already newest-first (dom 30 -> 1)
  };

  const finance: Record<string, { id: string; data: ReturnType<typeof financeDay> }[]> = {
    s1: days(10, () => ({
      a1: { proceedsUsd: 6, downloads: 3, name: 'Alpha' },
      a2: { proceedsUsd: 4, downloads: 2, name: 'Beta' },
    })),
    s2: days(20, () => ({ a1: { proceedsUsd: 20, downloads: 5, name: 'Alpha' } })),
  };

  const apps: Record<string, { id: string; data: { name: string } }[]> = {
    s1: [
      { id: 'a1', data: { name: 'Alpha' } },
      { id: 'a2', data: { name: 'Beta' } },
    ],
    s2: [{ id: 'a1', data: { name: 'Alpha' } }],
  };

  const adsDays = [] as { id: string; data: unknown }[];
  for (let dom = 30; dom >= 1; dom--) {
    const date = `2026-06-${String(dom).padStart(2, '0')}`;
    adsDays.push({
      id: date,
      data: {
        date,
        appleAds: { spend: {}, spendUsd: 2, taps: 0, impressions: 0, installs: 3, campaigns: [] },
        admob: { earnings: {}, earningsUsd: 1 },
        fetchedAt: null,
      },
    });
  }

  const stores = [
    { id: 's1', data: { name: 'US Store' } },
    { id: 's2', data: { name: 'DE Store' } },
  ];

  return { finance, apps, adsDays, stores };
});

// Chainable query stub: orderBy/select are no-ops, limit slices, get() snapshots.
function query(docs: { id: string; data: unknown }[]) {
  const make = (arr: { id: string; data: unknown }[]): any => ({
    orderBy: () => make(arr),
    select: () => make(arr),
    limit: (n: number) => make(arr.slice(0, n)),
    get: async () => ({
      empty: arr.length === 0,
      docs: arr.map((d) => ({ id: d.id, data: () => d.data })),
    }),
  });
  return make(docs);
}

vi.mock('./lib/firestore', () => ({
  Timestamp: { now: () => ({}) },
  db: () => ({
    collection: (name: string) => (name === 'stores' ? query(fx.stores) : query([])),
  }),
  refs: {
    store: (id: string) => ({
      collection: (name: string) =>
        name === 'financeDays' ? query(fx.finance[id] ?? []) : query(fx.apps[id] ?? []),
    }),
    adsDays: () => query(fx.adsDays),
  },
}));

// Imported after the mock is registered.
import { buildDailyReport } from './lib/report';

describe('buildDailyReport — 7 & 30 day windows', () => {
  it('renders 7-day headline figures with 30-day sub-totals and no per-day figures', async () => {
    const report = await buildDailyReport();

    // Headline tiles are the 7-day totals; 30-day is the sub-line.
    expect(report.html).toContain('Proceeds (7 days)');
    expect(report.html).toContain('$210.00'); // 7-day proceeds
    expect(report.html).toContain('$900.00 last 30 days'); // 30-day proceeds sub
    expect(report.html).toContain('Downloads (7 days)');
    expect(report.html).toContain('300 last 30 days'); // 30-day downloads sub
    expect(report.html).toContain('Units (7 days)');

    // Ads + net use the same 7d primary / 30d secondary pattern.
    expect(report.html).toContain('Net (7 days)');
    expect(report.html).toContain('$203.00'); // net 7d = 210 + 7 admob - 14 spend
    expect(report.html).toContain('$870.00 last 30 days'); // net 30d = 900 + 30 - 60
    expect(report.html).toContain('21 installs/7d');

    // Store + app breakdowns carry both windows.
    expect(report.html).toContain('Stores — 7 &amp; 30 days');
    expect(report.html).toContain('DE Store');
    expect(report.html).toContain('Top apps — 7 &amp; 30 days');
    expect(report.html).toContain('Alpha');

    // The old per-day headline must be gone.
    expect(report.html).not.toContain('(day)');
    expect(report.html).not.toContain('Daily report ·');

    expect(report.subject).toBe('Dzinemedia ASM · Report 2026-06-30 — $210.00 last 7d · $900.00 last 30d');
    expect(report.summary).toBe('$210.00 proceeds 7d · $900.00 30d · 70 downloads 7d · 2 stores');
  });
});
