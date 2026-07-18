/**
 * App Review, release, and rating domain — pure helpers shared by web + functions.
 * Covers appStoreReviewDetails, appStoreVersionPhasedReleases, reviewSubmissions,
 * ageRatingDeclarations, and customerReviews.
 */

// ---- App Review details ----

export interface ReviewDetailFields {
  contactFirstName: string;
  contactLastName: string;
  contactPhone: string;
  contactEmail: string;
  demoAccountName: string;
  demoAccountPassword: string;
  demoAccountRequired: boolean;
  notes: string;
}

export const REVIEW_DETAIL_LIMITS: Record<Exclude<keyof ReviewDetailFields, 'demoAccountRequired'>, number> = {
  contactFirstName: 255,
  contactLastName: 255,
  contactPhone: 40,
  contactEmail: 255,
  demoAccountName: 255,
  demoAccountPassword: 255,
  notes: 4000,
};

/** Max size for a review attachment we accept (Apple allows more; this keeps memory sane). */
export const MAX_REVIEW_ATTACHMENT_BYTES = 30 * 1024 * 1024;

// ---- Phased release ----

export type PhasedReleaseState = 'INACTIVE' | 'ACTIVE' | 'PAUSED' | 'COMPLETE';

export const PHASED_RELEASE_STATE_LABELS: Record<PhasedReleaseState, string> = {
  INACTIVE: 'Scheduled — starts when the version is released',
  ACTIVE: 'Rolling out',
  PAUSED: 'Paused',
  COMPLETE: 'Completed — released to everyone',
};

/** Apple's 7-day phased-release curve (percent of users per day). */
export const PHASED_RELEASE_CURVE = [1, 2, 5, 10, 20, 50, 100] as const;

export function phasedReleasePercent(dayNumber: number | null | undefined): number | null {
  if (!dayNumber || dayNumber < 1) return null;
  return PHASED_RELEASE_CURVE[Math.min(dayNumber, PHASED_RELEASE_CURVE.length) - 1] ?? 100;
}

// ---- Review submissions ----

export type ReviewSubmissionState =
  | 'READY_FOR_REVIEW'
  | 'WAITING_FOR_REVIEW'
  | 'IN_REVIEW'
  | 'UNRESOLVED_ISSUES'
  | 'CANCELING'
  | 'COMPLETING'
  | 'COMPLETE'
  | (string & {});

export const REVIEW_SUBMISSION_STATE_LABELS: Record<string, string> = {
  READY_FOR_REVIEW: 'Draft submission — not sent yet',
  WAITING_FOR_REVIEW: 'Waiting for review',
  IN_REVIEW: 'In review',
  UNRESOLVED_ISSUES: 'Unresolved issues',
  CANCELING: 'Canceling…',
  COMPLETING: 'Completing…',
  COMPLETE: 'Complete',
};

/** Submissions in these states block creating a new one and can be canceled. */
export const OPEN_SUBMISSION_STATES = new Set<string>([
  'READY_FOR_REVIEW',
  'WAITING_FOR_REVIEW',
  'IN_REVIEW',
  'UNRESOLVED_ISSUES',
]);

export function describeSubmissionState(state: string | null | undefined): string {
  if (!state) return '—';
  return REVIEW_SUBMISSION_STATE_LABELS[state] ?? state.replace(/_/g, ' ').toLowerCase();
}

// ---- Version status buckets (dashboard overview) ----

export type VersionBucket = 'rejected' | 'waiting' | 'inReview' | 'approved' | 'draft';

const REJECTED_STATES = new Set(['REJECTED', 'METADATA_REJECTED', 'DEVELOPER_REJECTED', 'INVALID_BINARY']);
const WAITING_STATES = new Set(['WAITING_FOR_REVIEW', 'WAITING_FOR_EXPORT_COMPLIANCE', 'READY_FOR_REVIEW']);
const IN_REVIEW_STATES = new Set(['IN_REVIEW']);
const APPROVED_STATES = new Set(['PENDING_DEVELOPER_RELEASE', 'PENDING_APPLE_RELEASE', 'PROCESSING_FOR_APP_STORE', 'ACCEPTED']);

