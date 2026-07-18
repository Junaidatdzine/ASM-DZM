/** Version Information (release configuration + build selection) — pure helpers shared by web + functions. */
import type { BuildRef, ReleaseType } from './types';

export const RELEASE_TYPES: readonly ReleaseType[] = ['AFTER_APPROVAL', 'MANUAL', 'SCHEDULED'] as const;

export const RELEASE_TYPE_LABELS: Record<ReleaseType, { label: string; hint: string }> = {
  AFTER_APPROVAL: {
    label: 'Automatically after review',
    hint: 'Releases as soon as Apple approves it.',
  },
  MANUAL: {
    label: 'Manually',
    hint: 'Stays approved but unreleased until you release it yourself.',
  },
  SCHEDULED: {
    label: 'On a specific date',
    hint: 'Releases automatically on the date you choose, once approved.',
  },
};

export function describeReleaseType(t: string | null | undefined): string {
  return t && t in RELEASE_TYPE_LABELS ? RELEASE_TYPE_LABELS[t as ReleaseType].label : '—';
}

/** Apple's appStoreVersions.copyright length limit. */
export const COPYRIGHT_MAX = 118;

export function validateCopyright(value: string): string | null {
  if (value.length > COPYRIGHT_MAX) {
    return `Copyright exceeds ${COPYRIGHT_MAX} characters (currently ${value.length}).`;
  }
  return null;
}

/**
 * Floor a chosen release moment to the top of the hour in UTC and emit ISO-8601.
 * Apple only accepts a scheduled release time with minutes/seconds at zero.
 * Returns null when the input can't be parsed.
 */
export function normalizeEarliestReleaseDate(input: string | null | undefined): string | null {
  if (!input) return null;
  const ms = Date.parse(input);
  if (Number.isNaN(ms)) return null;
  const d = new Date(ms);
  d.setUTCMinutes(0, 0, 0);
  return `${d.toISOString().slice(0, 19)}Z`;
}

/**
 * Validate a release configuration. `now` is injectable so the check is deterministic
 * in tests and identical on the client (disable Save) and server (reject the mutation).
 */
export function releaseConfigError(
  releaseType: ReleaseType,
  earliestReleaseDate: string | null | undefined,
  now: number = Date.now(),
): string | null {
  if (releaseType !== 'SCHEDULED') return null;
  if (!earliestReleaseDate) return 'Pick a release date.';
  const ms = Date.parse(earliestReleaseDate);
  if (Number.isNaN(ms)) return 'That release date isn’t valid.';
  if (ms <= now) return 'The release date must be in the future.';
  return null;
}

export function describeBuildState(state: string | null | undefined): string {
  const map: Record<string, string> = {
    PROCESSING: 'Processing',
    FAILED: 'Failed',
    INVALID: 'Invalid',
    VALID: 'Ready',
  };
  return state ? (map[state] ?? state) : 'Unknown';
}

/** Only a fully-processed, unexpired build can be attached to a version. */
export function isBuildAttachable(build: Pick<BuildRef, 'processingState' | 'expired'>): boolean {
  return build.processingState === 'VALID' && !build.expired;
}

/**
 * Normalize a build into a Firestore-safe BuildRef by omitting undefined optional keys.
 * The Admin SDK rejects explicit `undefined`, so callers persisting a build must clean it.
 */
export function cleanBuildRef(b: BuildRef): BuildRef {
  const out: BuildRef = { id: b.id, version: b.version };
  if (b.uploadedDate !== undefined) out.uploadedDate = b.uploadedDate;
  if (b.processingState !== undefined) out.processingState = b.processingState;
  if (b.expired !== undefined) out.expired = b.expired;
  if (b.usesNonExemptEncryption !== undefined) out.usesNonExemptEncryption = b.usesNonExemptEncryption;
  return out;
}
