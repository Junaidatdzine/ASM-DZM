import type { Platform } from './types';
import type { InfoField, MetadataField, VersionField } from './limits';
import { FIELD_SPECS } from './limits';

/**
 * Draft docs store one flat map of edited values. Keys encode the target resource:
 *   info__name                       → appInfoLocalization.name
 *   versions__IOS__description      → appStoreVersionLocalization.description (iOS branch)
 * Double underscore is used because '.' is a Firestore field-path separator.
 */
export type FieldKey = string;

export function infoKey(field: InfoField): FieldKey {
  return `info__${field}`;
}

export function versionKey(platform: Platform, field: VersionField): FieldKey {
  return `versions__${platform}__${field}`;
}

export function fieldKeyFor(platform: Platform, field: MetadataField): FieldKey {
  return FIELD_SPECS[field].target === 'info'
    ? infoKey(field as InfoField)
    : versionKey(platform, field as VersionField);
}

export interface DecodedFieldKey {
  target: 'info' | 'version';
  platform: Platform | null;
  field: MetadataField;
}

export function decodeFieldKey(key: FieldKey): DecodedFieldKey | null {
  const parts = key.split('__');
  if (parts[0] === 'info' && parts.length === 2) {
    const field = parts[1] as MetadataField;
    if (FIELD_SPECS[field]?.target === 'info') return { target: 'info', platform: null, field };
    return null;
  }
  if (parts[0] === 'versions' && parts.length === 3) {
    const platform = parts[1] as Platform;
    const field = parts[2] as MetadataField;
    if (FIELD_SPECS[field]?.target === 'version') return { target: 'version', platform, field };
    return null;
  }
  return null;
}
