import { describe, expect, it } from 'vitest';
import { ALL_FIELDS, fieldStatus, type AppDoc } from '../../shared/src/index';

describe('metadata field visibility', () => {
  it('keeps every metadata field visible on a first release', () => {
    const app = {
      appInfo: { editableId: 'info-1', editableState: 'PREPARE_FOR_SUBMISSION' },
      versions: {
        IOS: {
          editable: { id: 'version-1', versionString: '1.0', state: 'PREPARE_FOR_SUBMISSION' },
          live: null,
        },
      },
    } as unknown as AppDoc;

    // name, subtitle, 2 privacy URLs + 6 version fields
    expect(ALL_FIELDS).toHaveLength(10);
    for (const field of ALL_FIELDS) {
      expect(fieldStatus(app, 'IOS', field).visible).toBe(true);
    }
    expect(fieldStatus(app, 'IOS', 'whatsNew')).toMatchObject({
      editable: false,
      pushTarget: null,
      visible: true,
    });
    expect(fieldStatus(app, 'IOS', 'whatsNew').lockReason).toContain('first version');
  });
});
