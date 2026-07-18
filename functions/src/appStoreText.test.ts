import { describe, expect, it } from 'vitest';
import { appendLegalLinks, sanitizeAppStoreText } from './lib/appStoreText';
import { looksLikePlaceholderJunk } from './lib/ai';

describe('App Store text policy', () => {
  it('removes markdown, html, emoji and keeps localized scripts', () => {
    expect(sanitizeAppStoreText('## **ميزات** 🚀\n* تحرير سريع\n<div>آمن</div>'))
      .toBe('ميزات\nتحرير سريع\nآمن');
  });

  it('appends real legal links within the field limit', () => {
    const value = appendLegalLinks('A useful app', 4000, {
      termsUrl: 'https://www.apple.com/legal/internet-services/itunes/dev/stdeula/',
      privacyPolicyUrl: 'https://example.com/privacy',
    });
    expect(value).toContain('Terms of Use: https://www.apple.com/');
    expect(value).toContain('Privacy Policy: https://example.com/privacy');
  });
});

describe('looksLikePlaceholderJunk', () => {
  it('flags locale tags and long numeric ids', () => {
    expect(looksLikePlaceholderJunk('Smart Printer en-US-6792260195')).toBe(true);
    expect(looksLikePlaceholderJunk('Smart printer Ap ca-6792260195')).toBe(true);
    expect(looksLikePlaceholderJunk('App zh-Hans edition')).toBe(true);
    expect(looksLikePlaceholderJunk('Build 123456')).toBe(true);
  });
  it('leaves real marketing text alone', () => {
    expect(looksLikePlaceholderJunk('Smart Printer: Print & Scan')).toBe(false);
    expect(looksLikePlaceholderJunk('Over 1,000,000 happy users since 2024')).toBe(false);
    expect(looksLikePlaceholderJunk('Escáner y impresora inteligente')).toBe(false);
  });
});
