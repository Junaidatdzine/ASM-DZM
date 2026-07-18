import { describe, expect, it } from 'vitest';
import { primaryLocalizedAppName, type AppDoc, type DraftDoc, type LocaleDoc } from '../../shared/src/index';

const app = { name: 'Stale app record', primaryLocale: 'en-US' } as AppDoc;
const locale = {
  info: {
    editable: { name: 'Current Apple name' },
    live: { name: 'Live fallback name' },
  },
} as LocaleDoc;

describe('primary localized app name', () => {
  it('uses the current primary App Store localization instead of a stale app record', () => {
    expect(primaryLocalizedAppName(app, 'IOS', locale, null)).toBe('Current Apple name');
  });

  it('updates immediately from a primary-locale draft', () => {
    const draft = { fields: { info__name: 'Draft primary name' } } as unknown as DraftDoc;
    expect(primaryLocalizedAppName(app, 'IOS', locale, draft)).toBe('Draft primary name');
  });

  it('falls back safely when localization data is unavailable', () => {
    expect(primaryLocalizedAppName(app, 'IOS', null, null)).toBe('Stale app record');
  });
});
