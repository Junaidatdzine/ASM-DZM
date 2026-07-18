import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appleAdsAdGroups,
  appleAdsAdGroupReport,
  appleAdsCampaigns,
  appleAdsCreateAdGroup,
  appleAdsCreateCampaign,
  appleAdsCreateKeywords,
  appleAdsKeywords,
  appleAdsOrgCurrency,
  appleAdsOwnedApps,
  appleAdsUpdateKeyword,
  type AppleAdsCredentials,
} from './lib/ads/appleAds';

// The mock paths activate under the emulator flag; save/restore so sibling files aren't affected.
const prev = process.env.FUNCTIONS_EMULATOR;
beforeAll(() => { process.env.FUNCTIONS_EMULATOR = 'true'; });
afterAll(() => { process.env.FUNCTIONS_EMULATOR = prev; });

const creds: AppleAdsCredentials = { clientId: 'mock', teamId: 'mock', keyId: 'mock', privateKey: 'mock', orgId: 1 };

describe('Apple Search Ads management — mock consistency', () => {
  it('seeds ad groups and keywords for the demo campaigns', async () => {
    const groups = await appleAdsAdGroups(creds, 'mock-c1');
    expect(groups.length).toBeGreaterThanOrEqual(2);
    const keywords = await appleAdsKeywords(creds, 'mock-c1', 'mock-ag1');
    expect(keywords.map((k) => k.text)).toContain('ai detector');
  });

  it('create ad group → shows up in the list', async () => {
    const created = await appleAdsCreateAdGroup(creds, 'mock-c1', { name: 'New AG', defaultBid: { amount: 0.9, currency: 'USD' } });
    expect(created.name).toBe('New AG');
    const groups = await appleAdsAdGroups(creds, 'mock-c1');
    expect(groups.some((g) => g.id === created.id && g.name === 'New AG')).toBe(true);
  });

  it('create keywords → then pause one', async () => {
    const created = await appleAdsCreateKeywords(creds, 'mock-c1', 'mock-ag1', [
      { text: 'grammar checker', matchType: 'BROAD', bid: { amount: 1.1, currency: 'USD' } },
    ]);
    expect(created).toHaveLength(1);
    const kwId = created[0]!.id;
    await appleAdsUpdateKeyword(creds, 'mock-c1', 'mock-ag1', kwId, { status: 'PAUSED' });
    const after = await appleAdsKeywords(creds, 'mock-c1', 'mock-ag1');
    expect(after.find((k) => k.id === kwId)?.status).toBe('PAUSED');
  });

  it('create campaign → appears in the campaign list', async () => {
    const c = await appleAdsCreateCampaign(creds, {
      name: 'Brand New Campaign',
      adamId: 6754688919,
      budgetAmount: { amount: 500, currency: 'USD' },
      dailyBudgetAmount: { amount: 25, currency: 'USD' },
      countries: ['US', 'GB'],
    });
    const list = await appleAdsCampaigns(creds);
    expect(list.some((x) => x.id === c.id && x.name === 'Brand New Campaign')).toBe(true);
  });

  it('lists the account’s promotable apps with eligible countries, and its currency', async () => {
    const apps = await appleAdsOwnedApps(creds);
    expect(apps.length).toBeGreaterThan(0);
    expect(apps[0]).toMatchObject({ adamId: expect.any(Number), name: expect.any(String) });
    expect(apps[0]!.countries).toContain('US');
    expect(await appleAdsOrgCurrency(creds)).toBe('USD');
  });

  it('campaigns carry the promoted app id for duplicate checks', async () => {
    const list = await appleAdsCampaigns(creds);
    expect(list.find((c) => c.id === 'mock-c1')?.adamId).toBe(6754688919);
  });

  it('ad-group report returns a metric row per ad group', async () => {
    const metrics = await appleAdsAdGroupReport(creds, 'mock-c1', '2026-06-01', '2026-06-30');
    expect(metrics.length).toBeGreaterThan(0);
    expect(metrics[0]).toHaveProperty('installs');
    expect(metrics[0]!.spendAmount).toBeGreaterThanOrEqual(0);
  });
});

describe('rankFromResults (organic App Store rank)', () => {
  it('finds the 1-based position of the app in search results', async () => {
    const { rankFromResults } = await import('./lib/ads/itunesRank');
    const doc = { resultCount: 3, results: [{ trackId: 111 }, { trackId: 6754688919 }, { trackId: 333 }] };
    expect(rankFromResults(doc, 6754688919)).toEqual({ rank: 2, results: 3 });
  });

  it('returns null rank when the app is outside the results', async () => {
    const { rankFromResults } = await import('./lib/ads/itunesRank');
    expect(rankFromResults({ resultCount: 200, results: [{ trackId: 1 }] }, 42)).toEqual({ rank: null, results: 200 });
    expect(rankFromResults({}, 42)).toEqual({ rank: null, results: 0 });
  });

  it('emulator mock returns deterministic ranks for every term', async () => {
    const { fetchKeywordRanks } = await import('./lib/ads/itunesRank');
    const a = await fetchKeywordRanks(['hp printer', 'scanner app'], 'US', 6754688919);
    const b = await fetchKeywordRanks(['hp printer', 'scanner app'], 'US', 6754688919);
    expect(a).toEqual(b);
    expect(a).toHaveLength(2);
    expect(a[0]).toHaveProperty('rank');
  });
});
