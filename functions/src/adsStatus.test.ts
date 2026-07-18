import { describe, expect, it } from 'vitest';
import { humanizeServingReasons, resolveAdsStatus } from '../../shared/src/adsStatus';

describe('resolveAdsStatus', () => {
  it('flags ON_HOLD even when the campaign status is ENABLED (billing hold)', () => {
    const r = resolveAdsStatus({ status: 'ENABLED', displayStatus: 'ON_HOLD', servingStateReasons: ['CREDIT_CARD_DECLINED'] });
    expect(r.kind).toBe('onHold');
    expect(r.label).toBe('On hold');
    expect(r.reasons[0]).toContain('Credit card declined');
  });

  it('trusts displayStatus RUNNING over anything else', () => {
    expect(resolveAdsStatus({ status: 'ENABLED', displayStatus: 'RUNNING' }).kind).toBe('running');
  });

  it('falls back to plain status when displayStatus is absent (keywords)', () => {
    expect(resolveAdsStatus({ status: 'ACTIVE' }).kind).toBe('running');
    expect(resolveAdsStatus({ status: 'PAUSED' }).kind).toBe('paused');
    expect(resolveAdsStatus({ status: 'ENABLED' }).kind).toBe('running');
  });

  it('handles PAUSED and DELETED display states', () => {
    expect(resolveAdsStatus({ status: 'ENABLED', displayStatus: 'PAUSED' }).kind).toBe('paused');
    expect(resolveAdsStatus({ status: 'ENABLED', displayStatus: 'DELETED' }).kind).toBe('deleted');
  });

  it('surfaces unknown states as lowercase labels instead of a false Running', () => {
    const r = resolveAdsStatus({ status: 'ENABLED', displayStatus: 'CAMPAIGN_ON_HOLD', servingStateReasons: ['SOMETHING_NEW'] });
    expect(r.kind).toBe('other');
    expect(r.label).toBe('campaign_on_hold');
    expect(r.reasons[0]).toBe('Something new'); // graceful fallback wording
  });
});

describe('humanizeServingReasons', () => {
  it('maps known reasons to plain English and title-cases the rest', () => {
    expect(humanizeServingReasons(['NO_PAYMENT_METHOD_ON_FILE'])[0]).toContain('No payment method on file');
    expect(humanizeServingReasons(['TOTAL_BUDGET_EXHAUSTED'])[0]).toContain('Lifetime budget fully spent');
    expect(humanizeServingReasons(['SOME_FUTURE_REASON'])[0]).toBe('Some future reason');
    expect(humanizeServingReasons(undefined)).toEqual([]);
  });
});
