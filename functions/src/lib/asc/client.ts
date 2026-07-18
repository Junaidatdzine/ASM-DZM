import { gunzipSync } from 'node:zlib';
import { SignJWT, importPKCS8 } from 'jose';
import type { Platform } from '@asm/shared';
import { AppError } from '../errors';
import type {
  AscAgeRating,
  AscApi,
  AscApp,
  AscAppEvent,
  AscAppInfo,
  AscAvailabilitySummary,
  AscBetaGroup,
  AscBetaTester,
  AscBuild,
  AscBundleId,
  AscCustomerReview,
  AscEncryptionDeclaration,
  AscExperiment,
  AscIap,
  AscInfoLoc,
  AscPhasedRelease,
  AscPreviewSet,
  AscPricePoint,
  AscPriceSummary,
  AscProductPage,
  AscReviewAttachment,
  AscReviewDetail,
  AscReviewSubmission,
  AscReviewSubmissionItem,
  AscScreenshot,
  AscScreenshotSet,
  AscSubscriptionGroup,
  AscUploadOperation,
  AscVersion,
  AscVersionLoc,
  InfoLocAttrs,
  ReviewDetailAttrs,
  SalesRow,
  VersionInfoAttrs,
  VersionLocAttrs,
} from './types';

const BASE = 'https://api.appstoreconnect.apple.com';
const TOKEN_TTL_S = 15 * 60;
const MAX_CONCURRENT = 4;

export interface AscCredentials {
  issuerId: string;
  keyId: string;
  p8: string; // PEM PKCS8
}

export type RateInfo = { limit: number; remaining: number };

interface JsonApiResource {
  id: string;
  type: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<string, { data?: Array<{ id: string; type: string }> | { id: string; type: string } | null }>;
}

interface JsonApiDoc {
  data: JsonApiResource | JsonApiResource[];
  included?: JsonApiResource[];
  links?: { next?: string };
  meta?: { paging?: { total?: number } };
  errors?: Array<{ status?: string; code?: string; title?: string; detail?: string; source?: { pointer?: string } }>;
}

function s(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

const KNOWN_PLATFORMS: ReadonlySet<string> = new Set(['IOS', 'MAC_OS', 'TV_OS', 'VISION_OS']);

/** Flatten /v1/apps rows + included appStoreVersions into AscApps with a platform union. */
export function mapAppsWithPlatforms(
  rows: Array<{ id: string; attributes?: Record<string, unknown>; relationships?: JsonApiResource['relationships'] }>,
  included: Array<{ id: string; type: string; attributes?: Record<string, unknown> }>,
): AscApp[] {
  const versionById = new Map<string, AscVersion>();
  for (const inc of included) {
    if (inc.type !== 'appStoreVersions') continue;
    versionById.set(inc.id, {
      id: inc.id,
      platform: s(inc.attributes?.platform) as Platform,
      versionString: s(inc.attributes?.versionString),
      state: s(inc.attributes?.appVersionState) || s(inc.attributes?.appStoreState),
      createdDate: s(inc.attributes?.createdDate) || undefined,
    });
  }
  return rows.map((r) => {
    const rel = r.relationships?.appStoreVersions?.data;
    const versionIds = Array.isArray(rel) ? rel : rel ? [rel] : [];
    const versions = versionIds
      .map((v) => versionById.get(v.id))
      .filter((v): v is AscVersion => !!v && KNOWN_PLATFORMS.has(v.platform));
    const platforms = [...new Set(versions.map((v) => v.platform))];
    return {
      id: r.id,
      bundleId: s(r.attributes?.bundleId),
      name: s(r.attributes?.name),
      sku: s(r.attributes?.sku) || undefined,
      primaryLocale: s(r.attributes?.primaryLocale) || 'en-US',
      platforms,
      versionsIncluded: versions,
    };
  });
}

/** Translate an ASC error payload into a user-facing AppError. */
export function mapAscError(status: number, doc: JsonApiDoc | null, context: string): AppError {
  const first = doc?.errors?.[0];
  const code = first?.code ?? '';
  const detail = first?.detail ?? first?.title ?? '';

  if (status === 401) {
    return new AppError('failed-precondition', 'The App Store Connect API key was rejected — it may be revoked or expired.', { ascAuth: true });
  }
  if (status === 403) {
    return new AppError('failed-precondition', 'This API key doesn’t have permission for that (App Manager role recommended).', { ascAuth: true });
  }
  if (status === 404) {
    return new AppError('not-found', `Apple can’t find that resource anymore (${context}). It may have changed in App Store Connect — try syncing.`);
  }
  if (status === 409 && code.includes('STATE_ERROR')) {
    return new AppError('failed-precondition', 'This version is no longer editable — its state changed in App Store Connect. Re-sync to see the current state.', { stateError: true });
  }
  if (status === 409) {
    const pointer = first?.source?.pointer ?? '';
    const field = pointer.split('/').pop() ?? '';
    return new AppError('invalid-argument', detail || `Apple rejected the change${field ? ` (${field})` : ''}.`, { field });
  }
  if (status === 429) {
    return new AppError('resource-exhausted', 'Apple’s API rate limit was hit for this store. Try again in a few minutes.');
  }
  if (status >= 500) {
    return new AppError('unavailable', 'App Store Connect is having trouble right now. Try again shortly.');
  }
  return new AppError('internal', detail || `Unexpected App Store Connect error (${status}).`);
}

/** Parse a daily sales summary TSV into rows (header-name based, order-independent). */
export function parseSalesTsv(tsv: string): SalesRow[] {
  const lines = tsv.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length < 2) return [];
  const header = lines[0]!.split('\t').map((h) => h.trim().toLowerCase());
  const idx = (name: string) => header.indexOf(name);
  const iSku = idx('sku');
  const iTitle = idx('title');
  const iType = idx('product type identifier');
  const iUnits = idx('units');
  const iProceeds = idx('developer proceeds');
  const iCurrency = idx('currency of proceeds');
  const iAppleId = idx('apple identifier');
  // IAP/subscription rows carry the parent APP's SKU here — the only reliable
  // way to attribute their proceeds to the owning app.
  const iParent = idx('parent identifier');
  if (iUnits < 0 || iProceeds < 0) return [];

  const rows: SalesRow[] = [];
  for (const line of lines.slice(1)) {
    const cols = line.split('\t');
    // Total rows / malformed lines guard
    if (cols.length < header.length - 2) continue;
    const units = Number(cols[iUnits] ?? 0);
    if (!Number.isFinite(units) || units === 0) continue;
    const parent = iParent >= 0 ? (cols[iParent] ?? '').trim() : '';
    rows.push({
      appleId: (cols[iAppleId] ?? '').trim(),
      sku: (cols[iSku] ?? '').trim(),
      title: (cols[iTitle] ?? '').trim(),
      productType: (cols[iType] ?? '').trim(),
      units,
      proceedsPerUnit: Number(cols[iProceeds] ?? 0) || 0,
      currency: (cols[iCurrency] ?? 'USD').trim() || 'USD',
      ...(parent ? { parentIdentifier: parent } : {}),
    });
  }
  return rows;
}

