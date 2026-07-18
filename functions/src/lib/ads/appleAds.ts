import { SignJWT, importPKCS8 } from 'jose';
import { isEmulator } from '../../config';
import { AppError } from '../errors';

const TOKEN_URL = 'https://appleid.apple.com/auth/oauth2/token';
const API_BASE = 'https://api.searchads.apple.com/api/v5';

export interface AppleAdsCredentials {
  clientId: string; // SEARCHADS.xxxxxxxx
  teamId: string; // SEARCHADS.xxxxxxxx (API user team id)
  keyId: string;
  privateKey: string; // EC P-256 PEM (PKCS8)
  orgId: number;
}

/** One campaign's metrics for one day. */
export interface AppleAdsDayRow {
  date: string; // YYYY-MM-DD
  campaignId: string;
  campaignName: string;
  spendAmount: number;
  spendCurrency: string;
  taps: number;
  impressions: number;
  installs: number;
}

const tokenCache = new Map<string, { token: string; exp: number }>();

/** Client-credentials flow: the client_secret is an ES256 JWT signed with the API key. */
export async function appleAdsToken(creds: AppleAdsCredentials): Promise<string> {
  const cacheKey = `${creds.clientId}:${creds.keyId}`;
  const cached = tokenCache.get(cacheKey);
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.exp - now > 120) return cached.token;

  const key = await importPKCS8(creds.privateKey, 'ES256').catch(() => {
    throw new AppError(
      'invalid-argument',
      'The Apple Ads private key is not valid PKCS8 — paste the full PEM including BEGIN/END lines.',
    );
  });
  const clientSecret = await new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: creds.keyId })
    .setIssuer(creds.teamId)
    .setSubject(creds.clientId)
    .setAudience('https://appleid.apple.com')
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(key);

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      scope: 'searchadsorg',
      client_id: creds.clientId,
      client_secret: clientSecret,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new AppError(
      'failed-precondition',
      `Apple rejected the Search Ads credentials (${res.status}). Check client ID, team ID, key ID and the private key. ${body.slice(0, 120)}`,
    );
  }
  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw new AppError('internal', 'Apple returned no Search Ads access token.');
  tokenCache.set(cacheKey, { token: json.access_token, exp: now + (json.expires_in ?? 3600) });
  return json.access_token;
}

