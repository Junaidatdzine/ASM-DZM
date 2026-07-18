import { describe, expect, it } from 'vitest';
import type { AppDoc, DraftDoc, LocaleDoc } from '../../shared/src/index';
import { targetCurrentValue } from './callable/ai';

/** Fresh-version scenario: editable branch empty, previous release still live. */
const app = {
  appInfo: { editableId: 'info-1', editableState: 'PREPARE_FOR_SUBMISSION', liveId: 'info-0' },
  versions: {
    IOS: {
      editable: { id: 'v2', versionString: '1.0.5', state: 'PREPARE_FOR_SUBMISSION' },
      live: { id: 'v1', versionString: '1.0.4', state: 'READY_FOR_SALE' },
    },
  },
} as unknown as AppDoc;

const locale = {
  info: {
    editable: { name: 'PetFun', subtitle: '' },
    live: { name: 'PetFun', subtitle: 'Old subtitle' },
    ids: { editable: 'il-e', live: 'il-l' },
  },
  versions: {
    IOS: {
      editable: { description: 'Copied desc', whatsNew: '', promotionalText: '' },
      live: { description: 'Copied desc', whatsNew: 'OLD release notes from 1.0.4', promotionalText: 'Live promo' },
      ids: { editable: 'vl-e', live: 'vl-l' },
    },
  },
} as unknown as LocaleDoc;

describe('targetCurrentValue (fill-missing semantics)', () => {
  it('reports empty for a fresh version even when the old live value exists — the Indonesian/Malay bug', () => {
    // sourceValue-style live fallback would return the 1.0.4 notes and skip the
    // locale forever; the push target is what matters and it is empty.
    expect(targetCurrentValue(app, 'IOS', 'whatsNew', locale, null)).toBe('');
  });

  it('uses the editable value when present', () => {
    expect(targetCurrentValue(app, 'IOS', 'description', locale, null)).toBe('Copied desc');
  });

  it('draft overlay wins over everything', () => {
    const draft = { fields: { versions__IOS__whatsNew: 'Drafted notes' } } as unknown as DraftDoc;
    expect(targetCurrentValue(app, 'IOS', 'whatsNew', locale, draft)).toBe('Drafted notes');
  });

  it('info fields read the editable branch without live fallback', () => {
    expect(targetCurrentValue(app, 'IOS', 'subtitle', locale, null)).toBe('');
  });

  it('promo-on-live special case still reads the live value when no version is editable', () => {
    const liveOnlyApp = {
      ...app,
      appInfo: { editableId: null, editableState: null, liveId: 'info-0' },
      versions: { IOS: { editable: null, live: app.versions.IOS!.live } },
    } as unknown as AppDoc;
    expect(targetCurrentValue(liveOnlyApp, 'IOS', 'promotionalText', locale, null)).toBe('Live promo');
  });
});
