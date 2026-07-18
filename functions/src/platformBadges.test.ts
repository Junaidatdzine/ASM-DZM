import { describe, expect, it } from 'vitest';
import { deriveDevices } from './lib/appleLookup';
import { mapAppsWithPlatforms } from './lib/asc/client';

describe('deriveDevices', () => {
  it('reads a universal iOS listing as iPhone + iPad, ignoring Apple-Silicon Mac compat', () => {
    expect(
      deriveDevices({
        kind: 'software',
        features: ['iosUniversal'],
        supportedDevices: ['MacDesktop-MacDesktop', 'iPhone5s-iPhone5s', 'iPadAir-iPadAir'],
      }).sort(),
    ).toEqual(['ipad', 'iphone']);
  });

  it('reads an iPhone-only listing without inventing iPad support', () => {
    expect(deriveDevices({ kind: 'software', supportedDevices: ['iPhone13,2', 'iPod9,1'] })).toEqual(['iphone']);
  });

  it('maps mac-software to mac even with no supportedDevices', () => {
    expect(deriveDevices({ kind: 'mac-software' })).toEqual(['mac']);
  });

  it('detects watch and vision devices', () => {
    expect(
      deriveDevices({ kind: 'software', supportedDevices: ['iPhone13,2', 'Watch6,1', 'RealityDevice14,1'] }).sort(),
    ).toEqual(['iphone', 'vision', 'watch']);
  });

  it('returns nothing for an empty listing', () => {
    expect(deriveDevices({})).toEqual([]);
  });
});

describe('mapAppsWithPlatforms', () => {
  it('unions included appStoreVersions platforms per app', () => {
    const rows = [
      {
        id: 'app1',
        attributes: { bundleId: 'com.a', name: 'A', primaryLocale: 'en-US' },
        relationships: { appStoreVersions: { data: [{ id: 'v1', type: 'appStoreVersions' }, { id: 'v2', type: 'appStoreVersions' }, { id: 'v3', type: 'appStoreVersions' }] } },
      },
      { id: 'app2', attributes: { bundleId: 'com.b', name: 'B', primaryLocale: 'en-US' } },
    ];
    const included = [
      { id: 'v1', type: 'appStoreVersions', attributes: { platform: 'IOS' } },
      { id: 'v2', type: 'appStoreVersions', attributes: { platform: 'IOS' } },
      { id: 'v3', type: 'appStoreVersions', attributes: { platform: 'MAC_OS' } },
    ];
    const apps = mapAppsWithPlatforms(rows, included);
    expect(apps[0]!.platforms).toEqual(['IOS', 'MAC_OS']);
    expect(apps[1]!.platforms).toEqual([]);
  });

  it('drops unknown platform strings instead of storing garbage', () => {
    const apps = mapAppsWithPlatforms(
      [{ id: 'a', attributes: { bundleId: 'x', name: 'X', primaryLocale: 'en-US' }, relationships: { appStoreVersions: { data: [{ id: 'v', type: 'appStoreVersions' }] } } }],
      [{ id: 'v', type: 'appStoreVersions', attributes: { platform: 'ANDROID?' } }],
    );
    expect(apps[0]!.platforms).toEqual([]);
  });
});
