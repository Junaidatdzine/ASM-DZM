/**
 * App Store screenshot display types and their accepted pixel dimensions.
 * Sourced from Apple's screenshot specifications; update here when Apple adds devices.
 * Each dimension pair is [width, height]; both orientations are listed explicitly.
 */
export interface ScreenshotSpec {
  displayType: string;
  label: string;
  device: 'iphone' | 'ipad';
  /** Apple requires at least one screenshot for these classes when the app supports the device. */
  required: boolean;
  sizes: Array<[number, number]>;
  /** Sort order in the UI (newest/most relevant first). */
  order: number;
}

const pair = (w: number, h: number): Array<[number, number]> => [
  [w, h],
  [h, w],
];

export const SCREENSHOT_SPECS: ScreenshotSpec[] = [
  {
    displayType: 'APP_IPHONE_69',
    label: 'iPhone 6.9"',
    device: 'iphone',
    required: true,
    sizes: [...pair(1320, 2868), ...pair(1290, 2796)],
    order: 1,
  },
  {
    displayType: 'APP_IPHONE_67',
    label: 'iPhone 6.7"',
    device: 'iphone',
    required: false,
    sizes: pair(1290, 2796),
    order: 2,
  },
  {
    displayType: 'APP_IPHONE_65',
    label: 'iPhone 6.5"',
    device: 'iphone',
    required: false,
    sizes: [...pair(1284, 2778), ...pair(1242, 2688)],
    order: 3,
  },
  {
    displayType: 'APP_IPHONE_61',
    label: 'iPhone 6.1"',
    device: 'iphone',
    required: false,
    sizes: [...pair(1179, 2556), ...pair(1170, 2532), ...pair(828, 1792)],
    order: 4,
  },
  {
    displayType: 'APP_IPHONE_58',
    label: 'iPhone 5.8"',
    device: 'iphone',
    required: false,
    sizes: [...pair(1125, 2436), ...pair(1080, 2340)],
    order: 5,
  },
  {
    displayType: 'APP_IPHONE_55',
    label: 'iPhone 5.5"',
    device: 'iphone',
    required: false,
    sizes: pair(1242, 2208),
    order: 6,
  },
  {
    displayType: 'APP_IPHONE_47',
    label: 'iPhone 4.7"',
    device: 'iphone',
    required: false,
    sizes: pair(750, 1334),
    order: 7,
  },
  {
    displayType: 'APP_IPHONE_40',
    label: 'iPhone 4"',
    device: 'iphone',
    required: false,
    sizes: [[640, 1096], [640, 1136], [1136, 600], [1136, 640]],
    order: 8,
  },
  {
    displayType: 'APP_IPAD_PRO_3GEN_129',
    label: 'iPad 13"',
    device: 'ipad',
    required: true,
    sizes: [...pair(2064, 2752), ...pair(2048, 2732)],
    order: 10,
  },
  {
    displayType: 'APP_IPAD_PRO_3GEN_11',
    label: 'iPad 11"',
    device: 'ipad',
    required: false,
    sizes: [...pair(1668, 2420), ...pair(1668, 2388), ...pair(1640, 2360)],
    order: 11,
  },
  {
    displayType: 'APP_IPAD_PRO_129',
    label: 'iPad 12.9" (2nd gen)',
    device: 'ipad',
    required: false,
    sizes: pair(2048, 2732),
    order: 12,
  },
  {
    displayType: 'APP_IPAD_105',
    label: 'iPad 10.5"',
    device: 'ipad',
    required: false,
    sizes: pair(1668, 2224),
    order: 13,
  },
  {
    displayType: 'APP_IPAD_97',
    label: 'iPad 9.7"',
    device: 'ipad',
    required: false,
    sizes: [
      [1536, 2008],
      [1536, 2048],
      [2048, 1496],
      [2048, 1536],
      [768, 1004],
      [768, 1024],
      [1024, 748],
      [1024, 768],
    ],
    order: 14,
  },
];

const byType = new Map(SCREENSHOT_SPECS.map((s) => [s.displayType, s]));

export function screenshotSpec(displayType: string): ScreenshotSpec | undefined {
  return byType.get(displayType);
}

export function screenshotSpecLabel(displayType: string): string {
  return byType.get(displayType)?.label ?? displayType.replace(/^APP_/, '').replace(/_/g, ' ');
}

export const MAX_SCREENSHOTS_PER_SET = 10;
export const MAX_SCREENSHOT_BYTES = 12 * 1024 * 1024;

export function validateScreenshotDimensions(
  displayType: string,
  width: number,
  height: number,
): string | null {
  const spec = byType.get(displayType);
  if (!spec) return `Unknown screenshot display type: ${displayType}`;
  const ok = spec.sizes.some(([w, h]) => w === width && h === height);
  if (!ok) {
    const accepted = spec.sizes.map(([w, h]) => `${w}×${h}`).join(', ');
    return `${width}×${height} is not valid for ${spec.label}. Accepted: ${accepted}.`;
  }
  return null;
}