/** Minimal promise concurrency limiter. */
export function makeLimiter(max: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    active--;
    queue.shift()?.();
  };
  return async function limit<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= max) await new Promise<void>((res) => queue.push(res));
    active++;
    try {
      return await fn();
    } finally {
      next();
    }
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class AscClient implements AscApi {
  private tokenCache: { token: string; exp: number } | null = null;
  private limit = makeLimiter(MAX_CONCURRENT);

  constructor(
    private creds: AscCredentials,
    private onRate?: (rate: RateInfo) => void,
  ) {}

  private async token(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (this.tokenCache && this.tokenCache.exp - now > 120) return this.tokenCache.token;
    const key = await importPKCS8(this.creds.p8, 'ES256').catch(() => {
      throw new AppError('invalid-argument', 'The .p8 private key is not valid PKCS8 — paste the full file contents including BEGIN/END lines.');
    });
    const exp = now + TOKEN_TTL_S;
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: this.creds.keyId, typ: 'JWT' })
      .setIssuer(this.creds.issuerId)
      .setIssuedAt(now - 30) // clock-skew guard
      .setExpirationTime(exp)
      .setAudience('appstoreconnect-v1')
      .sign(key);
    this.tokenCache = { token, exp };
    return token;
  }

  private async req<T = JsonApiDoc>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    pathOrUrl: string,
    body?: unknown,
    context = pathOrUrl,
  ): Promise<T> {
    return this.limit(async () => {
      const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${BASE}${pathOrUrl}`;
      let lastErr: AppError | null = null;

      for (let attempt = 0; attempt < 4; attempt++) {
        const res = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${await this.token()}`,
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
        }).catch((err) => {
          lastErr = new AppError('unavailable', 'Could not reach App Store Connect.', { cause: String(err) });
          return null;
        });

        if (!res) {
          await sleep(500 * (attempt + 1));
          continue;
        }

        const rateHeader = res.headers.get('x-rate-limit') ?? '';
        const lim = /user-hour-lim:(\d+)/.exec(rateHeader)?.[1];
        const rem = /user-hour-rem:(\d+)/.exec(rateHeader)?.[1];
        if (lim && rem && this.onRate) this.onRate({ limit: Number(lim), remaining: Number(rem) });

        if (res.status === 429 || res.status >= 500) {
          const retryAfter = Number(res.headers.get('retry-after') ?? 0);
          const doc = (await res.json().catch(() => null)) as JsonApiDoc | null;
          lastErr = mapAscError(res.status, doc, context);
          const backoff = retryAfter > 0 ? retryAfter * 1000 : 600 * 2 ** attempt + Math.random() * 400;
          if (attempt < 3) {
            await sleep(Math.min(backoff, 15_000));
            continue;
          }
          throw lastErr;
        }

        if (res.status === 204) return undefined as T;
        const doc = (await res.json().catch(() => null)) as JsonApiDoc | null;
        if (!res.ok) throw mapAscError(res.status, doc, context);
        return doc as T;
      }
      throw lastErr ?? new AppError('unavailable', 'Could not reach App Store Connect.');
    });
  }

  private async paginate(path: string, cap = 20): Promise<JsonApiResource[]> {
    const out: JsonApiResource[] = [];
    let url: string | undefined = path;
    for (let page = 0; url && page < cap; page++) {
      const doc: JsonApiDoc = await this.req('GET', url);
      const data = Array.isArray(doc.data) ? doc.data : [doc.data];
      out.push(...data.filter(Boolean));
      url = doc.links?.next;
    }
    return out;
  }

  // ---- sales reports (finance) ----

  async fetchDailySales(vendorNumber: string, date: string): Promise<SalesRow[] | null> {
    return this.limit(async () => {
      const params = new URLSearchParams({
        'filter[frequency]': 'DAILY',
        'filter[reportDate]': date,
        'filter[reportSubType]': 'SUMMARY',
        'filter[reportType]': 'SALES',
        'filter[vendorNumber]': vendorNumber,
      });
      const res = await fetch(`${BASE}/v1/salesReports?${params}`, {
        headers: {
          Authorization: `Bearer ${await this.token()}`,
          Accept: 'application/a-gzip',
        },
      }).catch(() => null);
      if (!res) throw new AppError('unavailable', 'Could not reach App Store Connect.');
      // 404 = report not generated (yet) or no sales that day — both mean "no data".
      if (res.status === 404 || res.status === 410) return null;
      if (res.status === 401 || res.status === 403) {
        throw new AppError(
          'failed-precondition',
          'This API key can’t read sales reports — it needs the Finance (or Admin) role in App Store Connect, and the vendor number must match.',
          { ascAuth: res.status === 401 },
        );
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new AppError('internal', `Sales report request failed (${res.status}).`, { body: body.slice(0, 200) });
      }
      const buf = Buffer.from(await res.arrayBuffer());
      let tsv: string;
      try {
        tsv = gunzipSync(buf).toString('utf8');
      } catch {
        tsv = buf.toString('utf8'); // some proxies deliver it pre-inflated
      }
      return parseSalesTsv(tsv);
    });
  }

  // ---- verification ----

  async verify(): Promise<{ appsCount: number }> {
    const doc = await this.req<JsonApiDoc>('GET', '/v1/apps?limit=1');
    return { appsCount: doc.meta?.paging?.total ?? (Array.isArray(doc.data) ? doc.data.length : 1) };
  }

  // ---- apps & metadata ----

  async listApps(): Promise<AscApp[]> {
    // Manual pagination: paginate() drops `included`, which carries each app's
    // appStoreVersions (only their platform field) so we learn iOS/macOS/tvOS/visionOS
    // support in the same 1-request-per-200-apps budget.
    const rows: JsonApiResource[] = [];
    const included: JsonApiResource[] = [];
    let url: string | undefined =
      '/v1/apps?limit=200&fields[apps]=bundleId,name,sku,primaryLocale,appStoreVersions'
      + '&include=appStoreVersions&fields[appStoreVersions]=platform,versionString,appStoreState,appVersionState,createdDate&limit[appStoreVersions]=50';
    for (let page = 0; url && page < 20; page++) {
      const doc: JsonApiDoc = await this.req('GET', url);
      rows.push(...(Array.isArray(doc.data) ? doc.data : [doc.data]).filter(Boolean));
      included.push(...(doc.included ?? []));
      url = doc.links?.next;
    }
    return mapAppsWithPlatforms(rows, included);
  }

  async listAppInfos(appId: string): Promise<AscAppInfo[]> {
    const rows = await this.paginate(`/v1/apps/${appId}/appInfos?limit=2&fields[appInfos]=appStoreState,state`);
    return rows.map((r) => ({
      id: r.id,
      state: s(r.attributes?.state) || s(r.attributes?.appStoreState),
    }));
  }

  async listAppInfoLocalizations(appInfoId: string): Promise<AscInfoLoc[]> {
    const rows = await this.paginate(
      `/v1/appInfos/${appInfoId}/appInfoLocalizations?limit=50&fields[appInfoLocalizations]=locale,name,subtitle,privacyPolicyUrl,privacyChoicesUrl`,
    );
    return rows.map((r) => ({
      id: r.id,
      locale: s(r.attributes?.locale),
      name: s(r.attributes?.name),
      subtitle: s(r.attributes?.subtitle),
      privacyPolicyUrl: s(r.attributes?.privacyPolicyUrl),
      privacyChoicesUrl: s(r.attributes?.privacyChoicesUrl),
    }));
  }

  async listVersions(appId: string): Promise<AscVersion[]> {
    const rows = await this.paginate(
      `/v1/apps/${appId}/appStoreVersions?limit=50&fields[appStoreVersions]=platform,versionString,appStoreState,appVersionState,createdDate,copyright,releaseType,earliestReleaseDate`,
    );
    return rows.map((r) => this.mapVersion(r));
  }

  private mapVersion(r: JsonApiResource): AscVersion {
    return {
      id: r.id,
      platform: s(r.attributes?.platform) as Platform,
      versionString: s(r.attributes?.versionString),
      state: s(r.attributes?.appVersionState) || s(r.attributes?.appStoreState),
      createdDate: s(r.attributes?.createdDate) || undefined,
      copyright: s(r.attributes?.copyright),
      releaseType: s(r.attributes?.releaseType) || undefined,
      earliestReleaseDate: (r.attributes?.earliestReleaseDate as string | null | undefined) ?? null,
    };
  }

  private mapBuild(r: JsonApiResource): AscBuild {
    const token = r.attributes?.iconAssetToken as { templateUrl?: string } | null | undefined;
    const iconUrl = token?.templateUrl
      ? token.templateUrl.replace('{w}', '256').replace('{h}', '256').replace('{f}', 'png')
      : null;
    return {
      id: r.id,
      version: s(r.attributes?.version),
      uploadedDate: s(r.attributes?.uploadedDate) || undefined,
      processingState: s(r.attributes?.processingState) || undefined,
      expired: (r.attributes?.expired as boolean | undefined) ?? undefined,
      usesNonExemptEncryption: (r.attributes?.usesNonExemptEncryption as boolean | null | undefined) ?? null,
      iconUrl,
    };
  }

  async listVersionLocalizations(versionId: string): Promise<AscVersionLoc[]> {
    const rows = await this.paginate(
      `/v1/appStoreVersions/${versionId}/appStoreVersionLocalizations?limit=50`,
    );
    return rows.map((r) => this.mapVersionLoc(r));
  }

  private mapVersionLoc(r: JsonApiResource): AscVersionLoc {
    return {
      id: r.id,
      locale: s(r.attributes?.locale),
      description: s(r.attributes?.description),
      keywords: s(r.attributes?.keywords),
      promotionalText: s(r.attributes?.promotionalText),
      whatsNew: s(r.attributes?.whatsNew),
      supportUrl: s(r.attributes?.supportUrl),
      marketingUrl: s(r.attributes?.marketingUrl),
    };
  }

  private mapInfoLoc(r: JsonApiResource): AscInfoLoc {
    return {
      id: r.id,
      locale: s(r.attributes?.locale),
      name: s(r.attributes?.name),
      subtitle: s(r.attributes?.subtitle),
      privacyPolicyUrl: s(r.attributes?.privacyPolicyUrl),
      privacyChoicesUrl: s(r.attributes?.privacyChoicesUrl),
    };
  }

  async createAppInfoLocalization(appInfoId: string, locale: string, attrs: InfoLocAttrs): Promise<AscInfoLoc> {
    const doc = await this.req<JsonApiDoc>('POST', '/v1/appInfoLocalizations', {
      data: {
        type: 'appInfoLocalizations',
        attributes: { locale, ...attrs },
        relationships: { appInfo: { data: { type: 'appInfos', id: appInfoId } } },
      },
    });
    return this.mapInfoLoc(doc.data as JsonApiResource);
  }

  async updateAppInfoLocalization(id: string, attrs: InfoLocAttrs): Promise<AscInfoLoc> {
    const doc = await this.req<JsonApiDoc>('PATCH', `/v1/appInfoLocalizations/${id}`, {
      data: { type: 'appInfoLocalizations', id, attributes: attrs },
    });
    return this.mapInfoLoc(doc.data as JsonApiResource);
  }

  async deleteAppInfoLocalization(id: string): Promise<void> {
    await this.req('DELETE', `/v1/appInfoLocalizations/${id}`);
  }

  async createVersionLocalization(versionId: string, locale: string, attrs: VersionLocAttrs): Promise<AscVersionLoc> {
    const doc = await this.req<JsonApiDoc>('POST', '/v1/appStoreVersionLocalizations', {
      data: {
        type: 'appStoreVersionLocalizations',
        attributes: { locale, ...attrs },
        relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: versionId } } },
      },
    });
    return this.mapVersionLoc(doc.data as JsonApiResource);
  }

  async updateVersionLocalization(id: string, attrs: VersionLocAttrs): Promise<AscVersionLoc> {
    const doc = await this.req<JsonApiDoc>('PATCH', `/v1/appStoreVersionLocalizations/${id}`, {
      data: { type: 'appStoreVersionLocalizations', id, attributes: attrs },
    });
    return this.mapVersionLoc(doc.data as JsonApiResource);
  }

  async deleteVersionLocalization(id: string): Promise<void> {
    await this.req('DELETE', `/v1/appStoreVersionLocalizations/${id}`);
  }

  async createVersion(appId: string, platform: Platform, versionString: string): Promise<AscVersion> {
    const doc = await this.req<JsonApiDoc>('POST', '/v1/appStoreVersions', {
      data: {
        type: 'appStoreVersions',
        attributes: { platform, versionString },
        relationships: { app: { data: { type: 'apps', id: appId } } },
      },
    });
    return this.mapVersion(doc.data as JsonApiResource);
  }

  async updateVersion(id: string, versionString: string): Promise<AscVersion> {
    const doc = await this.req<JsonApiDoc>('PATCH', `/v1/appStoreVersions/${id}`, {
      data: { type: 'appStoreVersions', id, attributes: { versionString } },
    });
    return this.mapVersion(doc.data as JsonApiResource);
  }

  async updateVersionInfo(versionId: string, attrs: VersionInfoAttrs): Promise<AscVersion> {
    const doc = await this.req<JsonApiDoc>('PATCH', `/v1/appStoreVersions/${versionId}`, {
      data: { type: 'appStoreVersions', id: versionId, attributes: attrs },
    });
    return this.mapVersion(doc.data as JsonApiResource);
  }

  async getVersionBuild(versionId: string): Promise<AscBuild | null> {
    const doc = await this.req<JsonApiDoc>(
      'GET',
      `/v1/appStoreVersions/${versionId}/build?fields[builds]=version,uploadedDate,processingState,expired,usesNonExemptEncryption,iconAssetToken`,
      undefined,
      'version build',
    );
    const data = doc.data as JsonApiResource | null;
    return data ? this.mapBuild(data) : null;
  }

  async selectBuild(versionId: string, buildId: string | null): Promise<void> {
    await this.req('PATCH', `/v1/appStoreVersions/${versionId}/relationships/build`, {
      data: buildId ? { type: 'builds', id: buildId } : null,
    });
  }

  async listBuilds(appId: string, versionString: string): Promise<AscBuild[]> {
    const params = new URLSearchParams({
      'filter[app]': appId,
      'filter[preReleaseVersion.version]': versionString,
      'fields[builds]': 'version,uploadedDate,processingState,expired,usesNonExemptEncryption,iconAssetToken',
      sort: '-uploadedDate',
      limit: '50',
    });
    const rows = await this.paginate(`/v1/builds?${params}`);
    return rows.map((r) => this.mapBuild(r));
  }

  async getVersionState(versionId: string): Promise<string> {
    const doc = await this.req<JsonApiDoc>(
      'GET',
      `/v1/appStoreVersions/${versionId}?fields[appStoreVersions]=appStoreState,appVersionState`,
    );
    const r = doc.data as JsonApiResource;
    return s(r.attributes?.appVersionState) || s(r.attributes?.appStoreState);
  }

  async getAppInfoState(appInfoId: string): Promise<string> {
    const doc = await this.req<JsonApiDoc>('GET', `/v1/appInfos/${appInfoId}?fields[appInfos]=appStoreState,state`);
    const r = doc.data as JsonApiResource;
    return s(r.attributes?.state) || s(r.attributes?.appStoreState);
  }

  // ---- screenshots ----

  private mapScreenshot(r: JsonApiResource): AscScreenshot {
    const asset = (r.attributes?.imageAsset ?? null) as { templateUrl?: string; width?: number; height?: number } | null;
    const delivery = (r.attributes?.assetDeliveryState ?? null) as { state?: string } | null;
    return {
      id: r.id,
      fileName: s(r.attributes?.fileName),
      fileSize: (r.attributes?.fileSize as number | undefined) ?? null,
      assetState: delivery?.state ?? 'COMPLETE',
      templateUrl: asset?.templateUrl ?? null,
      width: asset?.width ?? null,
      height: asset?.height ?? null,
      uploadOperations: (r.attributes?.uploadOperations as AscUploadOperation[] | undefined) ?? undefined,
    };
  }

  async listScreenshotSets(versionLocId: string): Promise<AscScreenshotSet[]> {
    const rows = await this.paginate(
      `/v1/appStoreVersionLocalizations/${versionLocId}/appScreenshotSets?limit=50&fields[appScreenshotSets]=screenshotDisplayType`,
    );
    return rows.map((r) => ({ id: r.id, displayType: s(r.attributes?.screenshotDisplayType) }));
  }

  async listScreenshots(setId: string): Promise<AscScreenshot[]> {
    const rows = await this.paginate(`/v1/appScreenshotSets/${setId}/appScreenshots?limit=50`);
    return rows.map((r) => this.mapScreenshot(r));
  }

  async createScreenshotSet(versionLocId: string, displayType: string): Promise<AscScreenshotSet> {
    const doc = await this.req<JsonApiDoc>('POST', '/v1/appScreenshotSets', {
      data: {
        type: 'appScreenshotSets',
        attributes: { screenshotDisplayType: displayType },
        relationships: {
          appStoreVersionLocalization: {
            data: { type: 'appStoreVersionLocalizations', id: versionLocId },
          },
        },
      },
    });
    const r = doc.data as JsonApiResource;
    return { id: r.id, displayType: s(r.attributes?.screenshotDisplayType) };
  }

  async deleteScreenshotSet(id: string): Promise<void> {
    await this.req('DELETE', `/v1/appScreenshotSets/${id}`);
  }

  async reserveScreenshot(setId: string, fileName: string, fileSize: number): Promise<AscScreenshot> {
    const doc = await this.req<JsonApiDoc>('POST', '/v1/appScreenshots', {
      data: {
        type: 'appScreenshots',
        attributes: { fileName, fileSize },
        relationships: { appScreenshotSet: { data: { type: 'appScreenshotSets', id: setId } } },
      },
    });
    return this.mapScreenshot(doc.data as JsonApiResource);
  }

  async uploadScreenshotParts(ops: AscUploadOperation[], data: Buffer): Promise<void> {
    for (const op of ops) {
      const chunk = data.subarray(op.offset, op.offset + op.length);
      let ok = false;
      for (let attempt = 0; attempt < 3 && !ok; attempt++) {
        const res = await fetch(op.url, {
          method: op.method || 'PUT',
          headers: Object.fromEntries(op.requestHeaders.map((h) => [h.name, h.value])),
          body: new Uint8Array(chunk),
        }).catch(() => null);
        ok = !!res && res.ok;
        if (!ok) await sleep(400 * (attempt + 1));
      }
      if (!ok) throw new AppError('unavailable', 'Uploading the image to Apple failed. Try again.');
    }
  }

  async commitScreenshot(id: string, md5: string): Promise<AscScreenshot> {
    const doc = await this.req<JsonApiDoc>('PATCH', `/v1/appScreenshots/${id}`, {
      data: { type: 'appScreenshots', id, attributes: { uploaded: true, sourceFileChecksum: md5 } },
    });
    return this.mapScreenshot(doc.data as JsonApiResource);
  }

  async getScreenshot(id: string): Promise<AscScreenshot> {
    const doc = await this.req<JsonApiDoc>('GET', `/v1/appScreenshots/${id}`);
    return this.mapScreenshot(doc.data as JsonApiResource);
  }

  async deleteScreenshot(id: string): Promise<void> {
    await this.req('DELETE', `/v1/appScreenshots/${id}`);
  }

  async reorderScreenshots(setId: string, orderedIds: string[]): Promise<void> {
    await this.req('PATCH', `/v1/appScreenshotSets/${setId}/relationships/appScreenshots`, {
      data: orderedIds.map((id) => ({ type: 'appScreenshots', id })),
    });
  }

  // ---- App Review details & attachments ----

  /** GET that treats 404 as null (to-one relationships that may not exist yet). */
  private async getOrNull(path: string, context: string): Promise<JsonApiResource | null> {
    try {
      const doc = await this.req<JsonApiDoc>('GET', path, undefined, context);
      return (doc?.data as JsonApiResource | null) ?? null;
    } catch (err) {
      if (err instanceof AppError && err.code === 'not-found') return null;
      throw err;
    }
  }

  private mapReviewDetail(r: JsonApiResource): AscReviewDetail {
    return {
      id: r.id,
      contactFirstName: s(r.attributes?.contactFirstName),
      contactLastName: s(r.attributes?.contactLastName),
      contactPhone: s(r.attributes?.contactPhone),
      contactEmail: s(r.attributes?.contactEmail),
      demoAccountName: s(r.attributes?.demoAccountName),
      demoAccountPassword: s(r.attributes?.demoAccountPassword),
      demoAccountRequired: r.attributes?.demoAccountRequired === true,
      notes: s(r.attributes?.notes),
    };
  }

  async getReviewDetail(versionId: string): Promise<AscReviewDetail | null> {
    const r = await this.getOrNull(`/v1/appStoreVersions/${versionId}/appStoreReviewDetail`, 'review detail');
    return r ? this.mapReviewDetail(r) : null;
  }

  async createReviewDetail(versionId: string, attrs: ReviewDetailAttrs): Promise<AscReviewDetail> {
    const doc = await this.req<JsonApiDoc>('POST', '/v1/appStoreReviewDetails', {
      data: {
        type: 'appStoreReviewDetails',
        attributes: attrs,
        relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: versionId } } },
      },
    });
    return this.mapReviewDetail(doc.data as JsonApiResource);
  }

  async updateReviewDetail(id: string, attrs: ReviewDetailAttrs): Promise<AscReviewDetail> {
    const doc = await this.req<JsonApiDoc>('PATCH', `/v1/appStoreReviewDetails/${id}`, {
      data: { type: 'appStoreReviewDetails', id, attributes: attrs },
    });
    return this.mapReviewDetail(doc.data as JsonApiResource);
  }

  private mapAttachment(r: JsonApiResource): AscReviewAttachment {
    const delivery = (r.attributes?.assetDeliveryState ?? null) as { state?: string } | null;
    return {
      id: r.id,
      fileName: s(r.attributes?.fileName),
      fileSize: (r.attributes?.fileSize as number | undefined) ?? null,
      assetState: delivery?.state ?? 'COMPLETE',
      uploadOperations: (r.attributes?.uploadOperations as AscUploadOperation[] | undefined) ?? undefined,
    };
  }

  async listReviewAttachments(reviewDetailId: string): Promise<AscReviewAttachment[]> {
    const rows = await this.paginate(
      `/v1/appStoreReviewDetails/${reviewDetailId}/appStoreReviewAttachments?limit=50`,
    );
    return rows.map((r) => this.mapAttachment(r));
  }

  async reserveReviewAttachment(reviewDetailId: string, fileName: string, fileSize: number): Promise<AscReviewAttachment> {
    const doc = await this.req<JsonApiDoc>('POST', '/v1/appStoreReviewAttachments', {
      data: {
        type: 'appStoreReviewAttachments',
        attributes: { fileName, fileSize },
        relationships: {
          appStoreReviewDetail: { data: { type: 'appStoreReviewDetails', id: reviewDetailId } },
        },
      },
    });
    return this.mapAttachment(doc.data as JsonApiResource);
  }

  async commitReviewAttachment(id: string, md5: string): Promise<AscReviewAttachment> {
    const doc = await this.req<JsonApiDoc>('PATCH', `/v1/appStoreReviewAttachments/${id}`, {
      data: { type: 'appStoreReviewAttachments', id, attributes: { uploaded: true, sourceFileChecksum: md5 } },
    });
    return this.mapAttachment(doc.data as JsonApiResource);
  }

  async deleteReviewAttachment(id: string): Promise<void> {
    await this.req('DELETE', `/v1/appStoreReviewAttachments/${id}`);
  }

  // ---- Phased release & review submission ----

  private mapPhased(r: JsonApiResource): AscPhasedRelease {
    return {
      id: r.id,
      state: s(r.attributes?.phasedReleaseState),
      currentDayNumber: (r.attributes?.currentDayNumber as number | undefined) ?? null,
      startDate: (r.attributes?.startDate as string | undefined) ?? null,
    };
  }

  async getPhasedRelease(versionId: string): Promise<AscPhasedRelease | null> {
    const r = await this.getOrNull(
      `/v1/appStoreVersions/${versionId}/appStoreVersionPhasedRelease?fields[appStoreVersionPhasedReleases]=phasedReleaseState,currentDayNumber,startDate`,
      'phased release',
    );
    return r ? this.mapPhased(r) : null;
  }

  async createPhasedRelease(versionId: string): Promise<AscPhasedRelease> {
    const doc = await this.req<JsonApiDoc>('POST', '/v1/appStoreVersionPhasedReleases', {
      data: {
        type: 'appStoreVersionPhasedReleases',
        relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: versionId } } },
      },
    });
    return this.mapPhased(doc.data as JsonApiResource);
  }

  async updatePhasedRelease(id: string, state: string): Promise<AscPhasedRelease> {
    const doc = await this.req<JsonApiDoc>('PATCH', `/v1/appStoreVersionPhasedReleases/${id}`, {
      data: { type: 'appStoreVersionPhasedReleases', id, attributes: { phasedReleaseState: state } },
    });
    return this.mapPhased(doc.data as JsonApiResource);
  }

  async deletePhasedRelease(id: string): Promise<void> {
    await this.req('DELETE', `/v1/appStoreVersionPhasedReleases/${id}`);
  }

  private mapSubmission(r: JsonApiResource): AscReviewSubmission {
    return {
      id: r.id,
      state: s(r.attributes?.state),
      platform: s(r.attributes?.platform),
      submittedDate: (r.attributes?.submittedDate as string | undefined) ?? null,
    };
  }

  async listReviewSubmissions(appId: string, platform: Platform): Promise<AscReviewSubmission[]> {
    const params = new URLSearchParams({
      'filter[app]': appId,
      'filter[platform]': platform,
      'fields[reviewSubmissions]': 'state,platform,submittedDate',
      limit: '20',
    });
    const rows = await this.paginate(`/v1/reviewSubmissions?${params}`, 2);
    return rows.map((r) => this.mapSubmission(r));
  }

  async createReviewSubmission(appId: string, platform: Platform): Promise<AscReviewSubmission> {
    const doc = await this.req<JsonApiDoc>('POST', '/v1/reviewSubmissions', {
      data: {
        type: 'reviewSubmissions',
        attributes: { platform },
        relationships: { app: { data: { type: 'apps', id: appId } } },
      },
    });
    return this.mapSubmission(doc.data as JsonApiResource);
  }

  async addReviewSubmissionItem(submissionId: string, versionId: string): Promise<void> {
    await this.req('POST', '/v1/reviewSubmissionItems', {
      data: {
        type: 'reviewSubmissionItems',
        relationships: {
          reviewSubmission: { data: { type: 'reviewSubmissions', id: submissionId } },
          appStoreVersion: { data: { type: 'appStoreVersions', id: versionId } },
        },
      },
    });
  }

  async submitReviewSubmission(id: string): Promise<AscReviewSubmission> {
    const doc = await this.req<JsonApiDoc>('PATCH', `/v1/reviewSubmissions/${id}`, {
      data: { type: 'reviewSubmissions', id, attributes: { submitted: true } },
    });
    return this.mapSubmission(doc.data as JsonApiResource);
  }

  async cancelReviewSubmission(id: string): Promise<AscReviewSubmission> {
    const doc = await this.req<JsonApiDoc>('PATCH', `/v1/reviewSubmissions/${id}`, {
      data: { type: 'reviewSubmissions', id, attributes: { canceled: true } },
    });
    return this.mapSubmission(doc.data as JsonApiResource);
  }

  async listReviewSubmissionItems(submissionId: string): Promise<AscReviewSubmissionItem[]> {
    const params = new URLSearchParams({
      include: 'appStoreVersion',
      'fields[reviewSubmissionItems]': 'state,appStoreVersion',
      'fields[appStoreVersions]': 'versionString',
      limit: '50',
    });
    // Manual fetch: `included` carries the version strings.
    const doc = await this.req<JsonApiDoc>('GET', `/v1/reviewSubmissions/${submissionId}/items?${params}`);
    const rows = (Array.isArray(doc.data) ? doc.data : [doc.data]).filter(Boolean);
    const versionById = new Map(
      (doc.included ?? [])
        .filter((r) => r.type === 'appStoreVersions')
        .map((r) => [r.id, s(r.attributes?.versionString)]),
    );
    return rows.map((r) => {
      const rel = r.relationships?.appStoreVersion?.data;
      const versionId = rel && !Array.isArray(rel) ? rel.id : null;
      return {
        id: r.id,
        state: s(r.attributes?.state),
        itemType: versionId ? 'appStoreVersions' : Object.keys(r.relationships ?? {})[0] ?? 'unknown',
        versionString: versionId ? (versionById.get(versionId) ?? null) : null,
      };
    });
  }

  // ---- TestFlight management ----

  private mapTester(r: JsonApiResource): AscBetaTester {
    return {
      id: r.id,
      email: s(r.attributes?.email),
      firstName: s(r.attributes?.firstName),
      lastName: s(r.attributes?.lastName),
      inviteType: s(r.attributes?.inviteType),
    };
  }

  async listBetaTesters(groupId: string): Promise<AscBetaTester[]> {
    const rows = await this.paginate(
      `/v1/betaGroups/${groupId}/betaTesters?limit=200&fields[betaTesters]=email,firstName,lastName,inviteType`,
      5,
    );
    return rows.map((r) => this.mapTester(r));
  }

  async createBetaTester(groupId: string, email: string, firstName?: string, lastName?: string): Promise<AscBetaTester> {
    const doc = await this.req<JsonApiDoc>('POST', '/v1/betaTesters', {
      data: {
        type: 'betaTesters',
        attributes: {
          email,
          ...(firstName ? { firstName } : {}),
          ...(lastName ? { lastName } : {}),
        },
        relationships: { betaGroups: { data: [{ type: 'betaGroups', id: groupId }] } },
      },
    });
    return this.mapTester(doc.data as JsonApiResource);
  }

  async removeBetaTesterFromGroup(groupId: string, testerId: string): Promise<void> {
    await this.req('DELETE', `/v1/betaGroups/${groupId}/relationships/betaTesters`, {
      data: [{ type: 'betaTesters', id: testerId }],
    });
  }

  // ---- Pricing ----

  async listPricePoints(appId: string, territory = 'USA'): Promise<AscPricePoint[]> {
    const rows = await this.paginate(
      `/v1/apps/${appId}/appPricePoints?filter[territory]=${territory}&fields[appPricePoints]=customerPrice,proceeds&limit=200`,
      5,
    );
    return rows
      .map((r) => ({
        id: r.id,
        customerPrice: s(r.attributes?.customerPrice),
        proceeds: s(r.attributes?.proceeds),
      }))
      .sort((a, b) => Number(a.customerPrice) - Number(b.customerPrice));
  }

  async setPriceSchedule(appId: string, pricePointId: string, baseTerritory = 'USA'): Promise<void> {
    // Replaces the schedule with a single ongoing manual price (Apple's documented
    // create-appPriceSchedules shape: the appPrices come inline via `included`).
    await this.req('POST', '/v1/appPriceSchedules', {
      data: {
        type: 'appPriceSchedules',
        relationships: {
          app: { data: { type: 'apps', id: appId } },
          baseTerritory: { data: { type: 'territories', id: baseTerritory } },
          manualPrices: { data: [{ type: 'appPrices', id: '${price-1}' }] },
        },
      },
      included: [
        {
          id: '${price-1}',
          type: 'appPrices',
          attributes: { startDate: null },
          relationships: { appPricePoint: { data: { type: 'appPricePoints', id: pricePointId } } },
        },
      ],
    });
  }

  // ---- Apple Developer provisioning ----

  private mapBundleId(r: JsonApiResource): AscBundleId {
    return {
      id: r.id,
      identifier: s(r.attributes?.identifier),
      name: s(r.attributes?.name),
      platform: s(r.attributes?.platform),
      seedId: s(r.attributes?.seedId),
    };
  }

  async listBundleIds(): Promise<AscBundleId[]> {
    const rows = await this.paginate('/v1/bundleIds?limit=200&sort=name&fields[bundleIds]=identifier,name,platform,seedId', 5);
    return rows.map((r) => this.mapBundleId(r));
  }

  async createBundleId(identifier: string, name: string, platform: string): Promise<AscBundleId> {
    const doc = await this.req<JsonApiDoc>('POST', '/v1/bundleIds', {
      data: { type: 'bundleIds', attributes: { identifier, name, platform } },
    });
    return this.mapBundleId(doc.data as JsonApiResource);
  }

  async deleteBundleId(id: string): Promise<void> {
    await this.req('DELETE', `/v1/bundleIds/${id}`);
  }

  // ---- Subscription creation ----

  async createSubscriptionGroup(appId: string, referenceName: string): Promise<{ id: string; name: string }> {
    const doc = await this.req<JsonApiDoc>('POST', '/v1/subscriptionGroups', {
      data: {
        type: 'subscriptionGroups',
        attributes: { referenceName },
        relationships: { app: { data: { type: 'apps', id: appId } } },
      },
    });
    const r = doc.data as JsonApiResource;
    return { id: r.id, name: s(r.attributes?.referenceName) };
  }

  async createSubscription(
    groupId: string,
    attrs: { name: string; productId: string; period: string; groupLevel: number },
  ): Promise<{ id: string; name: string; productId: string; state: string; period: string }> {
    const doc = await this.req<JsonApiDoc>('POST', '/v1/subscriptions', {
      data: {
        type: 'subscriptions',
        attributes: {
          name: attrs.name,
          productId: attrs.productId,
          subscriptionPeriod: attrs.period,
          groupLevel: attrs.groupLevel,
        },
        relationships: { group: { data: { type: 'subscriptionGroups', id: groupId } } },
      },
    });
    const r = doc.data as JsonApiResource;
    return {
      id: r.id,
      name: s(r.attributes?.name),
      productId: s(r.attributes?.productId),
      state: s(r.attributes?.state) || 'MISSING_METADATA',
      period: s(r.attributes?.subscriptionPeriod),
    };
  }

  async createSubscriptionLocalization(subscriptionId: string, locale: string, name: string, description: string): Promise<void> {
    await this.req('POST', '/v1/subscriptionLocalizations', {
      data: {
        type: 'subscriptionLocalizations',
        attributes: { locale, name, description },
        relationships: { subscription: { data: { type: 'subscriptions', id: subscriptionId } } },
      },
    });
  }

  async submitSubscription(subscriptionId: string): Promise<void> {
    await this.req('POST', '/v1/subscriptionSubmissions', {
      data: {
        type: 'subscriptionSubmissions',
        relationships: { subscription: { data: { type: 'subscriptions', id: subscriptionId } } },
      },
    });
  }

  // ---- Age rating ----

  async getAgeRatingDeclaration(appInfoId: string): Promise<AscAgeRating | null> {
    const r = await this.getOrNull(`/v1/appInfos/${appInfoId}/ageRatingDeclaration`, 'age rating');
    return r ? { id: r.id, attributes: (r.attributes ?? {}) as Record<string, unknown> } : null;
  }

  async updateAgeRatingDeclaration(id: string, attributes: Record<string, unknown>): Promise<AscAgeRating> {
    const doc = await this.req<JsonApiDoc>('PATCH', `/v1/ageRatingDeclarations/${id}`, {
      data: { type: 'ageRatingDeclarations', id, attributes },
    });
    const r = doc.data as JsonApiResource;
    return { id: r.id, attributes: (r.attributes ?? {}) as Record<string, unknown> };
  }

  // ---- Customer reviews ----

  async listCustomerReviews(appId: string, limit = 50): Promise<AscCustomerReview[]> {
    const params = new URLSearchParams({
      sort: '-createdDate',
      limit: String(Math.min(limit, 200)),
      include: 'response',
      'fields[customerReviews]': 'rating,title,body,reviewerNickname,createdDate,territory,response',
      'fields[customerReviewResponses]': 'responseBody,lastModifiedDate,state',
    });
    // Manual fetch: paginate() drops `included`, which carries the responses.
    const doc = await this.req<JsonApiDoc>('GET', `/v1/apps/${appId}/customerReviews?${params}`);
    const rows = Array.isArray(doc.data) ? doc.data : [doc.data].filter(Boolean);
    const responses = new Map(
      (doc.included ?? [])
        .filter((i) => i.type === 'customerReviewResponses')
        .map((i) => [i.id, i] as const),
    );
    return rows.map((r) => {
      const rel = r.relationships?.response?.data;
      const respRef = rel && !Array.isArray(rel) ? responses.get(rel.id) : undefined;
      return {
        id: r.id,
        rating: (r.attributes?.rating as number | undefined) ?? 0,
        title: s(r.attributes?.title),
        body: s(r.attributes?.body),
        reviewerNickname: s(r.attributes?.reviewerNickname),
        createdDate: s(r.attributes?.createdDate),
        territory: s(r.attributes?.territory),
        response: respRef
          ? {
              id: respRef.id,
              body: s(respRef.attributes?.responseBody),
              lastModified: s(respRef.attributes?.lastModifiedDate),
              state: s(respRef.attributes?.state),
            }
          : null,
      };
    });
  }

  async respondToReview(reviewId: string, body: string): Promise<void> {
    await this.req('POST', '/v1/customerReviewResponses', {
      data: {
        type: 'customerReviewResponses',
        attributes: { responseBody: body },
        relationships: { review: { data: { type: 'customerReviews', id: reviewId } } },
      },
    });
  }

  async deleteReviewResponse(responseId: string): Promise<void> {
    await this.req('DELETE', `/v1/customerReviewResponses/${responseId}`);
  }

  // ---- Commerce & distribution summaries ----

  async listRecentBuilds(appId: string, limit = 10): Promise<AscBuild[]> {
    const params = new URLSearchParams({
      'filter[app]': appId,
      'fields[builds]': 'version,uploadedDate,processingState,expired,usesNonExemptEncryption,iconAssetToken',
      sort: '-uploadedDate',
      limit: String(Math.min(limit, 50)),
    });
    const doc = await this.req<JsonApiDoc>('GET', `/v1/builds?${params}`);
    const rows = Array.isArray(doc.data) ? doc.data : [doc.data].filter(Boolean);
    return rows.map((r) => this.mapBuild(r));
  }

  async getAvailabilitySummary(appId: string): Promise<AscAvailabilitySummary> {
    const availability = await this.getOrNull(
      `/v1/apps/${appId}/appAvailabilityV2?fields[appAvailabilities]=availableInNewTerritories`,
      'availability',
    );
    let available = 0;
    let total = 0;
    if (availability) {
      const rows = await this.paginate(
        `/v2/appAvailabilities/${availability.id}/territoryAvailabilities?limit=200&fields[territoryAvailabilities]=available`,
        4,
      );
      total = rows.length;
      available = rows.filter((r) => r.attributes?.available === true).length;
    }
    return {
      availableInNewTerritories:
        (availability?.attributes?.availableInNewTerritories as boolean | undefined) ?? null,
      availableTerritories: available,
      totalTerritories: total,
    };
  }

  async getPriceSummary(appId: string): Promise<AscPriceSummary> {
    const base = await this.getOrNull(`/v1/apps/${appId}/appPriceSchedule/baseTerritory`, 'price base');
    const doc = await this.req<JsonApiDoc>(
      'GET',
      `/v1/apps/${appId}/appPriceSchedule/manualPrices?include=appPricePoint&limit=50`,
      undefined,
      'manual prices',
    ).catch(() => null);
    if (!doc) return { baseTerritory: base?.id ?? null, customerPrice: null, proceeds: null };
    const rows = Array.isArray(doc.data) ? doc.data : [doc.data].filter(Boolean);
    const points = new Map((doc.included ?? []).map((i) => [i.id, i] as const));
    // Prefer the price entry for the base territory; else the first row.
    const pick =
      rows.find((r) => {
        const t = r.relationships?.territory?.data;
        return t && !Array.isArray(t) && t.id === base?.id;
      }) ?? rows[0];
    const pointRef = pick?.relationships?.appPricePoint?.data;
    const point = pointRef && !Array.isArray(pointRef) ? points.get(pointRef.id) : undefined;
    return {
      baseTerritory: base?.id ?? null,
      customerPrice: point ? s(point.attributes?.customerPrice) || null : null,
      proceeds: point ? s(point.attributes?.proceeds) || null : null,
    };
  }

  async listInAppPurchases(appId: string): Promise<AscIap[]> {
    const rows = await this.paginate(
      `/v1/apps/${appId}/inAppPurchasesV2?limit=200&fields[inAppPurchases]=name,productId,inAppPurchaseType,state`,
      3,
    );
    return rows.map((r) => ({
      id: r.id,
      name: s(r.attributes?.name),
      productId: s(r.attributes?.productId),
      type: s(r.attributes?.inAppPurchaseType),
      state: s(r.attributes?.state),
    }));
  }

  async listSubscriptionGroups(appId: string): Promise<AscSubscriptionGroup[]> {
    const groups = await this.paginate(
      `/v1/apps/${appId}/subscriptionGroups?limit=50&fields[subscriptionGroups]=referenceName`,
    );
    const out: AscSubscriptionGroup[] = [];
    for (const g of groups) {
      const subs = await this.paginate(
        `/v1/subscriptionGroups/${g.id}/subscriptions?limit=50&fields[subscriptions]=name,productId,state,subscriptionPeriod`,
      );
      out.push({
        id: g.id,
        name: s(g.attributes?.referenceName),
        subscriptions: subs.map((sub) => ({
          id: sub.id,
          name: s(sub.attributes?.name),
          productId: s(sub.attributes?.productId),
          state: s(sub.attributes?.state),
          period: s(sub.attributes?.subscriptionPeriod),
        })),
      });
    }
    return out;
  }

  async getEulaText(appId: string): Promise<string | null> {
    const r = await this.getOrNull(
      `/v1/apps/${appId}/endUserLicenseAgreement?fields[endUserLicenseAgreements]=agreementText`,
      'EULA',
    );
    return r ? s(r.attributes?.agreementText) || null : null;
  }

  async listCustomProductPages(appId: string): Promise<AscProductPage[]> {
    const rows = await this.paginate(
      `/v1/apps/${appId}/appCustomProductPages?limit=50&fields[appCustomProductPages]=name,visible`,
    );
    return rows.map((r) => ({
      id: r.id,
      name: s(r.attributes?.name),
      visible: r.attributes?.visible === true,
    }));
  }

  async listExperiments(appId: string): Promise<AscExperiment[]> {
    const rows = await this.paginate(
      `/v1/apps/${appId}/appStoreVersionExperimentsV2?limit=50&fields[appStoreVersionExperiments]=name,state,trafficProportion`,
    );
    return rows.map((r) => ({
      id: r.id,
      name: s(r.attributes?.name),
      state: s(r.attributes?.state),
      trafficProportion: (r.attributes?.trafficProportion as number | undefined) ?? null,
    }));
  }

  async listAppEvents(appId: string): Promise<AscAppEvent[]> {
    const rows = await this.paginate(
      `/v1/apps/${appId}/appEvents?limit=50&fields[appEvents]=referenceName,eventState`,
    );
    return rows.map((r) => ({
      id: r.id,
      name: s(r.attributes?.referenceName),
      state: s(r.attributes?.eventState),
    }));
  }

  async listPreviewSets(versionLocId: string): Promise<AscPreviewSet[]> {
    const sets = await this.paginate(
      `/v1/appStoreVersionLocalizations/${versionLocId}/appPreviewSets?limit=50&fields[appPreviewSets]=previewType`,
    );
    const out: AscPreviewSet[] = [];
    for (const set of sets) {
      const previews = await this.paginate(`/v1/appPreviewSets/${set.id}/appPreviews?limit=50&fields[appPreviews]=fileName`);
      out.push({ id: set.id, previewType: s(set.attributes?.previewType), previewCount: previews.length });
    }
    return out;
  }

  async listBetaGroups(appId: string): Promise<AscBetaGroup[]> {
    const params = new URLSearchParams({
      'filter[app]': appId,
      'fields[betaGroups]': 'name,isInternalGroup,publicLinkEnabled,publicLink',
      limit: '50',
    });
    const rows = await this.paginate(`/v1/betaGroups?${params}`);
    return rows.map((r) => ({
      id: r.id,
      name: s(r.attributes?.name),
      isInternal: r.attributes?.isInternalGroup === true,
      publicLink: r.attributes?.publicLinkEnabled === true ? s(r.attributes?.publicLink) || null : null,
    }));
  }

  async listEncryptionDeclarations(appId: string): Promise<AscEncryptionDeclaration[]> {
    // The apps→appEncryptionDeclarations relationship path 404s on the live API;
    // the collection endpoint with an app filter is the supported form.
    const params = new URLSearchParams({
      'filter[app]': appId,
      'fields[appEncryptionDeclarations]': 'appEncryptionDeclarationState,usesEncryption,createdDate',
      limit: '20',
    });
    const rows = await this.paginate(`/v1/appEncryptionDeclarations?${params}`, 1);
    return rows.map((r) => ({
      id: r.id,
      state: s(r.attributes?.appEncryptionDeclarationState),
      usesEncryption: (r.attributes?.usesEncryption as boolean | undefined) ?? null,
      createdDate: (r.attributes?.createdDate as string | undefined) ?? null,
    }));
  }
}
