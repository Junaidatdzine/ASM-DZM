import { describe, expect, it } from 'vitest';
import {
  APP_STORE_CONNECT_API_LOCALES,
  APP_STORE_CONNECT_API_PENDING_LOCALE_CODES,
  APP_STORE_LOCALES,
  isAppStoreConnectApiLocale,
  isKnownLocale,
} from '../../shared/src/index';

describe('App Store localization capabilities', () => {
  it('preserves all 50 Apple-supported locales for sync and existing metadata', () => {
    expect(APP_STORE_LOCALES).toHaveLength(50);
    expect(new Set(APP_STORE_LOCALES.map((locale) => locale.code)).size).toBe(50);
    for (const code of APP_STORE_CONNECT_API_PENDING_LOCALE_CODES) {
      expect(isKnownLocale(code)).toBe(true);
    }
  });

  it('offers only the 39 locales accepted by Apple public create endpoints', () => {
    expect(APP_STORE_CONNECT_API_LOCALES).toHaveLength(39);
    expect(new Set(APP_STORE_CONNECT_API_LOCALES.map((locale) => locale.code)).size).toBe(39);
    for (const locale of APP_STORE_CONNECT_API_LOCALES) {
      expect(isAppStoreConnectApiLocale(locale.code)).toBe(true);
    }
  });

  it('blocks every locale currently rejected by Apple public create endpoints', () => {
    expect(APP_STORE_CONNECT_API_PENDING_LOCALE_CODES).toHaveLength(11);
    for (const code of APP_STORE_CONNECT_API_PENDING_LOCALE_CODES) {
      expect(isAppStoreConnectApiLocale(code)).toBe(false);
    }
  });
});
