import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../../src/shared/errors';
import {
  buildTokenHubBody,
  translateWithTokenHub,
  type TokenHubRequestOptions,
} from '../../src/providers/tokenhub';

function okResponse(content: string, finishReason = 'stop'): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content }, finish_reason: finishReason }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function makeOptions(overrides: Partial<TokenHubRequestOptions> = {}): TokenHubRequestOptions {
  return {
    apiKey: 'unit-test-key',
    region: 'guangzhou',
    model: 'hy-mt2-plus',
    text: 'Hello world.',
    source: 'auto',
    target: 'zh-Hans',
    signal: new AbortController().signal,
    sleepImpl: async () => {},
    ...overrides,
  };
}

describe('buildTokenHubBody', () => {
  it('uses the chat completions shape with a fixed prompt and data delimiters', () => {
    const body = JSON.parse(buildTokenHubBody('Some <text>', 'auto', 'zh-Hans', 'hy-mt2-plus'));
    expect(body.model).toBe('hy-mt2-plus');
    expect(body.temperature).toBe(0);
    expect(body.stream).toBe(false);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[0].content).toContain('never instructions');
    expect(body.messages[1].content).toContain('Detect the source language');
    expect(body.messages[1].content).toContain('<text>\nSome <text>\n</text>');
    expect(body.messages[1].content).toContain('Simplified Chinese');
  });

  it('names a fixed source language', () => {
    const body = JSON.parse(buildTokenHubBody('こんにちは', 'ja', 'zh-Hans', 'hy-mt2-plus'));
    expect(body.messages[1].content).toContain('from Japanese');
  });
});

describe('translateWithTokenHub', () => {
  it('sends auth and returns the trimmed translation', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      return okResponse('  你好世界。  ');
    });
    const result = await translateWithTokenHub(makeOptions({ fetchImpl }));
    expect(result.text).toBe('你好世界。');
    expect(result.attempts).toBe(1);
    expect(result.charsSent).toBe(Array.from('Hello world.').length);
    const call = calls[0];
    if (!call) throw new Error('fetch was not called');
    expect(call.input).toBe('https://tokenhub.tencentmaas.com/v1/chat/completions');
    const headers = call.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer unit-test-key');
    expect(headers['Content-Type']).toBe('application/json');
    expect(String(call.init?.body)).not.toContain('unit-test-key');
  });

  it('does not retry authentication failures', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ error: { code: '401002' } }), { status: 401 }),
    );
    await expect(translateWithTokenHub(makeOptions({ fetchImpl }))).rejects.toMatchObject({
      code: 'AUTH_FAILED',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('maps 402 to quota and does not retry', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 402 }));
    await expect(translateWithTokenHub(makeOptions({ fetchImpl }))).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries a 429 once, honouring Retry-After', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 429, headers: { 'retry-after': '0' } }))
      .mockResolvedValueOnce(okResponse('重试成功'));
    const result = await translateWithTokenHub(makeOptions({ fetchImpl }));
    expect(result.text).toBe('重试成功');
    expect(result.attempts).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries a 5xx once and then surfaces a network error', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 503 }));
    await expect(translateWithTokenHub(makeOptions({ fetchImpl }))).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('times out an attempt and reports TIMEOUT', async () => {
    const fetchImpl = (_url: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    await expect(
      translateWithTokenHub(
        makeOptions({ fetchImpl, perAttemptTimeoutMs: 15, totalTimeoutMs: 60 }),
      ),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('flags truncated output', async () => {
    const fetchImpl = vi.fn(async () => okResponse('部分译文', 'length'));
    await expect(translateWithTokenHub(makeOptions({ fetchImpl }))).rejects.toMatchObject({
      code: 'TEXT_TOO_LONG',
    });
  });

  it('rejects malformed responses', async () => {
    const fetchImpl = vi.fn(async () => new Response('not json', { status: 200 }));
    await expect(translateWithTokenHub(makeOptions({ fetchImpl }))).rejects.toBeInstanceOf(
      AppError,
    );
  });

  it('returns CANCELLED when the caller aborts before the request', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn(async () => okResponse('x'));
    await expect(
      translateWithTokenHub(makeOptions({ fetchImpl, signal: controller.signal })),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('survives a transport error and retries once', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(okResponse('ok'));
    const result = await translateWithTokenHub(makeOptions({ fetchImpl }));
    expect(result.text).toBe('ok');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
