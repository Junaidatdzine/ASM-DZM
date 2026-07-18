import type { AppDoc, Platform } from './types';
import type { MetadataField } from './limits';
import { FIELD_SPECS } from './limits';

/**
 * Which App Store states allow metadata edits. Used for UI locks and pre-push checks;
 * the server ALWAYS re-fetches fresh state before mutating, so this list gates UX,
 * never correctness.
 */
export const EDITABLE_STATES = new Set([
  'PREPARE_FOR_SUBMISSION',
  'METADATA_REJECTED',
  'DEVELOPER_REJECTED',
  'REJECTED',
  'INVALID_BINARY',
]);

export function isEditableState(state: string | null | undefined): boolean {
  return !!state && EDITABLE_STATES.has(state);
}

export interface FieldStatus {
  /** Can the user type into this field (i.e. does an editable target exist)? */
  editable: boolean;
  /** Where a push would write: the editable branch, or promo-on-live special case. */
  pushTarget: 'editable' | 'livePromo' | null;
  /** Human reason when locked. */
  lockReason: string | null;
  /** Show the field in the editor. All supported metadata fields stay visible. */
  visible: boolean;
}

export function fieldStatus(app: AppDoc, platform: Platform, field: MetadataField): FieldStatus {
  const spec = FIELD_SPECS[field];
  const pv = app.versions?.[platform];
  const editableVersion = pv?.editable ?? null;
  const liveVersion = pv?.live ?? null;

  if (spec.target === 'info') {
    if (app.appInfo?.editableId && isEditableState(app.appInfo.editableState)) {
      return { editable: true, pushTarget: 'editable', lockReason: null, visible: true };
    }
    return {
      editable: false,
      pushTarget: null,
      lockReason:
        'Name and subtitle can only change while a version is being prepared. Create a new version to edit them.',
      visible: true,
    };
  }

  // Version fields
  if (field === 'whatsNew' && !liveVersion) {
    // Apple rejects release notes on an app's first-ever version.
    return {
      editable: false,
      pushTarget: null,
      lockReason: 'Apple does not accept What’s New on an app’s first version. It becomes editable after the first version is live.',
      visible: true,
    };
  }

  if (editableVersion && isEditableState(editableVersion.state)) {
    return { editable: true, pushTarget: 'editable', lockReason: null, visible: true };
  }

  if (field === 'promotionalText' && liveVersion) {
    return {
      editable: true,
      pushTarget: 'livePromo',
      lockReason: null,
      visible: true,
    };
  }

  return {
    editable: false,
    pushTarget: null,
    lockReason: liveVersion
      ? `v${liveVersion.versionString} is live and can’t be edited. Create a new version to change this field.`
      : 'No editable version exists. Create a version first.',
    visible: true,
  };
}

/** True when the app has an editable version on the given platform. */
export function hasEditableVersion(app: AppDoc, platform: Platform): boolean {
  const v = app.versions?.[platform]?.editable;
  return !!v && isEditableState(v.state);
}

export function describeVersionState(state: string): string {
  const map: Record<string, string> = {
    PREPARE_FOR_SUBMISSION: 'Prepare for Submission',
    METADATA_REJECTED: 'Metadata Rejected',
    DEVELOPER_REJECTED: 'Developer Rejected',
    REJECTED: 'Rejected',
    INVALID_BINARY: 'Invalid Binary',
    WAITING_FOR_REVIEW: 'Waiting for Review',
    IN_REVIEW: 'In Review',
    PENDING_DEVELOPER_RELEASE: 'Pending Developer Release',
    PENDING_APPLE_RELEASE: 'Pending Apple Release',
    PROCESSING_FOR_APP_STORE: 'Processing for App Store',
    READY_FOR_SALE: 'Ready for Sale',
    READY_FOR_DISTRIBUTION: 'Ready for Distribution',
    REPLACED_WITH_NEW_VERSION: 'Replaced With New Version',
    REMOVED_FROM_SALE: 'Removed From Sale',
    DEVELOPER_REMOVED_FROM_SALE: 'Removed From Sale',
    PREORDER_READY_FOR_SALE: 'Pre-Order Ready for Sale',
    ACCEPTED: 'Accepted',
  };
  return map[state] ?? state.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}
