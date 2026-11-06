import type { SourceLanguage, TargetLanguage } from './types';

/**
 * Only newline normalization and outer whitespace trimming. Paragraph boundaries
 * and inner spacing are preserved because they carry meaning.
 */
export function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, '\n').trim();
}

export function countCodePoints(text: string): number {
  return Array.from(text).length;
}

export function localLanguageCode(language: SourceLanguage | TargetLanguage): string {
  switch (language) {
    case 'zh-Hans':
      return 'zh-Hans';
    case 'en':
      return 'en';
    case 'ja':
      return 'ja';
    default:
      return language;
  }
}

export function languageDisplayName(language: string | undefined): string {
  switch (language) {
    case 'en':
      return '英语';
    case 'ja':
      return '日语';
    case 'zh-Hans':
    case 'zh':
    case 'zh-CN':
      return '简体中文';
    case 'auto':
    case undefined:
      return '自动';
    default:
      return language;
  }
}

export function tokenHubLanguageName(language: TargetLanguage | 'en' | 'ja'): string {
  switch (language) {
    case 'zh-Hans':
      return 'Simplified Chinese (简体中文)';
    case 'en':
      return 'English';
    case 'ja':
      return 'Japanese';
  }
}

/** Maps a BCP-47 detection result to our internal language codes. */
export function mapDetectedLanguage(code: string): 'en' | 'ja' | 'zh-Hans' | 'other' {
  const lower = code.toLowerCase();
  if (lower === 'en' || lower.startsWith('en-')) return 'en';
  if (lower === 'ja' || lower.startsWith('ja-')) return 'ja';
  if (
    lower === 'zh' ||
    lower === 'zh-hans' ||
    lower === 'zh-cn' ||
    lower === 'zh-sg' ||
    lower.startsWith('zh-han')
  ) {
    return 'zh-Hans';
  }
  return 'other';
}

/** Very small guard used only to reject Japanese/English when detection says otherwise. */
export function looksLikeJapanese(text: string): boolean {
  return /[぀-ヿ]/.test(text);
}

export function looksLikeHan(text: string): boolean {
  return /[一-鿿]/.test(text);
}

export function hostnameMatchesRule(hostname: string, rule: string): boolean {
  const host = hostname.toLowerCase();
  const entry = rule.trim().toLowerCase();
  if (!entry) return false;
  if (entry.startsWith('*.')) {
    const suffix = entry.slice(1); // ".example.com"
    return host.endsWith(suffix) || host === entry.slice(2);
  }
  return host === entry;
}

export function isHostDisabled(hostname: string, rules: string[]): boolean {
  return rules.some((rule) => hostnameMatchesRule(hostname, rule));
}

export function normalizeHostRule(input: string): string | null {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;
  try {
    const withScheme = /^[a-z]+:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
    const url = new URL(withScheme);
    const host = url.hostname;
    if (!host || host.includes(' ')) return null;
    // Preserve an explicit wildcard if the user typed "*.example.com".
    if (trimmed.startsWith('*.')) {
      const base = trimmed.slice(2).split('/')[0] ?? '';
      return base ? `*.${base}` : null;
    }
    return host;
  } catch {
    return null;
  }
}
