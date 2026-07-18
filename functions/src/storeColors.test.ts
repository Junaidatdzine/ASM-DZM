import { describe, expect, it } from 'vitest';
import {
  SIMILAR_HUE_DEGREES,
  assignDistinctColors,
  colorHue,
  hasSimilarColors,
  hexToHue,
  hslToHex,
  isHexColor,
  nextDistinctColor,
} from '../../shared/src/index';

const dist = (a: number, b: number) => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

describe('unique store colors', () => {
  it('hex helpers roundtrip hues within rounding error', () => {
    for (const hue of [0, 45, 120, 200, 300, 350]) {
      const hex = hslToHex(hue, 72, 50);
      expect(isHexColor(hex)).toBe(true);
      expect(dist(hexToHue(hex), hue)).toBeLessThanOrEqual(2);
    }
  });

  it('assignDistinctColors gives N unique colors with maximal spacing', () => {
    const colors = assignDistinctColors(60);
    expect(new Set(colors).size).toBe(60);
    const hues = colors.map(hexToHue);
    for (let i = 0; i < hues.length; i++) {
      for (let j = i + 1; j < hues.length; j++) {
        // Even spacing of 60 over 360° = 6° apart minimum.
        expect(dist(hues[i]!, hues[j]!)).toBeGreaterThanOrEqual(4);
      }
    }
  });

  it('nextDistinctColor picks a hue far from everything in use', () => {
    const used = ['indigo', 'orange', hslToHex(120, 72, 50)];
    const next = nextDistinctColor(used);
    const nextHue = hexToHue(next);
    for (const u of used) {
      expect(dist(nextHue, colorHue(u)!)).toBeGreaterThanOrEqual(SIMILAR_HUE_DEGREES);
    }
  });

  it('hasSimilarColors flags duplicates, similar hues, and unset colors', () => {
    expect(hasSimilarColors(['orange', 'orange'])).toBe(true);
    expect(hasSimilarColors(['orange', hslToHex(colorHue('orange')! + 5, 72, 50)])).toBe(true);
    expect(hasSimilarColors(['orange', undefined])).toBe(true);
    expect(hasSimilarColors(assignDistinctColors(12))).toBe(false);
    expect(hasSimilarColors(['orange'])).toBe(false);
  });
});
