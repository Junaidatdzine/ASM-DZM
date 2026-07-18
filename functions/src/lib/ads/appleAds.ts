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
  /** RUNNING | ON_HOLD | PAUSED | DELETED — the state Apple actually serves by. */
  displayStatus?: string;
  /** Raw serving-state reasons (e.g. CREDIT_CARD_DECLINED). */
  servingStateReasons?: string[];
  /** The promoted app's App Store id. */
  adamId?: number;
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
      displayStatus: 'RUNNING',
      adamId: 6754688919,
      dailyBudget: { amount: 40, currency: 'USD' },
      countries: ['US'],
    },
    {
      id: 'mock-c2',
      name: 'Vocabulary — Worldwide',
      status: mockStatuses.get('mock-c2') ?? 'PAUSED',
      servingStatus: 'NOT_RUNNING',
      displayStatus: 'PAUSED',
      servingStateReasons: ['PAUSED_BY_USER'],
      dailyBudget: { amount: 15, currency: 'USD' },
      countries: ['US', 'GB', 'PK'],
    },
    {
      // Demoes the on-hold state Apple shows when billing breaks.
      id: 'mock-c3',
      name: 'Printer Utility — EU',
      status: mockStatuses.get('mock-c3') ?? 'ENABLED',
      servingStatus: 'NOT_RUNNING',
      displayStatus: 'ON_HOLD',
      servingStateReasons: ['CREDIT_CARD_DECLINED'],
      dailyBudget: { amount: 20, currency: 'USD' },
      countries: ['DE', 'FR'],
    },
  ];
}

