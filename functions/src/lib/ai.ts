import { GoogleGenAI, Type, type Schema } from '@google/genai';
import { DEFAULT_SETTINGS, localeName, type GlobalSettingsDoc } from '@asm/shared';
import { AppError } from './errors';
import { FieldValue, db, refs } from './firestore';
import { isEmulator } from '../config';
import { appendLegalLinks, sanitizeAppStoreText } from './appStoreText';

let client: GoogleGenAI | null = null;

function ai(): GoogleGenAI {
  if (!client) {
    const project = process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT;
    client = new GoogleGenAI({ vertexai: true, project, location: 'us-central1' });
  }
  return client;
}

export async function aiModel(): Promise<string> {
  const snap = await refs.settings().get();
  const settings = (snap.exists ? snap.data() : DEFAULT_SETTINGS) as GlobalSettingsDoc;
  return settings.aiModel || DEFAULT_SETTINGS.aiModel;
}

/**
 * Deterministic offline pseudo-translation for the emulator: keeps flows, limits and
 * review UX testable without Vertex access. Marks values clearly as machine output.
 */
function pseudoTranslate(fields: Record<string, string>, targetLocale: string, limits: Record<string, number>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    const limit = limits[key] ?? 4000;
    const tagged = `[${targetLocale}] ${value}`;
    out[key] = tagged.length > limit ? tagged.slice(0, limit) : tagged;
  }
  return out;
}

export interface BatchTranslateRequest {
  sourceLocale: string;
  appName: string;
  /** fieldKey → source text (only non-empty, target-editable fields). */
  fields: Record<string, string>;
  /** fieldKey → char limit. */
  limits: Record<string, number>;
  /** fieldKey → human label. */
  labels: Record<string, string>;
  /** Per target locale, the subset of fieldKeys that actually need translating. */
  perLocale: Array<{ locale: string; fieldKeys: string[] }>;
}

const MAX_TRANSLATION_LOCALES_PER_CALL = 8;

/**
 * Detects code-style placeholder junk that must never ship in store metadata:
 * locale tags ("en-US", "zh-Hans") and long numeric identifiers (6+ digits).
 * Legit text like "1,000,000 users" or years is untouched (commas break runs).
 */
export function looksLikePlaceholderJunk(text: string): boolean {
  return /\b[a-z]{2}-(?:[A-Z]{2}|Hans|Hant)\b/.test(text) || /\d{6,}/.test(text);
}

