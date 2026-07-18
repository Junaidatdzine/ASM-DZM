import { describe, expect, it } from 'vitest';
import {
  AGE_RATING_BOOL_FIELDS,
  AGE_RATING_LEVEL_FIELDS,
  FIELD_SPECS,
  INFO_FIELDS,
  OPEN_SUBMISSION_STATES,
  decodeFieldKey,
  describeSubmissionState,
  fieldKeyFor,
  isAgeRatingLevel,
  isKidsAgeBand,
  versionBucket,
  phasedReleasePercent,
  validateFieldValue,
} from '../../shared/src/index';

describe('privacy URL metadata fields', () => {
  it('are first-class info fields with the draft/push key encoding', () => {
    expect(INFO_FIELDS).toContain('privacyPolicyUrl');
    expect(INFO_FIELDS).toContain('privacyChoicesUrl');
    expect(fieldKeyFor('IOS', 'privacyPolicyUrl')).toBe('info__privacyPolicyUrl');
    expect(decodeFieldKey('info__privacyPolicyUrl')).toEqual({
      target: 'info',
      platform: null,
      field: 'privacyPolicyUrl',
    });
  });

  it('validate as URLs and are excluded from AI', () => {
    expect(validateFieldValue('privacyPolicyUrl', 'https://example.com/privacy')).toBeNull();
    expect(validateFieldValue('privacyPolicyUrl', 'not a url')).toMatch(/valid http/);
    expect(FIELD_SPECS.privacyPolicyUrl.aiEligible).toBe(false);
  });
});

describe('phased release', () => {
  it("maps day numbers onto Apple's 7-day curve", () => {
    expect(phasedReleasePercent(1)).toBe(1);
    expect(phasedReleasePercent(3)).toBe(5);
    expect(phasedReleasePercent(7)).toBe(100);
    expect(phasedReleasePercent(9)).toBe(100); // clamped
    expect(phasedReleasePercent(null)).toBeNull();
    expect(phasedReleasePercent(0)).toBeNull();
  });
});

describe('review submissions', () => {
  it('treats every in-flight state as open', () => {
    for (const state of ['READY_FOR_REVIEW', 'WAITING_FOR_REVIEW', 'IN_REVIEW', 'UNRESOLVED_ISSUES']) {
      expect(OPEN_SUBMISSION_STATES.has(state)).toBe(true);
    }
    expect(OPEN_SUBMISSION_STATES.has('COMPLETE')).toBe(false);
  });

  it('describes states human-readably with a fallback', () => {
    expect(describeSubmissionState('IN_REVIEW')).toBe('In review');
    expect(describeSubmissionState('SOME_NEW_STATE')).toBe('some new state');
    expect(describeSubmissionState(null)).toBe('—');
  });
});

describe('age rating spec', () => {
  it('covers the full questionnaire with unique keys', () => {
    const keys = [...AGE_RATING_LEVEL_FIELDS, ...AGE_RATING_BOOL_FIELDS].map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(AGE_RATING_LEVEL_FIELDS).toHaveLength(12);
    expect(AGE_RATING_BOOL_FIELDS).toHaveLength(2);
  });

  it('guards enum values', () => {
    expect(isAgeRatingLevel('INFREQUENT_OR_MILD')).toBe(true);
    expect(isAgeRatingLevel('SOMETIMES')).toBe(false);
    expect(isKidsAgeBand('SIX_TO_EIGHT')).toBe(true);
    expect(isKidsAgeBand('ADULT')).toBe(false);
  });
});

describe('versionBucket', () => {
  it('classifies every rejected flavor as rejected', () => {
    for (const state of ['REJECTED', 'METADATA_REJECTED', 'DEVELOPER_REJECTED', 'INVALID_BINARY']) {
      expect(versionBucket(state)).toBe('rejected');
    }
  });
  it('classifies waiting, review, approved and draft states', () => {
    expect(versionBucket('WAITING_FOR_REVIEW')).toBe('waiting');
    expect(versionBucket('WAITING_FOR_EXPORT_COMPLIANCE')).toBe('waiting');
    expect(versionBucket('IN_REVIEW')).toBe('inReview');
    expect(versionBucket('PENDING_DEVELOPER_RELEASE')).toBe('approved');
    expect(versionBucket('ACCEPTED')).toBe('approved');
    expect(versionBucket('PREPARE_FOR_SUBMISSION')).toBe('draft');
    expect(versionBucket(null)).toBeNull();
  });
});