/** Every campaign in the org with its live status and budget. */
export async function appleAdsCampaigns(creds: AppleAdsCredentials): Promise<AppleAdsCampaign[]> {
  if (isEmulator()) {
    return [
      ...mockCampaigns(),
      ...mockExtraCampaignList().map((c) => ({ ...c, status: mockStatuses.get(c.id) ?? c.status })),
    ];
  }
  const out: AppleAdsCampaign[] = [];
  for (let offset = 0; offset < 2000; offset += 200) {
    const doc = await api<{
      data?: Array<{
        id?: number;
        name?: string;
        status?: string;
        servingStatus?: string;
        displayStatus?: string;
        servingStateReasons?: string[];
        adamId?: number;
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
        displayStatus: c.displayStatus,
        servingStateReasons: c.servingStateReasons ?? [],
        adamId: c.adamId,
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

// ============================================================================
// Campaign management — ad groups, keywords, negatives, create/update, reports.
// All write paths are money-affecting; the UI gates them behind confirmations.
// ============================================================================

const money = (amount: number, currency: string) => ({ amount: amount.toFixed(2), currency });
const readMoney = (m?: { amount?: string; currency?: string } | null) =>
  m?.amount ? { amount: Number(m.amount) || 0, currency: m.currency ?? 'USD' } : null;

export interface AppleAdsAdGroup {
  id: string;
  campaignId: string;
  name: string;
  status: string; // ENABLED | PAUSED
  servingStatus?: string;
  displayStatus?: string;
  servingStateReasons?: string[];
  defaultBid: { amount: number; currency: string } | null;
}
export interface AppleAdsKeyword {
  id: string;
  adGroupId: string;
  text: string;
  matchType: string; // EXACT | BROAD
  status: string; // ACTIVE | PAUSED
  bid: { amount: number; currency: string } | null;
}
export interface AppleAdsNegativeKeyword {
  id: string;
  text: string;
  matchType: string; // EXACT | BROAD
}
/** Range-total metrics for one entity (ad group / keyword / search term). */
export interface AppleAdsMetrics {
  id: string;
  label: string;
  spendAmount: number;
  spendCurrency: string;
  taps: number;
  impressions: number;
  installs: number;
}
export interface AppleAdsCampaignInput {
  name: string;
  adamId: number;
  budgetAmount: { amount: number; currency: string };
  dailyBudgetAmount: { amount: number; currency: string };
  countries: string[];
}
export interface AppleAdsCampaignPatch {
  name?: string;
  status?: 'ENABLED' | 'PAUSED';
  dailyBudgetAmount?: { amount: number; currency: string };
  countries?: string[];
}
export interface AppleAdsAdGroupInput {
  name: string;
  defaultBid: { amount: number; currency: string };
}
export interface AppleAdsKeywordInput {
  text: string;
  matchType: 'EXACT' | 'BROAD';
  bid: { amount: number; currency: string };
}

// ---- Emulator-only mutable state so every create/edit flow is demoable offline ----
let mockCounter = 1000;
const nextMockId = () => `mock-${++mockCounter}`;
const mockExtraCampaigns: AppleAdsCampaign[] = [];
const mockAdGroups = new Map<string, AppleAdsAdGroup[]>();
const mockKeywords = new Map<string, AppleAdsKeyword[]>();
const mockNegatives = new Map<string, AppleAdsNegativeKeyword[]>();
let mockSeeded = false;

function seedMock() {
  if (mockSeeded) return;
  mockSeeded = true;
  mockAdGroups.set('mock-c1', [
    { id: 'mock-ag1', campaignId: 'mock-c1', name: 'Exact — brand', status: 'ENABLED', servingStatus: 'RUNNING', defaultBid: { amount: 1.2, currency: 'USD' } },
    { id: 'mock-ag2', campaignId: 'mock-c1', name: 'Broad — discovery', status: 'ENABLED', servingStatus: 'RUNNING', defaultBid: { amount: 0.8, currency: 'USD' } },
  ]);
  mockAdGroups.set('mock-c2', [
    { id: 'mock-ag3', campaignId: 'mock-c2', name: 'Worldwide — generic', status: 'PAUSED', servingStatus: 'AD_GROUP_PAUSED', defaultBid: { amount: 0.5, currency: 'USD' } },
  ]);
  mockKeywords.set('mock-ag1', [
    { id: 'mock-k1', adGroupId: 'mock-ag1', text: 'ai detector', matchType: 'EXACT', status: 'ACTIVE', bid: { amount: 1.5, currency: 'USD' } },
    { id: 'mock-k2', adGroupId: 'mock-ag1', text: 'humanize ai', matchType: 'EXACT', status: 'ACTIVE', bid: { amount: 1.3, currency: 'USD' } },
  ]);
  mockKeywords.set('mock-ag2', [
    { id: 'mock-k3', adGroupId: 'mock-ag2', text: 'essay checker', matchType: 'BROAD', status: 'ACTIVE', bid: { amount: 0.9, currency: 'USD' } },
    { id: 'mock-k4', adGroupId: 'mock-ag2', text: 'plagiarism checker', matchType: 'BROAD', status: 'PAUSED', bid: { amount: 0.7, currency: 'USD' } },
  ]);
  mockKeywords.set('mock-ag3', [
    { id: 'mock-k5', adGroupId: 'mock-ag3', text: 'vocabulary builder', matchType: 'BROAD', status: 'ACTIVE', bid: { amount: 0.5, currency: 'USD' } },
  ]);
  mockNegatives.set(`c:mock-c1`, [{ id: 'mock-n1', text: 'free', matchType: 'BROAD' }]);
}
export function mockExtraCampaignList(): AppleAdsCampaign[] {
  return mockExtraCampaigns;
}
function mockMetric(id: string, label: string): AppleAdsMetrics {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  const x = Math.abs(Math.sin(h) * 1000) % 1;
  return {
    id,
    label,
    spendAmount: Math.round((5 + x * 40) * 100) / 100,
    spendCurrency: 'USD',
    taps: Math.round(20 + x * 180),
    impressions: Math.round(600 + x * 3000),
    installs: Math.round(4 + x * 40),
  };
}

// ---- Ad groups ----

export async function appleAdsAdGroups(creds: AppleAdsCredentials, campaignId: string): Promise<AppleAdsAdGroup[]> {
  if (isEmulator()) {
    seedMock();
    return mockAdGroups.get(campaignId) ?? [];
  }
  const out: AppleAdsAdGroup[] = [];
  for (let offset = 0; offset < 2000; offset += 200) {
    const doc = await api<{
      data?: Array<{ id?: number; name?: string; status?: string; servingStatus?: string; displayStatus?: string; servingStateReasons?: string[]; defaultBidAmount?: { amount?: string; currency?: string } }>;
      pagination?: { totalResults?: number };
    }>(creds, `/campaigns/${campaignId}/adgroups?limit=200&offset=${offset}`);
    for (const g of doc.data ?? []) {
      out.push({
        id: String(g.id ?? ''),
        campaignId,
        name: g.name ?? String(g.id ?? ''),
        status: g.status ?? 'ENABLED',
        servingStatus: g.servingStatus,
        displayStatus: g.displayStatus,
        servingStateReasons: g.servingStateReasons ?? [],
        defaultBid: readMoney(g.defaultBidAmount),
      });
    }
    if ((doc.pagination?.totalResults ?? 0) <= offset + 200) break;
  }
  return out;
}

export async function appleAdsCreateAdGroup(
  creds: AppleAdsCredentials,
  campaignId: string,
  input: AppleAdsAdGroupInput,
): Promise<AppleAdsAdGroup> {
  if (isEmulator()) {
    seedMock();
    const group: AppleAdsAdGroup = {
      id: nextMockId(),
      campaignId,
      name: input.name,
      status: 'ENABLED',
      servingStatus: 'RUNNING',
      defaultBid: input.defaultBid,
    };
    mockAdGroups.set(campaignId, [...(mockAdGroups.get(campaignId) ?? []), group]);
    return group;
  }
  const doc = await api<{ data?: { id?: number } }>(creds, `/campaigns/${campaignId}/adgroups`, {
    name: input.name,
    startTime: new Date().toISOString().slice(0, 19) + '.000',
    defaultBidAmount: money(input.defaultBid.amount, input.defaultBid.currency),
    pricingModel: 'CPC',
  });
  return { id: String(doc.data?.id ?? ''), campaignId, name: input.name, status: 'ENABLED', defaultBid: input.defaultBid };
}

export async function appleAdsUpdateAdGroup(
  creds: AppleAdsCredentials,
  campaignId: string,
  adGroupId: string,
  patch: { name?: string; status?: 'ENABLED' | 'PAUSED'; defaultBid?: { amount: number; currency: string } },
): Promise<void> {
  if (isEmulator()) {
    seedMock();
    const groups = mockAdGroups.get(campaignId) ?? [];
    const g = groups.find((x) => x.id === adGroupId);
    if (g) {
      if (patch.name !== undefined) g.name = patch.name;
      if (patch.status !== undefined) g.status = patch.status;
      if (patch.defaultBid !== undefined) g.defaultBid = patch.defaultBid;
    }
    return;
  }
  const body: Record<string, unknown> = {};
  if (patch.name !== undefined) body.name = patch.name;
  if (patch.status !== undefined) body.status = patch.status;
  if (patch.defaultBid !== undefined) body.defaultBidAmount = money(patch.defaultBid.amount, patch.defaultBid.currency);
  await api(creds, `/campaigns/${campaignId}/adgroups/${adGroupId}`, body, 'PUT');
}

// ---- Keywords ----

export async function appleAdsKeywords(
  creds: AppleAdsCredentials,
  campaignId: string,
  adGroupId: string,
): Promise<AppleAdsKeyword[]> {
  if (isEmulator()) {
    seedMock();
    return mockKeywords.get(adGroupId) ?? [];
  }
  const out: AppleAdsKeyword[] = [];
  for (let offset = 0; offset < 5000; offset += 1000) {
    const doc = await api<{
      data?: Array<{ id?: number; text?: string; matchType?: string; status?: string; bidAmount?: { amount?: string; currency?: string } }>;
      pagination?: { totalResults?: number };
    }>(creds, `/campaigns/${campaignId}/adgroups/${adGroupId}/targetingkeywords?limit=1000&offset=${offset}`);
    for (const k of doc.data ?? []) {
      out.push({
        id: String(k.id ?? ''),
        adGroupId,
        text: k.text ?? '',
        matchType: k.matchType ?? 'BROAD',
        status: k.status ?? 'ACTIVE',
        bid: readMoney(k.bidAmount),
      });
    }
    if ((doc.pagination?.totalResults ?? 0) <= offset + 1000) break;
  }
  return out;
}

export async function appleAdsCreateKeywords(
  creds: AppleAdsCredentials,
  campaignId: string,
  adGroupId: string,
  keywords: AppleAdsKeywordInput[],
): Promise<AppleAdsKeyword[]> {
  if (isEmulator()) {
    seedMock();
    const created = keywords.map((k) => ({
      id: nextMockId(),
      adGroupId,
      text: k.text,
      matchType: k.matchType,
      status: 'ACTIVE',
      bid: k.bid,
    }));
    mockKeywords.set(adGroupId, [...(mockKeywords.get(adGroupId) ?? []), ...created]);
    return created;
  }
  const doc = await api<{ data?: Array<{ id?: number; text?: string; matchType?: string; status?: string; bidAmount?: { amount?: string; currency?: string } }> }>(
    creds,
    `/campaigns/${campaignId}/adgroups/${adGroupId}/targetingkeywords/bulk`,
    keywords.map((k) => ({ text: k.text, matchType: k.matchType, bidAmount: money(k.bid.amount, k.bid.currency) })),
  );
  return (doc.data ?? []).map((k) => ({
    id: String(k.id ?? ''),
    adGroupId,
    text: k.text ?? '',
    matchType: k.matchType ?? 'BROAD',
    status: k.status ?? 'ACTIVE',
    bid: readMoney(k.bidAmount),
  }));
}

export async function appleAdsUpdateKeyword(
  creds: AppleAdsCredentials,
  campaignId: string,
  adGroupId: string,
  keywordId: string,
  patch: { status?: 'ACTIVE' | 'PAUSED'; bid?: { amount: number; currency: string } },
): Promise<void> {
  if (isEmulator()) {
    seedMock();
    const k = (mockKeywords.get(adGroupId) ?? []).find((x) => x.id === keywordId);
    if (k) {
      if (patch.status !== undefined) k.status = patch.status;
      if (patch.bid !== undefined) k.bid = patch.bid;
    }
    return;
  }
  const entry: Record<string, unknown> = { id: keywordId };
  if (patch.status !== undefined) entry.status = patch.status;
  if (patch.bid !== undefined) entry.bidAmount = money(patch.bid.amount, patch.bid.currency);
  await api(creds, `/campaigns/${campaignId}/adgroups/${adGroupId}/targetingkeywords/bulk`, [entry], 'PUT');
}

// ---- Negative keywords (ad-group scope) ----

export async function appleAdsNegativeKeywords(
  creds: AppleAdsCredentials,
  campaignId: string,
  adGroupId: string,
): Promise<AppleAdsNegativeKeyword[]> {
  if (isEmulator()) {
    seedMock();
    return mockNegatives.get(`g:${adGroupId}`) ?? mockNegatives.get(`c:${campaignId}`) ?? [];
  }
  const doc = await api<{ data?: Array<{ id?: number; text?: string; matchType?: string }> }>(
    creds,
    `/campaigns/${campaignId}/adgroups/${adGroupId}/negativekeywords?limit=1000`,
  );
  return (doc.data ?? []).map((n) => ({ id: String(n.id ?? ''), text: n.text ?? '', matchType: n.matchType ?? 'EXACT' }));
}

export async function appleAdsAddNegativeKeywords(
  creds: AppleAdsCredentials,
  campaignId: string,
  adGroupId: string,
  keywords: Array<{ text: string; matchType: 'EXACT' | 'BROAD' }>,
): Promise<void> {
  if (isEmulator()) {
    seedMock();
    const key = `g:${adGroupId}`;
    const created = keywords.map((k) => ({ id: nextMockId(), text: k.text, matchType: k.matchType }));
    mockNegatives.set(key, [...(mockNegatives.get(key) ?? []), ...created]);
    return;
  }
  await api(creds, `/campaigns/${campaignId}/adgroups/${adGroupId}/negativekeywords/bulk`, keywords);
}

export async function appleAdsDeleteNegativeKeyword(
  creds: AppleAdsCredentials,
  campaignId: string,
  adGroupId: string,
  keywordId: string,
): Promise<void> {
  if (isEmulator()) {
    seedMock();
    const key = `g:${adGroupId}`;
    mockNegatives.set(key, (mockNegatives.get(key) ?? []).filter((n) => n.id !== keywordId));
    return;
  }
  await api(creds, `/campaigns/${campaignId}/adgroups/${adGroupId}/negativekeywords/delete/bulk`, [keywordId]);
}

// ---- Campaign create / update ----

export async function appleAdsCreateCampaign(
  creds: AppleAdsCredentials,
  input: AppleAdsCampaignInput,
): Promise<AppleAdsCampaign> {
  if (isEmulator()) {
    seedMock();
    const campaign: AppleAdsCampaign = {
      id: nextMockId(),
      name: input.name,
      status: 'ENABLED',
      servingStatus: 'RUNNING',
      dailyBudget: input.dailyBudgetAmount,
      countries: input.countries,
    };
    mockExtraCampaigns.push(campaign);
    return campaign;
  }
  const doc = await api<{ data?: { id?: number } }>(creds, '/campaigns', {
    name: input.name,
    adamId: input.adamId,
    budgetAmount: money(input.budgetAmount.amount, input.budgetAmount.currency),
    dailyBudgetAmount: money(input.dailyBudgetAmount.amount, input.dailyBudgetAmount.currency),
    countriesOrRegions: input.countries,
    supplySources: ['APPSTORE_SEARCH_RESULTS'],
    billingEvent: 'TAPS',
    adChannelType: 'SEARCH',
  });
  return { id: String(doc.data?.id ?? ''), name: input.name, status: 'ENABLED', dailyBudget: input.dailyBudgetAmount, countries: input.countries };
}

export async function appleAdsUpdateCampaign(
  creds: AppleAdsCredentials,
  campaignId: string,
  patch: AppleAdsCampaignPatch,
): Promise<void> {
  if (isEmulator()) {
    seedMock();
    if (patch.status) mockStatuses.set(campaignId, patch.status);
    const c = mockExtraCampaigns.find((x) => x.id === campaignId);
    if (c) {
      if (patch.name !== undefined) c.name = patch.name;
      if (patch.status !== undefined) c.status = patch.status;
      if (patch.dailyBudgetAmount !== undefined) c.dailyBudget = patch.dailyBudgetAmount;
      if (patch.countries !== undefined) c.countries = patch.countries;
    }
    return;
  }
  const campaign: Record<string, unknown> = {};
  if (patch.name !== undefined) campaign.name = patch.name;
  if (patch.status !== undefined) campaign.status = patch.status;
  if (patch.dailyBudgetAmount !== undefined) campaign.dailyBudgetAmount = money(patch.dailyBudgetAmount.amount, patch.dailyBudgetAmount.currency);
  if (patch.countries !== undefined) campaign.countriesOrRegions = patch.countries;
  await api(
    creds,
    `/campaigns/${campaignId}`,
    { campaign, ...(patch.countries !== undefined ? { clearGeoTargetingOnCountryOrRegionChange: false } : {}) },
    'PUT',
  );
}

// ---- Entity reports (range totals) ----

interface TotalRow {
  metadata?: { adGroupId?: number; adGroupName?: string; keywordId?: number; keyword?: string; searchTermText?: string; matchType?: string };
  total?: { localSpend?: { amount?: string; currency?: string }; taps?: number; impressions?: number; totalInstalls?: number; tapInstalls?: number; viewInstalls?: number };
}
function mapTotalRow(row: TotalRow, pick: (m: NonNullable<TotalRow['metadata']>) => { id: string; label: string }): AppleAdsMetrics {
  const t = row.total ?? {};
  const { id, label } = pick(row.metadata ?? {});
  return {
    id,
    label,
    spendAmount: Number(t.localSpend?.amount ?? 0) || 0,
    spendCurrency: (t.localSpend?.currency ?? 'USD').trim() || 'USD',
    taps: t.taps ?? 0,
    impressions: t.impressions ?? 0,
    installs: t.totalInstalls ?? (t.tapInstalls ?? 0) + (t.viewInstalls ?? 0),
  };
}
async function totalsReport(
  creds: AppleAdsCredentials,
  path: string,
  startDate: string,
  endDate: string,
  extraSelector: Record<string, unknown> = {},
): Promise<TotalRow[]> {
  const doc = await api<{ data?: { reportingDataResponse?: { row?: TotalRow[] } } }>(creds, path, {
    startTime: startDate,
    endTime: endDate,
    granularity: 'DAILY',
    timeZone: 'UTC',
    returnRecordsWithNoMetrics: true,
    returnRowTotals: true,
    returnGrandTotals: false,
    selector: { pagination: { offset: 0, limit: 1000 }, ...extraSelector },
  });
  return doc.data?.reportingDataResponse?.row ?? [];
}

export async function appleAdsAdGroupReport(
  creds: AppleAdsCredentials,
  campaignId: string,
  startDate: string,
  endDate: string,
): Promise<AppleAdsMetrics[]> {
  if (isEmulator()) {
    seedMock();
    return (mockAdGroups.get(campaignId) ?? []).map((g) => mockMetric(g.id, g.name));
  }
  const rows = await totalsReport(creds, `/campaigns/${campaignId}/adgroups/reports`, startDate, endDate);
  return rows.map((r) => mapTotalRow(r, (m) => ({ id: String(m.adGroupId ?? ''), label: m.adGroupName ?? '' })));
}

export async function appleAdsKeywordReport(
  creds: AppleAdsCredentials,
  campaignId: string,
  adGroupId: string,
  startDate: string,
  endDate: string,
): Promise<AppleAdsMetrics[]> {
  if (isEmulator()) {
    seedMock();
    return (mockKeywords.get(adGroupId) ?? []).map((k) => mockMetric(k.id, k.text));
  }
  const rows = await totalsReport(creds, `/campaigns/${campaignId}/adgroups/${adGroupId}/keywords/reports`, startDate, endDate);
  return rows.map((r) => mapTotalRow(r, (m) => ({ id: String(m.keywordId ?? ''), label: m.keyword ?? '' })));
}

// ---- Account app catalog + org currency (create-campaign helpers) ----

export interface AppleAdsPromotableApp {
  adamId: number;
  name: string;
  developer?: string;
  /** Storefronts the app can be promoted in, when Apple returns them. */
  countries?: string[];
}

/** Apps this Apple Ads account can promote (the org's own apps). */
export async function appleAdsOwnedApps(creds: AppleAdsCredentials): Promise<AppleAdsPromotableApp[]> {
  if (isEmulator()) {
    return [
      { adamId: 6754688919, name: 'AI Detector — Humanize Text', developer: 'Demo Co', countries: ['US', 'GB', 'DE', 'FR'] },
      { adamId: 6480554417, name: 'PetFun AI', developer: 'Demo Co', countries: ['US', 'CA'] },
    ];
  }
  const doc = await api<{
    data?: Array<{ adamId?: number; appName?: string; developerName?: string; countryOrRegionCodes?: string[] }>;
  }>(creds, '/search/apps?returnOwnedApps=true&limit=500');
  return (doc.data ?? [])
    .filter((a) => a.adamId)
    .map((a) => ({
      adamId: a.adamId!,
      name: a.appName ?? String(a.adamId),
      developer: a.developerName,
      countries: a.countryOrRegionCodes,
    }));
}

/** The org's billing currency — campaign budgets must be in it. */
export async function appleAdsOrgCurrency(creds: AppleAdsCredentials): Promise<string | null> {
  if (isEmulator()) return 'USD';
  const doc = await api<{ data?: Array<{ orgId?: number; currency?: string }> }>(creds, '/acls');
  const org = (doc.data ?? []).find((o) => o.orgId === creds.orgId) ?? (doc.data ?? [])[0];
  return org?.currency ?? null;
}

export async function appleAdsSearchTermsReport(
  creds: AppleAdsCredentials,
  campaignId: string,
  adGroupId: string,
  startDate: string,
  endDate: string,
): Promise<AppleAdsMetrics[]> {
  if (isEmulator()) {
    seedMock();
    return ['vocabulary practice', 'ai text detector', 'grammar checker free', 'best essay app'].map((t, i) =>
      mockMetric(`${adGroupId}-st${i}`, t),
    );
  }
  const rows = await totalsReport(creds, `/campaigns/${campaignId}/adgroups/${adGroupId}/searchterms/reports`, startDate, endDate);
  return rows.map((r) => mapTotalRow(r, (m) => ({ id: m.searchTermText ?? String(m.keywordId ?? ''), label: m.searchTermText ?? '(unknown)' })));
}