async function translateChunk(
  req: BatchTranslateRequest,
  initial: Array<{ locale: string; fieldKeys: string[] }>,
  model: string,
  issues?: Map<string, string>,
): Promise<Record<string, Record<string, string>>> {
  const collected: Record<string, Record<string, string>> = {};
  let remaining = initial;

  for (let attempt = 0; attempt < 3 && remaining.length > 0; attempt++) {
    // (issues map records the newest human-readable reason per locale)
    const localeProps: Record<string, Schema> = {};
    for (const { locale, fieldKeys } of remaining) {
      const fieldProps: Record<string, Schema> = {};
      for (const key of fieldKeys) fieldProps[key] = { type: Type.STRING };
      localeProps[locale] = { type: Type.OBJECT, properties: fieldProps, required: fieldKeys };
    }
    const schema: Schema = {
      type: Type.OBJECT,
      properties: localeProps,
      required: remaining.map((item) => item.locale),
    };
    const usedKeys = [...new Set(remaining.flatMap((item) => item.fieldKeys))];
    const fieldLines = usedKeys
      .map((key) => `- ${key} (${req.labels[key]}, HARD LIMIT ${req.limits[key]} characters):\n${req.fields[key]}`)
      .join('\n\n');
    const targetLines = remaining
      .map((item) => `- ${item.locale} (${localeName(item.locale)}): fields ${item.fieldKeys.join(', ')}`)
      .join('\n');
    const retryRule = attempt > 0
      ? '\nThis is a retry for outputs that were missing or too long. Shorten decisively and return every requested value.'
      : '';
    const prompt = `Localize App Store metadata for the iOS app "${req.appName}", source language ${localeName(req.sourceLocale)} (${req.sourceLocale}).

Rules:
- Marketing tone for each target market; natural, not literal.
- Plain text only. Never use Markdown, HTML, emoji, decorative symbols, or formatting markers.
- Be accurate and specific. Never invent features, awards, rankings, prices, guarantees, or competitor claims.
- NEVER exceed a field's character limit (count every character incl. commas/spaces).
- "keywords" fields are comma-separated search terms: adapt each, no spaces after commas, total within limit.
- Preserve the app's real brand name — but technical junk that may appear in the source (locale tags like "en-US", long numeric IDs, internal codes) is placeholder noise: NEVER copy it into any output. Write the clean, natural text a real App Store listing would show.
- Every output must be a genuine translation/localization for its target language, never the source text repeated verbatim.${retryRule}

Source fields:
${fieldLines}

Produce complete JSON keyed by locale, each with ONLY the requested fields:
${targetLines}`;

    let parsed: Record<string, Record<string, string>> = {};
    try {
      const res = await ai().models.generateContent({
        model,
        contents: prompt,
        config: { responseMimeType: 'application/json', responseSchema: schema, temperature: 0.25 },
      });
      parsed = JSON.parse(res.text ?? '{}') as Record<string, Record<string, string>>;
    } catch {
      continue;
    }

    const retry: Array<{ locale: string; fieldKeys: string[] }> = [];
    for (const { locale, fieldKeys } of remaining) {
      const got = parsed[locale] ?? {};
      const missing: string[] = [];
      for (const key of fieldKeys) {
        const value = got[key];
        if (typeof value !== 'string' || value.trim() === '' || value.trim().length > (req.limits[key] ?? 4000)) {
          missing.push(key);
          issues?.set(locale, 'The AI returned nothing (or an over-limit value) for this language');
          continue;
        }
        const clean = sanitizeAppStoreText(value);
        if (looksLikePlaceholderJunk(clean)) {
          missing.push(key);
          issues?.set(locale, 'The AI kept placeholder codes (like "en-US" or long IDs) instead of real text');
          continue;
        }
        const source = req.fields[key] ?? '';
        if (looksLikePlaceholderJunk(source) && clean.trim() === source.trim()) {
          missing.push(key);
          issues?.set(locale, 'The AI copied the source placeholder text unchanged');
          continue;
        }
        (collected[locale] ??= {})[key] = clean;
        issues?.delete(locale);
      }
      if (missing.length > 0) retry.push({ locale, fieldKeys: missing });
    }
    remaining = retry;
  }

  return collected;
}

/**
 * Translate many locales in bounded chunks. Smaller schemas make Gemini reliably
 * return every locale, while field-level retries only regenerate missing/over-limit values.
 */
export async function translateBatch(
  req: BatchTranslateRequest,
  issues?: Map<string, string>,
): Promise<Record<string, Record<string, string>>> {
  const need = req.perLocale.filter((p) => p.fieldKeys.length > 0);
  if (need.length === 0) return {};

  if (isEmulator()) {
    const out: Record<string, Record<string, string>> = {};
    for (const { locale, fieldKeys } of need) {
      const subset = Object.fromEntries(fieldKeys.map((k) => [k, req.fields[k] ?? '']));
      out[locale] = pseudoTranslate(subset, locale, req.limits);
    }
    return out;
  }

  const model = await aiModel();
  const collected: Record<string, Record<string, string>> = {};
  for (let offset = 0; offset < need.length; offset += MAX_TRANSLATION_LOCALES_PER_CALL) {
    const chunk = need.slice(offset, offset + MAX_TRANSLATION_LOCALES_PER_CALL);
    const translated = await translateChunk(req, chunk, model, issues);
    for (const [locale, values] of Object.entries(translated)) {
      collected[locale] = { ...(collected[locale] ?? {}), ...values };
    }
  }

  // Structured multi-locale responses can occasionally omit one locale even
  // after the chunk retries. Recover only those missing fields with a final
  // single-locale request; credits are charged by the caller once per target,
  // so these reliability retries never consume additional credits.
  for (const item of need) {
    const missing = item.fieldKeys.filter((key) => {
      const value = collected[item.locale]?.[key];
      return typeof value !== 'string' || value.trim() === '';
    });
    if (missing.length === 0) continue;
    const recovered = await translateChunk(
      req,
      [{ locale: item.locale, fieldKeys: missing }],
      model,
      issues,
    );
    const values = recovered[item.locale];
    if (values) collected[item.locale] = { ...(collected[item.locale] ?? {}), ...values };
  }
  return collected;
}

