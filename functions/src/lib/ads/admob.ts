import { isEmulator } from '../../config';
import { AppError } from '../errors';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API_BASE = 'https://admob.googleapis.com/v1';

export interface AdmobCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export interface AdmobAccount {
  publisherId: string; // pub-XXXXXXXXXXXXXXXX
  currencyCode: string;
}

export interface AdmobDayEarnings {
  date: string; // YYYY-MM-DD
  amount: number;
  currency: string;
}

/** Exchange an authorization code (from the consent redirect) for a refresh token. */
export async function admobExchangeCode(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<string> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => ({}))) as { refresh_token?: string; error_description?: string; error?: string };
  if (!res.ok || !json.refresh_token) {
    throw new AppError(
      'failed-precondition',
      `Google rejected the authorization (${json.error ?? res.status}): ${json.error_description ?? 'no refresh token returned — remove prior access at myaccount.google.com/permissions and try again.'}`,
    );
  }
  return json.refresh_token;
}

async function accessToken(creds: AdmobCredentials): Promise<string> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: creds.refreshToken,
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string };
  if (!res.ok || !json.access_token) {
    throw new AppError(
      'failed-precondition',
      `AdMob authorization expired or was revoked (${json.error ?? res.status}) — reconnect AdMob in the Ads page.`,
    );
  }
  return json.access_token;
}

/** First AdMob account on the authorized user (publisher id + reporting currency). */
export async function admobAccount(creds: AdmobCredentials): Promise<AdmobAccount> {
  if (isEmulator()) return { publisherId: 'pub-0000000000000000', currencyCode: 'USD' };
  const token = await accessToken(creds);
  const res = await fetch(`${API_BASE}/accounts`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new AppError('failed-precondition', `AdMob account lookup failed (${res.status}). Is the AdMob API enabled on the OAuth project?`);
  }
  const json = (await res.json()) as { account?: Array<{ publisherId?: string; currencyCode?: string }> };
  const account = json.account?.[0];
  if (!account?.publisherId) throw new AppError('failed-precondition', 'No AdMob account is linked to that Google user.');
  return { publisherId: account.publisherId, currencyCode: account.currencyCode ?? 'USD' };
}

interface ReportChunk {
  header?: { localizationSettings?: { currencyCode?: string } };
  row?: {
    dimensionValues?: { DATE?: { value?: string } };
    metricValues?: { ESTIMATED_EARNINGS?: { microsValue?: string } };
  };
}

/** Parse networkReport:generate chunks into per-day earnings. Exported for tests. */
export function parseAdmobReport(chunks: ReportChunk[], fallbackCurrency: string): AdmobDayEarnings[] {
  const currency =
    chunks.find((c) => c.header)?.header?.localizationSettings?.currencyCode ?? fallbackCurrency;
  const out: AdmobDayEarnings[] = [];
  for (const chunk of chunks) {
    const raw = chunk.row?.dimensionValues?.DATE?.value;
    if (!raw || raw.length !== 8) continue;
    const micros = Number(chunk.row?.metricValues?.ESTIMATED_EARNINGS?.microsValue ?? 0) || 0;
    out.push({
      date: `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`,
      amount: Math.round((micros / 1_000_000) * 100) / 100,
      currency,
    });
  }
  return out;
}

function mockEarnings(startDate: string, endDate: string): AdmobDayEarnings[] {
  const out: AdmobDayEarnings[] = [];
  for (let t = Date.parse(startDate); t <= Date.parse(endDate); t += 86_400_000) {
    const date = new Date(t).toISOString().slice(0, 10);
    let h = 0;
    for (let i = 0; i < date.length; i++) h = (h * 33 + date.charCodeAt(i)) | 0;
    const x = Math.abs(Math.sin(h) * 1000) % 1;
    out.push({ date, amount: Math.round((15 + x * 45) * 100) / 100, currency: 'USD' });
  }
  return out;
}

/** Daily estimated earnings for [startDate, endDate] (inclusive). */
export async function admobDailyEarnings(
  creds: AdmobCredentials,
  publisherId: string,
  currencyCode: string,
  startDate: string,
  endDate: string,
): Promise<AdmobDayEarnings[]> {
  if (isEmulator()) return mockEarnings(startDate, endDate);
  const token = await accessToken(creds);
  const toParts = (d: string) => ({
    year: Number(d.slice(0, 4)),
    month: Number(d.slice(5, 7)),
    day: Number(d.slice(8, 10)),
  });
  const res = await fetch(`${API_BASE}/accounts/${publisherId}/networkReport:generate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      reportSpec: {
        dateRange: { startDate: toParts(startDate), endDate: toParts(endDate) },
        dimensions: ['DATE'],
        metrics: ['ESTIMATED_EARNINGS'],
      },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new AppError('internal', `AdMob report failed (${res.status}): ${text.slice(0, 160)}`);
  }
  const chunks = (await res.json()) as ReportChunk[];
  return parseAdmobReport(Array.isArray(chunks) ? chunks : [], currencyCode);
}
