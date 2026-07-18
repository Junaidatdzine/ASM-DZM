/** The App Store locale catalog (App Store Connect localization codes). */
export interface AppStoreLocale {
  code: string;
  name: string;
  flag: string;
}

export const APP_STORE_LOCALES: AppStoreLocale[] = [
  { code: 'ar-SA', name: 'Arabic', flag: '🇸🇦' },
  { code: 'bn', name: 'Bangla', flag: '🇮🇳' },
  { code: 'ca', name: 'Catalan', flag: '🇪🇸' },
  { code: 'zh-Hans', name: 'Chinese (Simplified)', flag: '🇨🇳' },
  { code: 'zh-Hant', name: 'Chinese (Traditional)', flag: '🇹🇼' },
  { code: 'hr', name: 'Croatian', flag: '🇭🇷' },
  { code: 'cs', name: 'Czech', flag: '🇨🇿' },
  { code: 'da', name: 'Danish', flag: '🇩🇰' },
  { code: 'nl-NL', name: 'Dutch', flag: '🇳🇱' },
  { code: 'en-AU', name: 'English (Australia)', flag: '🇦🇺' },
  { code: 'en-CA', name: 'English (Canada)', flag: '🇨🇦' },
  { code: 'en-GB', name: 'English (U.K.)', flag: '🇬🇧' },
  { code: 'en-US', name: 'English (U.S.)', flag: '🇺🇸' },
  { code: 'fi', name: 'Finnish', flag: '🇫🇮' },
  { code: 'fr-FR', name: 'French', flag: '🇫🇷' },
  { code: 'fr-CA', name: 'French (Canada)', flag: '🇨🇦' },
  { code: 'de-DE', name: 'German', flag: '🇩🇪' },
  { code: 'el', name: 'Greek', flag: '🇬🇷' },
  { code: 'gu', name: 'Gujarati', flag: '🇮🇳' },
  { code: 'he', name: 'Hebrew', flag: '🇮🇱' },
  { code: 'hi', name: 'Hindi', flag: '🇮🇳' },
  { code: 'hu', name: 'Hungarian', flag: '🇭🇺' },
  { code: 'id', name: 'Indonesian', flag: '🇮🇩' },
  { code: 'it', name: 'Italian', flag: '🇮🇹' },
  { code: 'ja', name: 'Japanese', flag: '🇯🇵' },
  { code: 'kn', name: 'Kannada', flag: '🇮🇳' },
  { code: 'ko', name: 'Korean', flag: '🇰🇷' },
  { code: 'ms', name: 'Malay', flag: '🇲🇾' },
  { code: 'ml', name: 'Malayalam', flag: '🇮🇳' },
  { code: 'mr', name: 'Marathi', flag: '🇮🇳' },
  { code: 'no', name: 'Norwegian', flag: '🇳🇴' },
  { code: 'or', name: 'Odia', flag: '🇮🇳' },
  { code: 'pl', name: 'Polish', flag: '🇵🇱' },
  { code: 'pt-BR', name: 'Portuguese (Brazil)', flag: '🇧🇷' },
  { code: 'pt-PT', name: 'Portuguese (Portugal)', flag: '🇵🇹' },
  { code: 'pa', name: 'Punjabi', flag: '🇮🇳' },
  { code: 'ro', name: 'Romanian', flag: '🇷🇴' },
  { code: 'ru', name: 'Russian', flag: '🇷🇺' },
  { code: 'sk', name: 'Slovak', flag: '🇸🇰' },
  { code: 'sl', name: 'Slovenian', flag: '🇸🇮' },
  { code: 'es-MX', name: 'Spanish (Mexico)', flag: '🇲🇽' },
  { code: 'es-ES', name: 'Spanish (Spain)', flag: '🇪🇸' },
  { code: 'sv', name: 'Swedish', flag: '🇸🇪' },
  { code: 'ta', name: 'Tamil', flag: '🇮🇳' },
  { code: 'te', name: 'Telugu', flag: '🇮🇳' },
  { code: 'th', name: 'Thai', flag: '🇹🇭' },
  { code: 'tr', name: 'Turkish', flag: '🇹🇷' },
  { code: 'uk', name: 'Ukrainian', flag: '🇺🇦' },
  { code: 'ur', name: 'Urdu', flag: '🇵🇰' },
  { code: 'vi', name: 'Vietnamese', flag: '🇻🇳' },
];

/**
 * Locales announced by Apple in March 2026 that are available in the App Store
 * Connect web UI, but are still rejected by the public App Store Connect API
 * localization-create endpoints (for example: "'bn' is not a valid locale").
 *
 * Keep them in APP_STORE_LOCALES so synced/manual Apple data is preserved and
 * can still be translated. Exclude them only from automated locale creation
 * until Apple's public API accepts them.
 */
export const APP_STORE_CONNECT_API_PENDING_LOCALE_CODES = [
  'bn',
  'gu',
  'kn',
  'ml',
  'mr',
  'or',
  'pa',
  'sl',
  'ta',
  'te',
  'ur',
] as const;

const apiPendingCodes = new Set<string>(APP_STORE_CONNECT_API_PENDING_LOCALE_CODES);

/** Locales that Apple's public API can currently create programmatically. */
export const APP_STORE_CONNECT_API_LOCALES = APP_STORE_LOCALES.filter(
  (locale) => !apiPendingCodes.has(locale.code),
);

const byCode = new Map(APP_STORE_LOCALES.map((l) => [l.code, l]));

export function localeInfo(code: string): AppStoreLocale {
  return byCode.get(code) ?? { code, name: code, flag: '🌐' };
}

export function localeName(code: string): string {
  return localeInfo(code).name;
}

export function isKnownLocale(code: string): boolean {
  return byCode.has(code);
}

export function isAppStoreConnectApiLocale(code: string): boolean {
  return byCode.has(code) && !apiPendingCodes.has(code);
}

/** Sort locale codes alphabetically by display name, with the given primary first. */
export function sortLocales(codes: string[], primary?: string): string[] {
  return [...codes].sort((a, b) => {
    if (a === primary) return -1;
    if (b === primary) return 1;
    return localeName(a).localeCompare(localeName(b));
  });
}
