import { fieldKeyFor } from './fieldKeys';
import type { AppDoc, DraftDoc, LocaleDoc, Platform } from './types';

/**
 * Name shown throughout the portal. The primary localization is authoritative;
 * a local draft wins so the UI updates immediately before the next push/sync.
 */
export function primaryLocalizedAppName(
  app: AppDoc,
  platform: Platform,
  primaryLocale: LocaleDoc | null | undefined,
  primaryDraft: DraftDoc | null | undefined,
): string {
  const draft = primaryDraft?.fields?.[fieldKeyFor(platform, 'name')]?.trim();
  const editable = primaryLocale?.info?.editable?.name?.trim();
  const live = primaryLocale?.info?.live?.name?.trim();
  return draft || editable || live || app.name;
}
