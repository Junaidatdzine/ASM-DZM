import { describe, expect, it, vi } from 'vitest';

/**
 * In-memory Firestore stand-in for buildDailyReport. Fixtures are built in
 * vi.hoisted so they exist before the mock factory runs during import.
 *
 * Store US: 30 days @ $10/day earnings (apps 6754688919 $6, 6480001111 $4), 5 downloads.
 * Store DE: 30 days @ $20/day earnings (app 6754688919 $20),                 5 downloads.
 * Subscriptions US: 2 trial / 1 paid / 1 cancel per day. DE: 3 trial / 2 paid / 0 cancel.
 *
 * Expected 7-day earnings $210, 30-day $900. 7-day downloads 70, 30-day 300.
 * Expected 7-day subs: 35 trials, 21 paid, 7 cancels. 30-day: 150 / 90 / 30.
 */
const fx = vi.hoisted(() => {
  const financeDay = (
    date: string,
    proceedsUsd: number,
    perApp: Record<string, { proceedsUsd: number; downloads: number; name: string }>,
    perCountry: Record<string, number>,
  ) => ({
    date, proceedsUsd, downloads: 5, units: 6, proceeds: {}, perCountry,
    perApp: Object.fromEntries(Object.entries(perApp).map(([id, a]) => [id, { ...a, units: 0, proceeds: {} }])),
    fetchedAt: null,
  });
  const finDays = (
    proceedsUsd: number,
    perApp: Record<string, { proceedsUsd: number; downloads: number; name: string }>,
    perCountry: Record<string, number>,
  ) => {
    const arr: { id: string; data: ReturnType<typeof financeDay> }[] = [];
    for (let dom = 30; dom >= 1; dom--) {
      const date = `2026-06-${String(dom).padStart(2, '0')}`;
      arr.push({ id: date, data: financeDay(date, proceedsUsd, perApp, perCountry) });
    }
    return arr; // newest-first
  };
  const subDays = (trialStarts: number, newPaid: number, cancellations: number) => {
    const arr: { id: string; data: { date: string; trialStarts: number; newPaid: number; cancellations: number; fetchedAt: null } }[] = [];
    for (let dom = 30; dom >= 1; dom--) {
      const date = `2026-06-${String(dom).padStart(2, '0')}`;
      arr.push({ id: date, data: { date, trialStarts, newPaid, cancellations, fetchedAt: null } });
    }
    return arr;
  };

  const finance: Record<string, ReturnType<typeof finDays>> = {
    s1: finDays(10, {
      '6754688919': { proceedsUsd: 6, downloads: 3, name: 'AI Detector' },
      '6480001111': { proceedsUsd: 4, downloads: 2, name: 'PetFun AI' },
    }, { US: 7, DE: 3 }),
    s2: finDays(20, { '6754688919': { proceedsUsd: 20, downloads: 5, name: 'AI Detector' } }, { US: 15, GB: 5 }),
  };
  const subs: Record<string, ReturnType<typeof subDays>> = {
    s1: subDays(2, 1, 1),
    s2: subDays(3, 2, 0),
  };
  const apps: Record<string, { id: string; data: { name: string } }[]> = {
    s1: [{ id: '6754688919', data: { name: 'AI Detector' } }, { id: '6480001111', data: { name: 'PetFun AI' } }],
    s2: [{ id: '6754688919', data: { name: 'AI Detector' } }],
  };
  const adsDays: { id: string; data: unknown }[] = [];
  for (let dom = 30; dom >= 1; dom--) {
    const date = `2026-06-${String(dom).padStart(2, '0')}`;
    adsDays.push({ id: date, data: { date, appleAds: { spend: {}, spendUsd: 2, taps: 0, impressions: 0, installs: 3, campaigns: [] }, admob: { earnings: {}, earningsUsd: 1 }, fetchedAt: null } });
  }
  const stores = [
    { id: 's1', data: { name: 'US Store', color: 'indigo' } },
    { id: 's2', data: { name: 'DE Store', color: 'emerald' } },
  ];
  return { finance, subs, apps, adsDays, stores };
});

function query(docs: { id: string; data: unknown }[]) {
  const make = (arr: { id: string; data: unknown }[]): any => ({
    orderBy: () => make(arr),
    select: () => make(arr),
    limit: (n: number) => make(arr.slice(0, n)),
    get: async () => ({ empty: arr.length === 0, docs: arr.map((d) => ({ id: d.id, data: () => d.data })) }),
  });
  return make(docs);
}

