import { describe, expect, it } from 'vitest';
import {
  COPYRIGHT_MAX,
  cleanBuildRef,
  isBuildAttachable,
  normalizeEarliestReleaseDate,
  releaseConfigError,
  validateCopyright,
} from '../../shared/src/index';

describe('normalizeEarliestReleaseDate', () => {
  it('floors to the top of the hour in UTC', () => {
    expect(normalizeEarliestReleaseDate('2026-08-01T09:47:31.500Z')).toBe('2026-08-01T09:00:00Z');
  });

  it('produces an Apple-shaped ISO string (no fractional seconds)', () => {
    const out = normalizeEarliestReleaseDate('2026-12-31T23:59:00Z');
    expect(out).toBe('2026-12-31T23:00:00Z');
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:00:00Z$/);
  });

  it('returns null for empty or unparseable input', () => {
    expect(normalizeEarliestReleaseDate('')).toBeNull();
    expect(normalizeEarliestReleaseDate(null)).toBeNull();
    expect(normalizeEarliestReleaseDate('not-a-date')).toBeNull();
  });
});

describe('releaseConfigError', () => {
  const now = Date.parse('2026-07-17T00:00:00Z');

  it('allows non-scheduled types with no date', () => {
    expect(releaseConfigError('MANUAL', null, now)).toBeNull();
    expect(releaseConfigError('AFTER_APPROVAL', null, now)).toBeNull();
  });

  it('requires a future date for scheduled release', () => {
    expect(releaseConfigError('SCHEDULED', null, now)).toMatch(/pick a release date/i);
    expect(releaseConfigError('SCHEDULED', '2026-07-10T00:00:00Z', now)).toMatch(/future/i);
    expect(releaseConfigError('SCHEDULED', '2026-08-01T00:00:00Z', now)).toBeNull();
  });

  it('rejects an unparseable scheduled date', () => {
    expect(releaseConfigError('SCHEDULED', 'soon', now)).toMatch(/isn’t valid/i);
  });
});

describe('validateCopyright', () => {
  it('accepts values within Apple’s limit', () => {
    expect(validateCopyright('2026 DzineMedia')).toBeNull();
    expect(validateCopyright('x'.repeat(COPYRIGHT_MAX))).toBeNull();
  });

  it('rejects overlong values', () => {
    expect(validateCopyright('x'.repeat(COPYRIGHT_MAX + 1))).toMatch(/exceeds/);
  });
});

describe('cleanBuildRef', () => {
  it('omits undefined optional keys (Firestore rejects explicit undefined)', () => {
    const cleaned = cleanBuildRef({ id: 'b1', version: '42', uploadedDate: undefined, processingState: undefined });
    expect(cleaned).toEqual({ id: 'b1', version: '42' });
    expect('uploadedDate' in cleaned).toBe(false);
    expect('processingState' in cleaned).toBe(false);
  });

  it('keeps defined keys, including null encryption and false expired', () => {
    const cleaned = cleanBuildRef({
      id: 'b2',
      version: '43',
      processingState: 'VALID',
      expired: false,
      usesNonExemptEncryption: null,
    });
    expect(cleaned).toEqual({
      id: 'b2',
      version: '43',
      processingState: 'VALID',
      expired: false,
      usesNonExemptEncryption: null,
    });
  });
});

describe('isBuildAttachable', () => {
  it('only accepts a VALID, unexpired build', () => {
    expect(isBuildAttachable({ processingState: 'VALID', expired: false })).toBe(true);
    expect(isBuildAttachable({ processingState: 'VALID', expired: true })).toBe(false);
    expect(isBuildAttachable({ processingState: 'PROCESSING', expired: false })).toBe(false);
    expect(isBuildAttachable({ processingState: 'INVALID', expired: false })).toBe(false);
  });
});
