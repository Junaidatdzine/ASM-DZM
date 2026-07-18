import type { AppDoc, DraftDoc, LocaleDoc, Platform } from '@asm/shared';
import {
  FIELD_SPECS,
  fieldKeyFor,
  fieldStatus,
  type FieldStatus,
  type InfoField,
  type MetadataField,
} from '@asm/shared';

/** The remote value a push would overwrite for this field (the draft's conflict base). */
export function cacheValue(
  locale: LocaleDoc | null,
  platform: Platform,
  field: MetadataField,
  status: FieldStatus,
): string {
  if (!locale) return '';
  const spec = FIELD_SPECS[field];
  if (spec.target === 'info') {
    return locale.info?.editable?.[field as InfoField] ?? '';
  }
  const branch = locale.versions?.[platform];
  if (!branch) return '';
  if (status.pushTarget === 'livePromo') {
    return branch.live?.promotionalText ?? '';
  }
  return (branch.editable?.[field as keyof NonNullable<typeof branch.editable>] as string | undefined) ?? '';
}

/** Read-only fallback shown when a field has no editable target. */
export function lockedDisplayValue(
  locale: LocaleDoc | null,
  platform: Platform,
  field: MetadataField,
): string {
  if (!locale) return '';
  const spec = FIELD_SPECS[field];
  if (spec.target === 'info') {
    return locale.info?.editable?.[field as InfoField] ?? locale.info?.live?.[field as InfoField] ?? '';
  }
  const branch = locale.versions?.[platform];
  if (!branch) return '';
  const key = field as keyof NonNullable<typeof branch.live>;
  return ((branch.editable?.[key] ?? branch.live?.[key]) as string | undefined) ?? '';
}

export interface FieldView {
  field: MetadataField;
  key: string;
  status: FieldStatus;
  /** Current effective value (draft overlay or cache). */
  value: string;
  cache: string;
  isDraft: boolean;
  draftBy?: string;
  draftAi?: boolean;
  conflict: boolean;
}

export function buildFieldViews(
  app: AppDoc,
  platform: Platform,
  locale: LocaleDoc | null,
  draft: DraftDoc | null,
  fields: MetadataField[],
): FieldView[] {
  return fields
    .map((field) => {
      const status = fieldStatus(app, platform, field);
      const key = fieldKeyFor(platform, field);
      const cache = cacheValue(locale, platform, field, status);
      const draftValue = draft?.fields?.[key];
      const isDraft = draftValue !== undefined;
      const base = draft?.base?.[key];
      // A conflict means pushing would overwrite someone else's store change. When the
      // remote value is now EMPTY (e.g. What's New resets on every new version), there
      // is nothing to lose — treat the draft as clean instead of alarming the user.
      const conflict =
        isDraft && base !== undefined && base !== cache && draftValue !== cache && cache.trim() !== '';
      return {
        field,
        key,
        status,
        value: isDraft ? draftValue : status.editable ? cache : lockedDisplayValue(locale, platform, field),
        cache,
        isDraft,
        draftBy: draft?.meta?.[key]?.by,
        draftAi: draft?.meta?.[key]?.ai,
        conflict,
      } satisfies FieldView;
    })
    .filter((v) => v.status.visible);
}

/** Coverage % used in the locale rail — core store-listing fields with content. */
export function localeCompletion(
  app: AppDoc,
  platform: Platform,
  locale: LocaleDoc | null,
  draft: DraftDoc | null,
): number {
  const core: MetadataField[] = ['name', 'subtitle', 'description', 'keywords'];
  let filled = 0;
  for (const field of core) {
    const status = fieldStatus(app, platform, field);
    const key = fieldKeyFor(platform, field);
    const value = draft?.fields?.[key] ?? cacheValue(locale, platform, field, status) ?? '';
    const fallback = value || lockedDisplayValue(locale, platform, field);
    if (fallback.trim() !== '') filled += 1;
  }
  return Math.round((filled / core.length) * 100);
}

export function draftCount(draft: DraftDoc | null): number {
  return draft ? Object.keys(draft.fields ?? {}).length : 0;
}
