export interface LegalLinks {
  termsUrl?: string;
  privacyPolicyUrl?: string;
}

/** Convert model output to App Store plain text without damaging localized scripts. */
export function sanitizeAppStoreText(value: string): string {
  return value
    .replace(/```[a-z]*\n?/gi, '')
    .replace(/`/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/^\s*[-*+•]\s+/gm, '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function appendLegalLinks(value: string, limit: number, links: LegalLinks): string {
  const legal = [
    links.termsUrl?.trim() ? `Terms of Use: ${links.termsUrl.trim()}` : '',
    links.privacyPolicyUrl?.trim() ? `Privacy Policy: ${links.privacyPolicyUrl.trim()}` : '',
  ].filter(Boolean).join('\n');
  const clean = sanitizeAppStoreText(value);
  if (!legal) return clean.slice(0, limit).trim();
  const suffix = `\n\n${legal}`;
  const room = Math.max(0, limit - suffix.length);
  return `${clean.slice(0, room).trimEnd()}${suffix}`.trim().slice(0, limit);
}
