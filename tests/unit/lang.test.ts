import { describe, expect, it } from 'vitest';
import {
  countCodePoints,
  hostnameMatchesRule,
  isHostDisabled,
  languageDisplayName,
  mapDetectedLanguage,
  normalizeHostRule,
  normalizeText,
  tokenHubLanguageName,
} from '../../src/shared/lang';

describe('normalizeText', () => {
  it('normalizes line endings and trims outer whitespace', () => {
    expect(normalizeText('  hello\r\nworld  \r\n\r\nnext  ')).toBe('hello\nworld  \n\nnext');
  });

  it('keeps inner spacing and blank lines', () => {
    expect(normalizeText('a  b\n\nc')).toBe('a  b\n\nc');
  });
});

describe('countCodePoints', () => {
  it('counts emoji as one code point', () => {
    expect(countCodePoints('a😀b')).toBe(3);
  });
});

describe('language mapping', () => {
  it('maps BCP-47 tags to internal codes', () => {
    expect(mapDetectedLanguage('en')).toBe('en');
    expect(mapDetectedLanguage('en-US')).toBe('en');
    expect(mapDetectedLanguage('ja')).toBe('ja');
    expect(mapDetectedLanguage('zh')).toBe('zh-Hans');
    expect(mapDetectedLanguage('zh-Hans')).toBe('zh-Hans');
    expect(mapDetectedLanguage('zh-TW')).toBe('other');
    expect(mapDetectedLanguage('fr')).toBe('other');
  });

  it('produces readable names', () => {
    expect(languageDisplayName('en')).toBe('英语');
    expect(languageDisplayName('ja')).toBe('日语');
    expect(languageDisplayName('zh-Hans')).toBe('简体中文');
    expect(languageDisplayName('auto')).toBe('自动');
    expect(languageDisplayName('fr')).toBe('fr');
  });

  it('maps target names for the cloud prompt', () => {
    expect(tokenHubLanguageName('zh-Hans')).toContain('Simplified Chinese');
    expect(tokenHubLanguageName('en')).toBe('English');
    expect(tokenHubLanguageName('ja')).toBe('Japanese');
  });
});

describe('host rules', () => {
  it('matches exact hosts and wildcard subdomains', () => {
    expect(hostnameMatchesRule('example.com', 'example.com')).toBe(true);
    expect(hostnameMatchesRule('sub.example.com', 'example.com')).toBe(false);
    expect(hostnameMatchesRule('sub.example.com', '*.example.com')).toBe(true);
    expect(hostnameMatchesRule('example.com', '*.example.com')).toBe(true);
    expect(hostnameMatchesRule('evil-example.com', '*.example.com')).toBe(false);
  });

  it('checks a list', () => {
    expect(isHostDisabled('a.example.com', ['*.example.com'])).toBe(true);
    expect(isHostDisabled('other.com', ['*.example.com'])).toBe(false);
  });

  it('normalizes user input', () => {
    expect(normalizeHostRule('example.com')).toBe('example.com');
    expect(normalizeHostRule('https://Example.com/path')).toBe('example.com');
    expect(normalizeHostRule('*.Example.com')).toBe('*.example.com');
    expect(normalizeHostRule('')).toBeNull();
    expect(normalizeHostRule('not a host')).toBeNull();
  });
});
