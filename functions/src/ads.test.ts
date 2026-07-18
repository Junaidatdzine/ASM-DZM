import { describe, expect, it } from 'vitest';
import { mapAppleAdsRow } from './lib/ads/appleAds';
import { parseAdmobReport } from './lib/ads/admob';

describe('mapAppleAdsRow', () => {
  it('flattens campaign granularity into per-day rows', () => {
    const rows = mapAppleAdsRow({
      metadata: { campaignId: 42, campaignName: 'US Search' },
      granularity: [
        { date: '2026-07-16', localSpend: { amount: '12.34', currency: 'USD' }, taps: 80, impressions: 900, totalInstalls: 25 },
        { date: '2026-07-17', localSpend: { amount: '3.50', currency: 'EUR' }, taps: 10, impressions: 200, tapInstalls: 3, viewInstalls: 1 },
      ],
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ date: '2026-07-16', campaignId: '42', campaignName: 'US Search', spendAmount: 12.34, spendCurrency: 'USD', installs: 25 });
    // totalInstalls missing → tap+view fallback
    expect(rows[1]).toMatchObject({ spendAmount: 3.5, spendCurrency: 'EUR', installs: 4 });
  });

  it('tolerates empty/missing fields', () => {
    expect(mapAppleAdsRow({})).toEqual([]);
    expect(mapAppleAdsRow({ metadata: { campaignId: 1 }, granularity: [{ date: '2026-07-17' }] })[0]).toMatchObject({
      spendAmount: 0,
      spendCurrency: 'USD',
      taps: 0,
      installs: 0,
    });
  });
});

describe('parseAdmobReport', () => {
  it('converts micros and YYYYMMDD dates, using header currency', () => {
    const rows = parseAdmobReport(
      [
        { header: { localizationSettings: { currencyCode: 'EUR' } } },
        { row: { dimensionValues: { DATE: { value: '20260716' } }, metricValues: { ESTIMATED_EARNINGS: { microsValue: '12345678' } } } },
        { row: { dimensionValues: { DATE: { value: '20260717' } }, metricValues: { ESTIMATED_EARNINGS: { microsValue: '0' } } } },
        {},
      ],
      'USD',
    );
    expect(rows).toEqual([
      { date: '2026-07-16', amount: 12.35, currency: 'EUR' },
      { date: '2026-07-17', amount: 0, currency: 'EUR' },
    ]);
  });

  it('falls back to the account currency without a header', () => {
    const rows = parseAdmobReport(
      [{ row: { dimensionValues: { DATE: { value: '20260717' } }, metricValues: { ESTIMATED_EARNINGS: { microsValue: '990000' } } } }],
      'PKR',
    );
    expect(rows[0]).toEqual({ date: '2026-07-17', amount: 0.99, currency: 'PKR' });
  });
});
