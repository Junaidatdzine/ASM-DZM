/**
 * App Store storefronts Apple Ads can serve in, grouped for quick selection.
 * Codes are ISO 3166-1 alpha-2; display names come from Intl.DisplayNames at
 * render time so nothing here needs translating.
 */

export interface AdsRegion {
  key: string;
  label: string;
  codes: string[];
}

export const ADS_REGIONS: AdsRegion[] = [
  { key: 'na', label: 'North America', codes: ['US', 'CA', 'MX'] },
  {
    key: 'eu',
    label: 'Europe',
    codes: [
      'GB', 'DE', 'FR', 'IT', 'ES', 'NL', 'SE', 'NO', 'DK', 'FI', 'IE', 'AT', 'CH', 'BE',
      'PT', 'PL', 'CZ', 'HU', 'GR', 'RO', 'SK', 'HR', 'UA', 'AL', 'AZ',
    ],
  },
  {
    key: 'apac',
    label: 'Asia Pacific',
    codes: [
      'AU', 'NZ', 'JP', 'KR', 'CN', 'HK', 'TW', 'SG', 'MY', 'TH', 'VN', 'PH', 'ID', 'IN',
      'PK', 'KZ', 'KH', 'MO',
    ],
  },
  {
    key: 'latam',
    label: 'Latin America',
    codes: ['BR', 'AR', 'CL', 'CO', 'PE', 'EC', 'CR', 'DO', 'GT', 'PA', 'PY', 'BO', 'HN', 'SV'],
  },
  {
    key: 'mea',
    label: 'Middle East & Africa',
    codes: ['AE', 'SA', 'QA', 'KW', 'BH', 'OM', 'IL', 'JO', 'LB', 'EG', 'ZA', 'NG', 'KE', 'MA', 'DZ', 'TN', 'TR'],
  },
];

/** The markets that drive most App Store revenue — the sensible default set. */
export const ADS_TOP_MARKETS = ['US', 'GB', 'CA', 'AU', 'DE', 'FR', 'JP', 'KR'];

export const ALL_ADS_COUNTRIES: string[] = ADS_REGIONS.flatMap((r) => r.codes);