vi.mock('./lib/firestore', () => ({
  Timestamp: { now: () => ({}) },
  db: () => ({ collection: (name: string) => (name === 'stores' ? query(fx.stores) : query([])) }),
  refs: {
    store: (id: string) => ({
      collection: (name: string) => {
        if (name === 'financeDays') return query(fx.finance[id] ?? []);
        if (name === 'subscriptionDays') return query(fx.subs[id] ?? []);
        return query(fx.apps[id] ?? []);
      },
    }),
    adsDays: () => query(fx.adsDays),
  },
}));

import { buildDailyReport } from './lib/report';

describe('buildDailyReport — simple, mobile-friendly report', () => {
  it('leads with a plain-English headline and explicit date ranges', async () => {
    const r = await buildDailyReport();
    expect(r.html).toContain('In the last 7 days (Jun 24 – 30), 2 stores earned <strong>$210.00</strong>');
    expect(r.html).toContain('7-day window Jun 24 – 30 · 30-day window Jun 1 – 30');
  });

  it('puts a Subscriptions section (trials/activations) before Sales, and drops Units', async () => {
    const r = await buildDailyReport();
    const subsAt = r.html.indexOf('>Subscriptions<');
    const salesAt = r.html.indexOf('>Sales<');
    expect(subsAt).toBeGreaterThan(-1);
    expect(salesAt).toBeGreaterThan(subsAt); // subscriptions rendered first

    expect(r.html).toContain('Free trials · 7 days');
    expect(r.html).toContain('New subscriptions · 7 days');
    expect(r.html).toContain('Cancellations · 7 days');
    expect(r.html).toContain('New this week: <strong>35</strong> free trials and <strong>21</strong> new paid subscriptions.');
    expect(r.html).toContain('150 over 30 days'); // 30-day trials

    // Units removed entirely.
    expect(r.html).not.toContain('Units');
    expect(r.html).not.toContain('(day)');
  });

  it('uses simple wording (Earnings, not Units/Proceeds jargon) with 30-day + daily average', async () => {
    const r = await buildDailyReport();
    expect(r.html).toContain('Earnings · 7 days');
    expect(r.html).toContain('$900.00 over 30 days · $30.00/day');
    expect(r.html).toContain('Downloads · 7 days');
  });

  it('links each app to its App Store page', async () => {
    const r = await buildDailyReport();
    expect(r.html).toContain('href="https://apps.apple.com/app/id6754688919"');
    expect(r.html).toContain('View ↗');
  });

  it('is a responsive HTML document with a stacking media query', async () => {
    const r = await buildDailyReport();
    expect(r.html.startsWith('<!doctype html>')).toBe(true);
    expect(r.html).toContain('name="viewport"');
    expect(r.html).toContain('@media only screen and (max-width:600px)');
    expect(r.html).toContain('.tcell{display:block');
  });

  it('keeps ads/net and an All-stores total row, and a plain legend', async () => {
    const r = await buildDailyReport();
    expect(r.html).toContain('Net · 7 days');
    expect(r.html).toContain('$203.00'); // 210 + 7 admob - 14 spend
    expect(r.html).toContain('All stores');
    expect(r.html).toContain('How to read this.');
  });

  it('uses the real logo image (not a CSS letter)', async () => {
    const r = await buildDailyReport();
    expect(r.html).toContain('src="data:image/png;base64,');
    expect(r.html).toContain('alt="Dzinemedia"');
  });

  it('colors each store dot to match the dashboard palette', async () => {
    const r = await buildDailyReport();
    expect(r.html).toContain('background:#6366f1'); // indigo-500 (US Store)
    expect(r.html).toContain('background:#10b981'); // emerald-500 (DE Store)
  });

  it('adds a Top paying countries section with flags and per-window earnings', async () => {
    const r = await buildDailyReport();
    expect(r.html).toContain('Top paying countries');
    expect(r.html).toContain('United States');
    expect(r.html).toContain('🇺🇸');
    // US 30-day = (7 + 15) × 30 = $660.00; 7-day = 22 × 7 = $154.00.
    expect(r.html).toContain('$660.00');
    expect(r.html).toContain('$154.00');
    // Ranked US > GB > DE.
    expect(r.html.indexOf('United States')).toBeLessThan(r.html.indexOf('United Kingdom'));
  });

  it('keeps a stable subject and summary for the audit trail', async () => {
    const r = await buildDailyReport();
    expect(r.subject).toBe('Dzinemedia ASM · Report 2026-06-30 — $210.00 earned last 7d · $900.00 last 30d');
    expect(r.summary).toBe('$210.00 earned 7d · $900.00 30d · 70 downloads 7d · 2 stores');
  });
});
