import { AppError } from './errors';

const round2 = (n: number) => Math.round(n * 100) / 100;

let cache: { at: number; rates: Record<string, number> } | null = null;

/** USD→currency rates (frankfurter.dev), cached ~6h per instance. */
export async function usdRates(currencies: string[]): Promise<Record<string, number>> {
  const wanted = [...new Set(currencies.filter((c) => c && c !== 'USD'))];
  if (wanted.length === 0) return { USD: 1 };
  if (cache && Date.now() - cache.at < 6 * 3600_000 && wanted.every((c) => cache!.rates[c])) {
    return cache.rates;
  }
  const response = await fetch(
    `https://api.frankfurter.dev/v1/latest?base=USD&symbols=${encodeURIComponent(wanted.join(','))}`,
    { signal: AbortSignal.timeout(8_000) },
  );
  if (!response.ok) throw new AppError('unavailable', 'Currency conversion service is temporarily unavailable.');
  const body = (await response.json()) as { rates?: Record<string, number> };
  cache = { at: Date.now(), rates: { USD: 1, ...(body.rates ?? {}) } };
  return cache.rates;
}

/** Convert a currency→amount map into a USD total. Unknown currencies are skipped, not mislabeled. */
export function toUsd(values: Record<string, number>, rates: Record<string, number>): number {
  return round2(
    Object.entries(values).reduce((sum, [currency, amount]) => {
      if (currency === 'USD') return sum + amount;
      const perUsd = rates[currency];
      return perUsd && perUsd > 0 ? sum + amount / perUsd : sum;
    }, 0),
  );
}