export interface GenerateRequest {
  kind: 'name' | 'keywords' | 'subtitle' | 'improve-description' | 'promotional-text' | 'whatsnew';
  appName: string;
  locale: string;
  currentValue: string;
  context?: string;
  limit: number;
  privacyPolicyUrl?: string;
  termsUrl?: string;
}

export async function generateSuggestions(req: GenerateRequest): Promise<string[]> {
  if (isEmulator()) {
    const stub = {
      name: ['Plantly Care', 'Flora Guide', 'Plant Keeper'],
      keywords: ['plants,garden,care,watering,botany', 'plant care,gardening,greenery', 'flora,grow,water reminder'],
      subtitle: ['Care that keeps plants alive', 'Your pocket plant expert', 'Water. Light. Thrive.'],
      'improve-description': [
        `${req.currentValue}\n\n(Improved for clarity and benefits — emulator stub.)`,
      ],
      'promotional-text': ['Make everyday plant care simpler with timely guidance and practical insights.'],
      whatsnew: [`• ${req.context || 'Improvements and fixes'}\n• Performance improvements`],
    }[req.kind];
    return stub.map((s) => req.kind === 'improve-description'
      ? appendLegalLinks(s, req.limit, req)
      : sanitizeAppStoreText(s).slice(0, req.limit));
  }

  const model = await aiModel();
  const prompts: Record<GenerateRequest['kind'], string> = {
    name: `Generate 5 distinctive App Store name options for the app "${req.appName}" in ${localeName(req.locale)}, each ≤${req.limit} characters. Preserve the product's purpose, use natural search-friendly language, and avoid generic AI wording. Current name: "${req.currentValue}".`,
    keywords: `Generate 3 alternative keyword strings for the iOS app "${req.appName}" in ${localeName(req.locale)}. Each is a comma-separated list (no spaces after commas), ≤${req.limit} characters TOTAL, high-intent App Store search terms. Avoid duplicating words from the app name. Current keywords: "${req.currentValue}".`,
    subtitle: `Generate 5 App Store subtitle options for "${req.appName}" in ${localeName(req.locale)}, each ≤${req.limit} characters, benefit-led, no generic fluff. Current: "${req.currentValue}".`,
    'improve-description': `Rewrite this App Store description for "${req.appName}" in ${localeName(req.locale)} to be clearer and more persuasive. Keep structure scannable using plain headings and short paragraphs, ≤${req.limit} characters. Return 1 option.\n\nCurrent:\n${req.currentValue}`,
    'promotional-text': `Generate 3 concise App Store promotional text options for "${req.appName}" in ${localeName(req.locale)}, each ≤${req.limit} characters. Lead with the most timely benefit, avoid unsupported claims, and keep the tone natural. Current: "${req.currentValue}".`,
    whatsnew: `Write App Store release notes ("What's New") for "${req.appName}" in ${localeName(req.locale)}, ≤${req.limit} characters, based on: ${req.context || 'general improvements'}. Friendly, concise, one improvement per plain-text line.`,
  };

  const policyRules = `\n\nMandatory App Store rules: plain text only; no Markdown, HTML, emoji, decorative characters, or formatting markers. Only describe verified information supplied in the request. Do not invent features, awards, rankings, pricing, guarantees, medical claims, competitor comparisons, or trademark claims. Keep URLs unchanged. Return text within the stated field limit.`;

  const res = await ai().models.generateContent({
    model,
    contents: prompts[req.kind] + policyRules,
    config: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: { options: { type: Type.ARRAY, items: { type: Type.STRING } } },
        required: ['options'],
      },
      temperature: 0.7,
    },
  });
  try {
    const parsed = JSON.parse(res.text ?? '{}') as { options?: string[] };
    return (parsed.options ?? [])
      .filter((o) => typeof o === 'string' && o.trim() !== '')
      .map((o) => req.kind === 'improve-description'
        ? appendLegalLinks(o, req.limit, req)
        : sanitizeAppStoreText(o).slice(0, req.limit).trim())
      .filter(Boolean);
  } catch {
    throw new AppError('internal', 'The AI returned an unexpected response. Try again.');
  }
}

