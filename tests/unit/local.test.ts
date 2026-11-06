import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalEngine } from '../../src/providers/local';

function makeTranslator(translate: (text: string) => Promise<string>) {
  return { translate, destroy: vi.fn() };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('LocalEngine', () => {
  it('reports unsupported when the APIs are absent', async () => {
    vi.stubGlobal('Translator', undefined);
    vi.stubGlobal('LanguageDetector', undefined);
    const engine = new LocalEngine();
    const status = await engine.status(true);
    expect(status.supported).toBe(false);
    expect(status.translator).toBe(false);
    expect(status.detector).toBe('unsupported');
    expect(status.pairs.every((pair) => pair.state === 'unsupported')).toBe(true);
  });

  it('reports availability for pairs and detector', async () => {
    vi.stubGlobal('Translator', {
      availability: vi.fn(async ({ sourceLanguage }: { sourceLanguage: string }) =>
        sourceLanguage === 'en' ? 'available' : 'downloadable',
      ),
      create: vi.fn(),
    });
    vi.stubGlobal('LanguageDetector', {
      availability: vi.fn(async () => 'downloadable'),
      create: vi.fn(),
    });
    const engine = new LocalEngine();
    const status = await engine.status(true);
    expect(status.supported).toBe(true);
    expect(status.detector).toBe('downloadable');
    expect(status.pairs.find((pair) => pair.source === 'en')?.state).toBe('available');
    expect(status.pairs.find((pair) => pair.source === 'ja')?.state).toBe('downloadable');
  });

  it('refuses to translate when the model is not ready', async () => {
    vi.stubGlobal('Translator', {
      availability: vi.fn(async () => 'downloadable'),
      create: vi.fn(),
    });
    const engine = new LocalEngine();
    await expect(
      engine.translate('en', 'zh-Hans', 'Hello', new AbortController().signal),
    ).rejects.toMatchObject({ code: 'MODEL_NOT_READY' });
  });

  it('creates one instance per pair and serializes translations', async () => {
    const order: string[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    const translate = vi.fn(async (text: string) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push(text);
      concurrent--;
      return `译:${text}`;
    });
    const create = vi.fn(async () => makeTranslator(translate));
    vi.stubGlobal('Translator', {
      availability: vi.fn(async () => 'available'),
      create,
    });
    const engine = new LocalEngine();
    const signal = new AbortController().signal;
    const [a, b] = await Promise.all([
      engine.translate('en', 'zh-Hans', 'one', signal),
      engine.translate('en', 'zh-Hans', 'two', signal),
    ]);
    expect(a).toBe('译:one');
    expect(b).toBe('译:two');
    expect(order).toEqual(['one', 'two']);
    expect(maxConcurrent).toBe(1);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('maps NotAllowedError on create to MODEL_NOT_READY', async () => {
    vi.stubGlobal('Translator', {
      availability: vi.fn(async () => 'available'),
      create: vi.fn(async () => {
        const error = new Error('gesture required');
        error.name = 'NotAllowedError';
        throw error;
      }),
    });
    const engine = new LocalEngine();
    await expect(
      engine.translate('en', 'zh-Hans', 'Hello', new AbortController().signal),
    ).rejects.toMatchObject({ code: 'MODEL_NOT_READY' });
  });

  it('rejects when the request is already aborted', async () => {
    vi.stubGlobal('Translator', {
      availability: vi.fn(async () => 'available'),
      create: vi.fn(async () =>
        makeTranslator(async () => {
          await new Promise((resolve) => setTimeout(resolve, 30));
          return 'late';
        }),
      ),
    });
    const controller = new AbortController();
    controller.abort();
    const engine = new LocalEngine();
    await expect(
      engine.translate('en', 'zh-Hans', 'Hello', controller.signal),
    ).rejects.toMatchObject({
      code: 'CANCELLED',
    });
  });

  it('detects language with the detector instance', async () => {
    const detect = vi.fn(async () => [
      { detectedLanguage: 'ja', confidence: 0.99 },
      { detectedLanguage: 'und', confidence: 0.001 },
    ]);
    vi.stubGlobal('LanguageDetector', {
      availability: vi.fn(async () => 'available'),
      create: vi.fn(async () => ({ detect, destroy: vi.fn() })),
    });
    const engine = new LocalEngine();
    const result = await engine.detect('これは日本語です', new AbortController().signal);
    expect(result).toEqual({ language: 'ja', confidence: 0.99 });
    expect(detect).toHaveBeenCalledTimes(1);
  });

  it('caches status until forced', async () => {
    const availability = vi.fn(async () => 'available');
    vi.stubGlobal('Translator', { availability, create: vi.fn() });
    vi.stubGlobal('LanguageDetector', {
      availability: vi.fn(async () => 'available'),
      create: vi.fn(),
    });
    const engine = new LocalEngine(60_000);
    await engine.status();
    await engine.status();
    expect(availability).toHaveBeenCalledTimes(2);
    await engine.status(true);
    expect(availability).toHaveBeenCalledTimes(4);
  });
});
