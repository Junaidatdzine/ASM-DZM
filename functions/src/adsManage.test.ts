import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appleAdsAdGroups,
  appleAdsAdGroupReport,
  appleAdsCampaigns,
  appleAdsCreateAdGroup,
  appleAdsCreateCampaign,
  appleAdsCreateKeywords,
  appleAdsKeywords,
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

  it('ad-group report returns a metric row per ad group', async () => {
    const metrics = await appleAdsAdGroupReport(creds, 'mock-c1', '2026-06-01', '2026-06-30');
    expect(metrics.length).toBeGreaterThan(0);
    expect(metrics[0]).toHaveProperty('installs');
    expect(metrics[0]!.spendAmount).toBeGreaterThanOrEqual(0);
  });
});
