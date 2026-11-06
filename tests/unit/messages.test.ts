import { describe, expect, it } from 'vitest';
import {
  ContentMessageSchema,
  IncomingMessageSchema,
  SettingsPatchSchema,
  TranslateMessageSchema,
  TrustedMessageSchema,
} from '../../src/shared/messages';

describe('message schemas', () => {
  it('accepts a valid translate message', () => {
    const parsed = TranslateMessageSchema.safeParse({
      type: 'TRANSLATE',
      requestId: 'doc:1',
      text: 'hello',
      source: 'auto',
      target: 'zh-Hans',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects empty ids, empty text and unknown languages', () => {
    expect(
      TranslateMessageSchema.safeParse({
        type: 'TRANSLATE',
        requestId: '',
        text: 'hello',
        source: 'auto',
        target: 'zh-Hans',
      }).success,
    ).toBe(false);
    expect(
      TranslateMessageSchema.safeParse({
        type: 'TRANSLATE',
        requestId: 'x',
        text: '',
        source: 'auto',
        target: 'zh-Hans',
      }).success,
    ).toBe(false);
    expect(
      TranslateMessageSchema.safeParse({
        type: 'TRANSLATE',
        requestId: 'x',
        text: 'hello',
        source: 'fr',
        target: 'zh-Hans',
      }).success,
    ).toBe(false);
  });

  it('rejects text beyond the hard transport limit', () => {
    expect(
      TranslateMessageSchema.safeParse({
        type: 'TRANSLATE',
        requestId: 'x',
        text: 'a'.repeat(20_001),
        source: 'auto',
        target: 'zh-Hans',
      }).success,
    ).toBe(false);
  });

  it('rejects unknown fields in settings patches', () => {
    expect(SettingsPatchSchema.safeParse({ enabled: true }).success).toBe(true);
    expect(SettingsPatchSchema.safeParse({ enabled: true, evil: 1 }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ engineMode: 'nonsense' }).success).toBe(false);
  });

  it('does not accept trusted messages as content messages', () => {
    expect(ContentMessageSchema.safeParse({ type: 'UPDATE_SETTINGS', patch: {} }).success).toBe(
      false,
    );
    expect(TrustedMessageSchema.safeParse({ type: 'UPDATE_SETTINGS', patch: {} }).success).toBe(
      true,
    );
  });

  it('discriminates the full union', () => {
    expect(IncomingMessageSchema.safeParse({ type: 'OPEN_OPTIONS' }).success).toBe(true);
    expect(IncomingMessageSchema.safeParse({ type: 'GET_SETTINGS' }).success).toBe(true);
    expect(IncomingMessageSchema.safeParse({ type: 'NOPE' }).success).toBe(false);
  });

  it('validates API key messages', () => {
    expect(
      TrustedMessageSchema.safeParse({ type: 'SET_API_KEY', apiKey: 'sk-test', persist: false })
        .success,
    ).toBe(true);
    expect(
      TrustedMessageSchema.safeParse({ type: 'SET_API_KEY', apiKey: '', persist: false }).success,
    ).toBe(false);
  });
});