export interface ReviewReplyRequest {
  appName: string;
  /** Grounding context from the app's own metadata (primary-locale description, subtitle). */
  appDescription: string;
  supportUrl?: string;
  rating: number;
  title: string;
  body: string;
  reviewerNickname: string;
  /** Regenerate hint — nudges variety on repeated calls. */
  attempt?: number;
}

const REVIEW_REPLY_MAX = 900;

/** Draft a public developer response to a customer review, grounded in the app's metadata. */
export async function generateReviewReply(req: ReviewReplyRequest): Promise<string> {
  if (isEmulator()) {
    const opener = req.rating >= 4 ? 'Thank you so much for the kind words' : 'Thanks for the honest feedback, and sorry this fell short';
    return sanitizeAppStoreText(
      `${opener}, ${req.reviewerNickname}. ${req.rating >= 4
        ? `We're glad ${req.appName} is helping!`
        : `We're looking into what you described ("${req.title}").`} ${req.supportUrl ? `If anything else comes up, reach us at ${req.supportUrl}.` : ''} (emulator stub${req.attempt ? ` #${req.attempt}` : ''})`,
    ).slice(0, REVIEW_REPLY_MAX);
  }

  const model = await aiModel();
  const prompt = `You are the developer of the iOS app "${req.appName}" replying publicly to an App Store customer review.

About the app (verified metadata — the ONLY facts you may use):
${req.appDescription || '(no description provided)'}
${req.supportUrl ? `Support contact: ${req.supportUrl}` : ''}

The review (${req.rating}/5 stars, by "${req.reviewerNickname}"):
Title: ${req.title || '(none)'}
${req.body}

Write ONE reply:
- Same language as the review.
- 2–4 sentences, ≤${REVIEW_REPLY_MAX} characters, plain text only (no Markdown, emoji, or signatures).
- Thank the reviewer and address their specific points concretely.
- For problems: acknowledge honestly, avoid excuses${req.supportUrl ? ', and point to the support contact above' : ''}.
- Never invent features, fixes, release dates, refunds, or compensation. Never argue, shame, or ask for a rating change.${req.attempt ? `\n- Provide a fresh phrasing different from previous drafts (variant ${req.attempt}).` : ''}`;

  const res = await ai().models.generateContent({
    model,
    contents: prompt,
    config: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: { reply: { type: Type.STRING } },
        required: ['reply'],
      },
      temperature: 0.6,
    },
  });
  try {
    const parsed = JSON.parse(res.text ?? '{}') as { reply?: string };
    const reply = sanitizeAppStoreText(parsed.reply ?? '').slice(0, REVIEW_REPLY_MAX).trim();
    if (!reply) throw new Error('empty');
    return reply;
  } catch {
    throw new AppError('internal', 'The AI returned an unexpected response. Try again.');
  }
}

/** Atomically consume AI credits; throws a friendly error when the budget is gone. */
export async function consumeAiCredits(uid: string, amount: number): Promise<void> {
  const month = new Date().toISOString().slice(0, 7);
  await db().runTransaction(async (tx) => {
    const ref = refs.user(uid);
    const snap = await tx.get(ref);
    if (!snap.exists) throw new AppError('permission-denied', 'User not found.');
    const ai = (snap.data() as { ai?: { monthlyCredits?: number; usage?: { month: string; used: number } } }).ai;
    const monthly = ai?.monthlyCredits ?? 0;
    const used = ai?.usage?.month === month ? ai.usage.used : 0;
    if (used + amount > monthly) {
      throw new AppError(
        'resource-exhausted',
        `Not enough AI credits: this needs ${amount}, you have ${Math.max(0, monthly - used)} left this month. Ask an admin to raise your limit.`,
      );
    }
    tx.update(ref, { 'ai.usage': { month, used: used + amount } });
  });
}

export { FieldValue };
