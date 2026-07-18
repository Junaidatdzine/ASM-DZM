/**
 * Apple Search Ads status resolution. Apple's `status` field only says
 * ENABLED/PAUSED — whether an entity actually serves is in `displayStatus`
 * (RUNNING | ON_HOLD | PAUSED | DELETED) plus `servingStateReasons`.
 * A campaign can be "ENABLED" while the whole account is on hold over billing.
 */

export type AdsStatusKind = 'running' | 'paused' | 'onHold' | 'deleted' | 'other';

export interface ResolvedAdsStatus {
  kind: AdsStatusKind;
  /** Short badge label, e.g. "Running", "On hold". */
  label: string;
  /** Plain-English explanations from servingStateReasons (empty when serving). */
  reasons: string[];
}

/** Common serving-state reasons, translated for non-technical readers. */
const REASON_TEXT: Record<string, string> = {
  NO_PAYMENT_METHOD_ON_FILE: 'No payment method on file — add a card in Apple Ads billing',
  CREDIT_CARD_DECLINED: 'Credit card declined — update billing in Apple Ads',
  ORG_PAYMENT_TYPE_CHANGED: 'Payment method changed — confirm billing in Apple Ads',
  ORG_SUSPENDED_POLICY_VIOLATION: 'Account suspended by Apple (policy violation)',
  ORG_SUSPENDED_FRAUD: 'Account suspended by Apple',
  ORG_CHARGE_BACK_DISPUTED: 'Payment dispute on the account — contact Apple Ads support',
  TAX_VERIFICATION_PENDING: 'Waiting for Apple to verify tax information',
  TOTAL_BUDGET_EXHAUSTED: 'Lifetime budget fully spent — raise the total budget to resume',
  DAILY_CAP_EXHAUSTED: 'Daily budget spent — resumes tomorrow',
  CAMPAIGN_END_DATE_REACHED: 'Campaign end date reached',
  CAMPAIGN_START_DATE_IN_FUTURE: 'Scheduled to start later',
  CAMPAIGN_NOT_RUNNING: 'Campaign isn’t running',
  APP_NOT_ELIGIBLE: 'App not eligible for Apple Ads',
  APP_NOT_ELIGIBLE_SEARCHADS: 'App not eligible for Search Ads',
  APP_NOT_PUBLISHED_YET: 'App isn’t live on the App Store yet',
  PAUSED_BY_USER: 'Paused manually',
  PAUSED_BY_SYSTEM: 'Paused by Apple',
  DELETED_BY_USER: 'Deleted',
  AD_GROUP_END_DATE_REACHED: 'Ad group end date reached',
  AD_GROUP_START_DATE_IN_FUTURE: 'Scheduled to start later',
  AUDIENCE_BELOW_THRESHOLD: 'Audience too small to serve ads',
  NO_ELIGIBLE_COUNTRIES: 'No eligible countries to serve in',
};

/** "CREDIT_CARD_DECLINED" → "Credit card declined" for reasons we don't map. */
function fallbackReason(reason: string): string {
  const words = reason.toLowerCase().split('_').join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function humanizeServingReasons(reasons: string[] | undefined): string[] {
  return (reasons ?? []).map((r) => REASON_TEXT[r] ?? fallbackReason(r));
}

/**
 * Resolve what to show for a campaign/ad group. displayStatus wins when
 * present (it reflects real serving); plain status is the fallback.
 */
export function resolveAdsStatus(entity: {
  status: string;
  displayStatus?: string;
  servingStateReasons?: string[];
}): ResolvedAdsStatus {
  const display = (entity.displayStatus ?? '').toUpperCase();
  const status = (entity.status ?? '').toUpperCase();
  const reasons = humanizeServingReasons(entity.servingStateReasons);

  if (display === 'ON_HOLD') return { kind: 'onHold', label: 'On hold', reasons };
  if (display === 'DELETED' || status === 'DELETED') return { kind: 'deleted', label: 'Deleted', reasons };
  if (display === 'PAUSED' || (!display && status === 'PAUSED')) return { kind: 'paused', label: 'Paused', reasons: [] };
  if (display === 'RUNNING' || (!display && (status === 'ENABLED' || status === 'ACTIVE'))) {
    return { kind: 'running', label: 'Running', reasons: [] };
  }
  return { kind: 'other', label: (display || status || 'unknown').toLowerCase(), reasons };
}
