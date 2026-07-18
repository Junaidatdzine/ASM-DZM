import { describe, expect, it } from 'vitest';
import { parseSubscriptionEventTsv } from './lib/asc/client';
import { aggregateSubsDay } from './callable/finance';
import type { SubscriptionEventRow } from './lib/asc/types';

// Columns deliberately scrambled to prove the parser is header-name based.
const TSV = [
  'App Apple ID\tEvent\tQuantity\tSubscription Offer Type\tCountry',
  '6754688919\tSubscribe\t12\tFree Trial\tUS', // trial start
  '6754688919\tSubscribe\t5\t\tUS', // new paid (no offer)
  '6754688919\tSubscribe\t3\tPay As You Go\tUS', // new paid (paid offer)
  '6754688919\tCancel\t4\t\tUS', // cancellation
  '6754688919\tRenew\t20\t\tUS', // ignored (not a start/cancel)
  '6754688919\tSubscribe\t0\tFree Trial\tUS', // skipped: quantity 0
  'Total', // malformed/total row: skipped
].join('\n');

describe('parseSubscriptionEventTsv', () => {
  it('reads Event / App Apple ID / Offer Type / Quantity regardless of column order', () => {
    const rows = parseSubscriptionEventTsv(TSV);
    expect(rows).toHaveLength(5); // 6 event rows minus the quantity-0 row
    expect(rows[0]).toEqual({ event: 'Subscribe', appAppleId: '6754688919', offerType: 'Free Trial', quantity: 12 });
    expect(rows.find((r) => r.event === 'Cancel')?.quantity).toBe(4);
  });

  it('returns [] for empty input or a report missing the Quantity column', () => {
    expect(parseSubscriptionEventTsv('')).toEqual([]);
    expect(parseSubscriptionEventTsv('Event\tCountry\nSubscribe\tUS')).toEqual([]);
  });
});

describe('aggregateSubsDay', () => {
  it('splits Subscribe events into trial vs paid by offer type and counts cancellations', () => {
    const rows: SubscriptionEventRow[] = [
      { event: 'Subscribe', appAppleId: 'x', offerType: 'Free Trial', quantity: 10 },
      { event: 'subscribe', appAppleId: 'x', offerType: '', quantity: 4 }, // case-insensitive
      { event: 'Subscribe', appAppleId: 'x', offerType: 'Pay Up Front', quantity: 2 },
      { event: 'Cancel', appAppleId: 'x', offerType: '', quantity: 3 },
      { event: 'Renew', appAppleId: 'x', offerType: '', quantity: 99 }, // ignored
    ];
    const agg = aggregateSubsDay('2026-06-30', rows);
    expect(agg).toMatchObject({ date: '2026-06-30', trialStarts: 10, newPaid: 6, cancellations: 3 });
  });

  it('is all-zero for a day with no relevant events', () => {
    const agg = aggregateSubsDay('2026-06-30', [{ event: 'Renew', appAppleId: 'x', offerType: '', quantity: 5 }]);
    expect(agg).toMatchObject({ trialStarts: 0, newPaid: 0, cancellations: 0 });
  });
});
