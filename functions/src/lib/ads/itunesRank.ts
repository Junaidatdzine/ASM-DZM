import { isEmulator } from '../../config';
import { makeLimiter } from '../asc/client';

/**
 * Organic App Store search ranking via Apple's public iTunes Search API —
 * where an app actually places when a customer types the keyword. Apple Ads
 * has no endpoint for this; the iTunes Search API is the same source ASO
 * tools use (top 200 results per storefront).
 */

export interface KeywordRank {
  term: string;
  /** 1-based position in App Store search results; null = not in the top 200. */
  rank: number | null;
  /** How many apps compete for the term (capped at 200 by the API). */
  results: number;
}

interface ItunesSearchResponse {
  resultCount?: number;
  results?: Array<{ trackId?: number }>;
}

/** Pure mapper, exported for tests. */
export function rankFromResults(doc: ItunesSearchResponse, adamId: number): { rank: number | null; results: number } {
  const list = doc.results ?? [];
  const idx = list.findIndex((r) => r.trackId === adamId);
  return { rank: idx >= 0 ? idx + 1 : null, results: doc.resultCount ?? list.length };
}

/** Deterministic offline ranks so the flow is demoable in the emulator. */
function mockRank(term: string, adamId: number): KeywordRank {
  let h = 0;
  const seed = `${term}:${adamId}`;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  const x = Math.abs(h) % 100;
  return { term, rank: x < 15 ? null : (x % 40) + 1, results: 120 + (x % 80) };
}

// Apple throttles this API per IP — keep concurrency polite.
const limit = makeLimiter(4);

export async function fetchKeywordRanks(
  terms: string[],
  country: string,
  adamId: number,
): Promise<KeywordRank[]> {
  if (isEmulator()) return terms.map((t) => mockRank(t, adamId));
  return Promise.all(
    terms.map((term) =>
      limit(async (): Promise<KeywordRank> => {
        const params = new URLSearchParams({
          term,
          country: country.toLowerCase(),
          media: 'software',
          entity: 'software',
          limit: '200',
        });
        const res = await fetch(`https://itunes.apple.com/search?${params}`, {
          signal: AbortSignal.timeout(12_000),
        }).catch(() => null);
        if (!res || !res.ok) return { term, rank: null, results: 0 };
        const doc = (await res.json().catch(() => ({}))) as ItunesSearchResponse;
        return { term, ...rankFromResults(doc, adamId) };
      }),
    ),
  );
}