async function api<T>(
  creds: AppleAdsCredentials,
  path: string,
  body?: unknown,
  method?: 'GET' | 'POST' | 'PUT',
): Promise<T> {
  const token = await appleAdsToken(creds);
  const res = await fetch(`${API_BASE}${path}`, {
    method: method ?? (body ? 'POST' : 'GET'),
    headers: {
      Authorization: `Bearer ${token}`,
      'X-AP-Context': `orgId=${creds.orgId}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (res.status === 401 || res.status === 403) {
      throw new AppError(
        'failed-precondition',
        `Apple Search Ads rejected the request (${res.status}) — check the org ID and that the API user has read access.`,
      );
    }
    throw new AppError('internal', `Apple Search Ads error ${res.status}: ${text.slice(0, 160)}`);
  }
  return (await res.json()) as T;
}

/** Cheap probe used at connect time: the org's campaign count. */
export async function appleAdsVerify(creds: AppleAdsCredentials): Promise<{ campaignsCount: number }> {
  if (isEmulator()) return { campaignsCount: 2 };
  const doc = await api<{ pagination?: { totalResults?: number } }>(
    creds,
    '/campaigns?limit=1&offset=0',
  );
  return { campaignsCount: doc.pagination?.totalResults ?? 0 };
}

export interface AppleAdsCampaign {
  id: string;
  name: string;
  status: string; // ENABLED | PAUSED
  servingStatus?: string;
  dailyBudget: { amount: number; currency: string } | null;
  countries: string[];
}

// Emulator-only mutable campaign statuses so the pause/resume flow is testable offline.
const mockStatuses = new Map<string, string>();

function mockCampaigns(): AppleAdsCampaign[] {
  return [
    {
      id: 'mock-c1',
      name: 'AI Detector — US Search',
      status: mockStatuses.get('mock-c1') ?? 'ENABLED',
      servingStatus: 'RUNNING',
      dailyBudget: { amount: 40, currency: 'USD' },
      countries: ['US'],
    },
    {
      id: 'mock-c2',
      name: 'Vocabulary — Worldwide',
      status: mockStatuses.get('mock-c2') ?? 'PAUSED',
      servingStatus: 'CAMPAIGN_ON_HOLD',
      dailyBudget: { amount: 15, currency: 'USD' },
      countries: ['US', 'GB', 'PK'],
    },
  ];
}

/** Every campaign in the org with its live status and budget. */
export async function appleAdsCampaigns(creds: AppleAdsCredentials): Promise<AppleAdsCampaign[]> {
  if (isEmulator()) return mockCampaigns();
  const out: AppleAdsCampaign[] = [];
  for (let offset = 0; offset < 2000; offset += 200) {
    const doc = await api<{
      data?: Array<{
        id?: number;
        name?: string;
        status?: string;
        servingStatus?: string;
        dailyBudgetAmount?: { amount?: string; currency?: string } | null;
        countriesOrRegions?: string[];
      }>;
      pagination?: { totalResults?: number };
    }>(creds, `/campaigns?limit=200&offset=${offset}`);
    for (const c of doc.data ?? []) {
      out.push({
        id: String(c.id ?? ''),
        name: c.name ?? String(c.id ?? ''),
        status: c.status ?? 'ENABLED',
        servingStatus: c.servingStatus,
        dailyBudget: c.dailyBudgetAmount?.amount
          ? { amount: Number(c.dailyBudgetAmount.amount) || 0, currency: c.dailyBudgetAmount.currency ?? 'USD' }
          : null,
        countries: c.countriesOrRegions ?? [],
      });
    }
    if ((doc.pagination?.totalResults ?? 0) <= offset + 200) break;
  }
  return out;
}

/** Run or stop a campaign. */
export async function appleAdsSetCampaignStatus(
  creds: AppleAdsCredentials,
  campaignId: string,
  status: 'ENABLED' | 'PAUSED',
): Promise<void> {
  if (isEmulator()) {
    mockStatuses.set(campaignId, status);
    return;
  }
  await api(creds, `/campaigns/${campaignId}`, { campaign: { status } }, 'PUT');
}

interface ReportRow {
  metadata?: { campaignId?: number; campaignName?: string };
  granularity?: Array<{
    date?: string;
    localSpend?: { amount?: string; currency?: string };
    taps?: number;
    impressions?: number;
    totalInstalls?: number;
    tapInstalls?: number;
    viewInstalls?: number;
  }>;
}

/** Map one API report row into flat per-day rows. Exported for tests. */
export function mapAppleAdsRow(row: ReportRow): AppleAdsDayRow[] {
  const out: AppleAdsDayRow[] = [];
  const id = String(row.metadata?.campaignId ?? '');
  const name = row.metadata?.campaignName ?? id;
  for (const g of row.granularity ?? []) {
    if (!g.date) continue;
    out.push({
      date: g.date,
      campaignId: id,
      campaignName: name,
      spendAmount: Number(g.localSpend?.amount ?? 0) || 0,
      spendCurrency: (g.localSpend?.currency ?? 'USD').trim() || 'USD',
      taps: g.taps ?? 0,
      impressions: g.impressions ?? 0,
      installs: g.totalInstalls ?? (g.tapInstalls ?? 0) + (g.viewInstalls ?? 0),
    });
  }
  return out;
}

/** Deterministic offline spend so the dashboard is testable without credentials. */
function mockRows(startDate: string, endDate: string): AppleAdsDayRow[] {
  const rows: AppleAdsDayRow[] = [];
  const campaigns = [
    { id: 'mock-c1', name: 'AI Detector — US Search' },
    { id: 'mock-c2', name: 'Vocabulary — Worldwide' },
  ];
  for (let t = Date.parse(startDate); t <= Date.parse(endDate); t += 86_400_000) {
    const date = new Date(t).toISOString().slice(0, 10);
    let h = 0;
    for (let i = 0; i < date.length; i++) h = (h * 31 + date.charCodeAt(i)) | 0;
    campaigns.forEach((c, idx) => {
      const x = Math.abs(Math.sin(h + idx) * 1000) % 1;
      rows.push({
        date,
        campaignId: c.id,
        campaignName: c.name,
        spendAmount: Math.round((8 + x * 30) * 100) / 100,
        spendCurrency: 'USD',
        taps: Math.round(40 + x * 200),
        impressions: Math.round(900 + x * 4000),
        installs: Math.round(10 + x * 60),
      });
    });
  }
  return rows;
}

/** Daily campaign report for [startDate, endDate] (inclusive, ≤90 days). */
export async function appleAdsDailyReport(
  creds: AppleAdsCredentials,
  startDate: string,
  endDate: string,
): Promise<AppleAdsDayRow[]> {
  if (isEmulator()) return mockRows(startDate, endDate);
  const doc = await api<{ data?: { reportingDataResponse?: { row?: ReportRow[] } } }>(
    creds,
    '/reports/campaigns',
    {
      startTime: startDate,
      endTime: endDate,
      granularity: 'DAILY',
      timeZone: 'UTC',
      returnRecordsWithNoMetrics: false,
      returnRowTotals: false,
      returnGrandTotals: false,
      selector: {
        orderBy: [{ field: 'campaignId', sortOrder: 'ASCENDING' }],
        pagination: { offset: 0, limit: 1000 },
      },
    },
  );
  return (doc.data?.reportingDataResponse?.row ?? []).flatMap((row) => mapAppleAdsRow(row));
}