/** Classify an EDITABLE version's state for the dashboard. Live versions are their own bucket. */
export function versionBucket(state: string | null | undefined): VersionBucket | null {
  if (!state) return null;
  if (REJECTED_STATES.has(state)) return 'rejected';
  if (WAITING_STATES.has(state)) return 'waiting';
  if (IN_REVIEW_STATES.has(state)) return 'inReview';
  if (APPROVED_STATES.has(state)) return 'approved';
  return 'draft'; // PREPARE_FOR_SUBMISSION and any editable leftovers
}

// ---- Age rating declarations ----

export type AgeRatingLevel = 'NONE' | 'INFREQUENT_OR_MILD' | 'FREQUENT_OR_INTENSE';
export type KidsAgeBand = 'FIVE_AND_UNDER' | 'SIX_TO_EIGHT' | 'NINE_TO_ELEVEN';

export const AGE_RATING_LEVELS: readonly AgeRatingLevel[] = ['NONE', 'INFREQUENT_OR_MILD', 'FREQUENT_OR_INTENSE'];

export const AGE_RATING_LEVEL_LABELS: Record<AgeRatingLevel, string> = {
  NONE: 'None',
  INFREQUENT_OR_MILD: 'Infrequent/Mild',
  FREQUENT_OR_INTENSE: 'Frequent/Intense',
};

/** Graduated (NONE / mild / intense) content descriptors, in Apple's questionnaire order. */
export const AGE_RATING_LEVEL_FIELDS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'violenceCartoonOrFantasy', label: 'Cartoon or fantasy violence' },
  { key: 'violenceRealistic', label: 'Realistic violence' },
  { key: 'violenceRealisticProlongedGraphicOrSadistic', label: 'Prolonged graphic or sadistic realistic violence' },
  { key: 'profanityOrCrudeHumor', label: 'Profanity or crude humor' },
  { key: 'matureOrSuggestiveThemes', label: 'Mature or suggestive themes' },
  { key: 'horrorOrFearThemes', label: 'Horror or fear themes' },
  { key: 'medicalOrTreatmentInformation', label: 'Medical or treatment information' },
  { key: 'alcoholTobaccoOrDrugUseOrReferences', label: 'Alcohol, tobacco, or drug use or references' },
  { key: 'sexualContentOrNudity', label: 'Sexual content or nudity' },
  { key: 'sexualContentGraphicAndNudity', label: 'Graphic sexual content and nudity' },
  { key: 'gamblingSimulated', label: 'Simulated gambling' },
  { key: 'contests', label: 'Contests' },
] as const;

/** Yes/no declarations. */
export const AGE_RATING_BOOL_FIELDS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'gambling', label: 'Real gambling with cash prizes' },
  { key: 'unrestrictedWebAccess', label: 'Unrestricted web access' },
] as const;

export const KIDS_AGE_BAND_LABELS: Record<KidsAgeBand, string> = {
  FIVE_AND_UNDER: '5 and under',
  SIX_TO_EIGHT: '6–8',
  NINE_TO_ELEVEN: '9–11',
};

/** A full declaration as we exchange it: level fields + booleans + optional kids band. */
export interface AgeRatingValues {
  levels: Record<string, AgeRatingLevel>;
  booleans: Record<string, boolean>;
  kidsAgeBand: KidsAgeBand | null;
}

export function isAgeRatingLevel(v: unknown): v is AgeRatingLevel {
  return v === 'NONE' || v === 'INFREQUENT_OR_MILD' || v === 'FREQUENT_OR_INTENSE';
}

export function isKidsAgeBand(v: unknown): v is KidsAgeBand {
  return v === 'FIVE_AND_UNDER' || v === 'SIX_TO_EIGHT' || v === 'NINE_TO_ELEVEN';
}

// ---- Customer reviews ----

export interface CustomerReviewEntry {
  id: string;
  rating: number;
  title: string;
  body: string;
  reviewerNickname: string;
  createdDate: string;
  territory: string;
  response: {
    id: string;
    body: string;
    lastModified: string;
    state: string; // PENDING_PUBLISH | PUBLISHED
  } | null;
}

export const CUSTOMER_REVIEW_RESPONSE_MAX = 5970;
