import { buildCacheKey } from '../shared/cache';
import { joinChunks, splitIntoChunks } from '../shared/chunk';
import { AppError, isAbortError } from '../shared/errors';
import {
  countCodePoints,
  isHostDisabled,
  mapDetectedLanguage,
  normalizeText,
} from '../shared/lang';
import { RateLimiter } from '../shared/rate-limit';
import type { Settings } from '../shared/settings';
import { getApiKey, getSettings } from '../shared/storage';
import { getUsage, recordUsage, softLimitAllows } from '../shared/usage';
import type { ProviderId, TranslateInput, TranslateOutput, TargetLanguage } from '../shared/types';
import { localEngine } from '../providers/local';
import {
  TEST_SAMPLE,
  TOKENHUB_PROMPT_VERSION,
  translateWithTokenHub,
  type TokenHubResult,
} from '../providers/tokenhub';
import { translationCache, type StoredTranslation } from './cache-service';

const CLOUD_MAX_CHARS = 3000;
const LOCAL_MAX_CHARS = 2000;
const MAX_CHUNKS = 20;
const LOCAL_TIMEOUT_MS = 20_000;
const CLOUD_TIMEOUT_MS = 12_000;
const DETECT_TIMEOUT_MS = 2500;

type FakeTranslateFn = typeof import('../providers/fake').fakeTranslate;

const FAKE_BUILD = __FAKE_PROVIDER__;
let fakeLoader: Promise<FakeTranslateFn | null> | null = null;

export const TOKENHUB_HOSTS = {
  guangzhou: ['https://tokenhub.tencentmaas.com/*', 'https://tokenhub.tencentmaas.cn/*'],
  singapore: ['https://tokenhub-intl.tencentmaas.com/*', 'https://tokenhub-intl.tencentmaas.cn/*'],
} as const;

async function hasTokenHubPermission(region: 'guangzhou' | 'singapore'): Promise<boolean> {
  for (const origin of TOKENHUB_HOSTS[region]) {
    try {
      if (await chrome.permissions.contains({ origins: [origin] })) return true;
    } catch {
      // ignore and check the next origin
    }
  }
  return false;
}

export function isFakeBuild(): boolean {
  return FAKE_BUILD === true;
}

/**
 * Loads the test provider only in a test build. In production the constant
 * branch is eliminated and the module is never bundled.
 */
async function loadFakeTranslate(): Promise<FakeTranslateFn | null> {
  if (!FAKE_BUILD) return null;
  fakeLoader ??= import('../providers/fake')
    .then((module) => module.fakeTranslate)
    .catch(() => null);
  return fakeLoader;
}

export async function fakeProviderEnabled(settings: Settings): Promise<boolean> {
  if (!FAKE_BUILD || settings.useFakeProvider !== true) return false;
  return (await loadFakeTranslate()) !== null;
}

export interface RequestContext {
  tabId?: number;
  frameId?: number;
  documentId?: string;
  host?: string;
}

interface ActiveRequest {
  requestId: string;
  controller: AbortController;
  cacheKey?: string;
}

interface InFlight {
  controller: AbortController;
  consumers: Set<string>;
  promise: Promise<CloudRun>;
}

interface CloudRun {
  translatedText: string;
  detectedSource?: string;
  actualProvider: ProviderId;
  charsSent: number;
  attempts: number;
}

function combineSignals(signals: AbortSignal[]): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const listeners: Array<() => void> = [];
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    const onAbort = () => controller.abort(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    listeners.push(() => signal.removeEventListener('abort', onAbort));
  }
  return {
    signal: controller.signal,
    cleanup: () => listeners.forEach((remove) => remove()),
  };
}

function timeoutSignal(
  ms: number,
  outer: AbortSignal,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('Timeout', 'TimeoutError')), ms);
  const combined = combineSignals([outer, controller.signal]);
  return {
    signal: combined.signal,
    cleanup: () => {
      clearTimeout(timer);
      combined.cleanup();
    },
  };
}

function consumeWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  onRelease: () => void,
): Promise<T> {
  if (signal.aborted) {
    onRelease();
    return Promise.reject(new AppError('CANCELLED'));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      onRelease();
      reject(new AppError('CANCELLED'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function sameLanguageError(): AppError {
  return new AppError('UNSUPPORTED', {
    message: '所选文字已经是简体中文，无需翻译。',
    retryable: false,
    diagnostic: 'same-language',
  });
}

export class TranslateService {
  private readonly cloudLimiter = new RateLimiter(1000);
  private readonly activeByDocument = new Map<string, ActiveRequest>();
  private readonly inFlight = new Map<string, InFlight>();

  private documentKey(ctx: RequestContext): string {
    return `${ctx.tabId ?? 'tab'}:${ctx.frameId ?? 0}:${ctx.documentId ?? 'document'}`;
  }

  cancel(ctx: RequestContext, requestId?: string): void {
    const docKey = this.documentKey(ctx);
    const active = this.activeByDocument.get(docKey);
    if (!active) return;
    if (requestId && active.requestId !== requestId) return;
    this.release(active, docKey);
    this.activeByDocument.delete(docKey);
  }

  private release(active: ActiveRequest, docKey: string): void {
    active.controller.abort();
    if (active.cacheKey) {
      const entry = this.inFlight.get(active.cacheKey);
      if (entry) {
        entry.consumers.delete(docKey);
        if (entry.consumers.size === 0) {
          entry.controller.abort();
          this.inFlight.delete(active.cacheKey);
        }
      }
    }
  }

  async translate(input: TranslateInput, ctx: RequestContext): Promise<TranslateOutput> {
    const started = Date.now();
    const settings = await getSettings();
    if (!settings.enabled) {
      throw new AppError('PERMISSION_DENIED', {
        message: '划译已全局关闭，请在扩展弹窗中开启。',
        action: 'open-options',
      });
    }
    if (ctx.host && isHostDisabled(ctx.host, settings.disabledHosts)) {
      throw new AppError('PERMISSION_DENIED', {
        message: '当前网站已在划译中禁用。',
        action: 'open-options',
      });
    }

    const text = normalizeText(input.text);
    if (!text) throw new AppError('CANCELLED', { retryable: false });
    if (countCodePoints(text) > settings.maxChars) {
      throw new AppError('TEXT_TOO_LONG', {
        message: `选区超过 ${settings.maxChars} 个字符，请缩小选区后重试。`,
      });
    }

    const docKey = this.documentKey(ctx);
    const previous = this.activeByDocument.get(docKey);
    if (previous) this.release(previous, docKey);

    const controller = new AbortController();
    const active: ActiveRequest = { requestId: input.requestId, controller };
    this.activeByDocument.set(docKey, active);

    const startVersion = settings.configVersion;
    try {
      const target = settings.targetLanguage;
      const plan = await this.decidePlan(settings, text, controller.signal);

      let output: TranslateOutput;
      if (plan === 'local') {
        try {
          output = await this.runLocal(
            text,
            settings,
            target,
            input,
            startVersion,
            controller.signal,
            started,
          );
        } catch (error) {
          const fallbackOk =
            !(error instanceof AppError && error.code === 'CANCELLED') &&
            settings.cloudFallback &&
            settings.engineMode !== 'local-only' &&
            (await this.hasCloudConfigured(settings));
          if (!fallbackOk) throw error;
          output = await this.runCloud(
            text,
            settings,
            target,
            input,
            startVersion,
            controller.signal,
            started,
            true,
            docKey,
            active,
          );
        }
      } else {
        output = await this.runCloud(
          text,
          settings,
          target,
          input,
          startVersion,
          controller.signal,
          started,
          plan === 'cloud-fallback',
          docKey,
          active,
        );
      }

      const latest = await getSettings();
      if (latest.configVersion !== startVersion || !latest.enabled) {
        throw new AppError('CANCELLED', {
          message: '设置已更改，请重新划选。',
          retryable: true,
        });
      }
      return output;
    } catch (error) {
      if (isAbortError(error) || controller.signal.aborted) {
        throw new AppError('CANCELLED');
      }
      throw error;
    } finally {
      const current = this.activeByDocument.get(docKey);
      if (current?.requestId === input.requestId) {
        this.activeByDocument.delete(docKey);
      }
    }
  }

  private async hasCloudConfigured(settings: Settings): Promise<boolean> {
    if (await fakeProviderEnabled(settings)) return true;
    return (await getApiKey()) !== null;
  }

  private async decidePlan(
    settings: Settings,
    _text: string,
    _signal: AbortSignal,
  ): Promise<'local' | 'cloud' | 'cloud-fallback'> {
    const cloudConfigured = await this.hasCloudConfigured(settings);
    const fallbackAllowed =
      settings.cloudFallback && settings.engineMode !== 'local-only' && cloudConfigured;

    if (settings.engineMode === 'cloud-only') {
      if (!cloudConfigured) {
        throw new AppError('CONFIG_MISSING', {
          message: '尚未配置腾讯云 TokenHub API Key。',
        });
      }
      return 'cloud';
    }

    if (settings.engineMode === 'local-only') return 'local';

    const status = await localEngine.status();
    if (!status.supported) {
      if (fallbackAllowed) return 'cloud-fallback';
      throw new AppError('UNSUPPORTED', {
        message: '此浏览器未提供 Chrome 内置翻译。你可以在设置中配置云端翻译。',
        action: 'configure-cloud',
      });
    }
    if (settings.sourceLanguage === 'auto' && status.detector !== 'available') {
      if (fallbackAllowed) return 'cloud-fallback';
      if (status.detector === 'downloadable' || status.detector === 'downloading') {
        throw new AppError('MODEL_NOT_READY', {
          message: '语言检测模型尚未准备，请在设置页点击“准备语言检测”。',
        });
      }
    }
    return 'local';
  }

  private async resolveSourceForLocal(
    settings: Settings,
    text: string,
    signal: AbortSignal,
  ): Promise<{ source: 'en' | 'ja'; detected?: string }> {
    if (settings.sourceLanguage !== 'auto') {
      return { source: settings.sourceLanguage };
    }
    const detectorSignal = timeoutSignal(DETECT_TIMEOUT_MS + 8000, signal);
    try {
      const detected = await localEngine.detect(text, detectorSignal.signal);
      if (!detected) {
        throw new AppError('LANGUAGE_UNCERTAIN', {
          message: '无法判断文字语言。请在设置中将源语言指定为英语或日语。',
        });
      }
      const mapped = mapDetectedLanguage(detected.language);
      if (mapped === 'zh-Hans') throw sameLanguageError();
      if (mapped === 'en' || mapped === 'ja') {
        return { source: mapped, detected: detected.language };
      }
      throw new AppError('LANGUAGE_UNCERTAIN', {
        message: '无法可靠判断源语言。请在设置中将源语言指定为英语或日语。',
        diagnostic: `detected=${detected.language}`,
      });
    } finally {
      detectorSignal.cleanup();
    }
  }

  private async resolveSourceForCloud(
    settings: Settings,
    text: string,
    signal: AbortSignal,
  ): Promise<{ source: 'auto' | 'en' | 'ja'; detected?: string }> {
    if (settings.sourceLanguage !== 'auto') return { source: settings.sourceLanguage };
    const detectorSignal = timeoutSignal(DETECT_TIMEOUT_MS, signal);
    try {
      const detected = await localEngine.detect(text, detectorSignal.signal);
      if (!detected) return { source: 'auto' };
      const mapped = mapDetectedLanguage(detected.language);
      if (mapped === 'zh-Hans' && detected.confidence >= 0.5) throw sameLanguageError();
      return {
        source: mapped === 'en' || mapped === 'ja' ? mapped : 'auto',
        detected: detected.language,
      };
    } catch (error) {
      if (error instanceof AppError && error.diagnostic === 'same-language') throw error;
      if (error instanceof AppError && error.code === 'CANCELLED' && signal.aborted) throw error;
      // Detection is optional for cloud translation; let the model detect.
      return { source: 'auto' };
    } finally {
      detectorSignal.cleanup();
    }
  }

  private async runLocal(
    text: string,
    settings: Settings,
    target: TargetLanguage,
    input: TranslateInput,
    configVersion: number,
    signal: AbortSignal,
    started: number,
  ): Promise<TranslateOutput> {
    const { source, detected } = await this.resolveSourceForLocal(settings, text, signal);
    const cacheKey = buildCacheKey({
      text,
      // Requested source matters: auto-detection and a manual override are
      // distinct configurations, and the panel reports the detected language.
      source: `${settings.sourceLanguage}:${source}`,
      target,
      actualProvider: 'chrome-local',
      model: 'chrome-local-v1',
    });
    const cached = await translationCache.get(cacheKey);
    if (cached) {
      return this.outputFromCache(cached, input, configVersion, started);
    }

    const chunks = splitIntoChunks(text, LOCAL_MAX_CHARS);
    if (chunks.length > MAX_CHUNKS) {
      throw new AppError('TEXT_TOO_LONG', { message: '选区过长，请缩小后重试。' });
    }
    const localSignal = timeoutSignal(LOCAL_TIMEOUT_MS, signal);
    const translated: string[] = [];
    try {
      for (const chunk of chunks) {
        translated.push(
          await localEngine.translate(source, target, chunk.text, localSignal.signal),
        );
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (isAbortError(error) || localSignal.signal.aborted) {
        throw new AppError(signal.aborted ? 'CANCELLED' : 'TIMEOUT');
      }
      throw new AppError('INTERNAL_ERROR', {
        diagnostic: error instanceof Error ? error.name : 'local',
      });
    } finally {
      localSignal.cleanup();
    }

    const translatedText = joinChunks(translated, chunks);
    const stored: StoredTranslation = {
      translatedText,
      ...(detected ? { detectedSource: detected } : {}),
      actualProvider: 'chrome-local',
      fallback: false,
    };
    await translationCache.set(cacheKey, stored);
    return {
      requestId: input.requestId,
      translatedText,
      ...(detected ? { detectedSource: detected } : {}),
      actualProvider: 'chrome-local',
      cacheHit: false,
      elapsedMs: Date.now() - started,
      configVersion,
      fallback: false,
    };
  }

  private async runCloud(
    text: string,
    settings: Settings,
    target: TargetLanguage,
    input: TranslateInput,
    configVersion: number,
    signal: AbortSignal,
    started: number,
    fallback: boolean,
    docKey: string,
    active: ActiveRequest,
  ): Promise<TranslateOutput> {
    const { source, detected } = await this.resolveSourceForCloud(settings, text, signal);
    const fake = await fakeProviderEnabled(settings);
    const actualProvider: ProviderId = fake ? 'fake' : 'tokenhub';
    const model = fake ? 'fake-v1' : settings.tokenhub.model;
    const region = fake ? 'fake' : settings.tokenhub.region;
    const cacheKey = buildCacheKey({
      text,
      source: `${settings.sourceLanguage}:${source}`,
      target,
      actualProvider,
      model,
      region,
      promptVersion: TOKENHUB_PROMPT_VERSION,
    });
    active.cacheKey = cacheKey;

    const cached = await translationCache.get(cacheKey);
    if (cached) {
      return this.outputFromCache(cached, input, configVersion, started, fallback);
    }

    const chunks = splitIntoChunks(text, CLOUD_MAX_CHARS);
    if (chunks.length > MAX_CHUNKS) {
      throw new AppError('TEXT_TOO_LONG', { message: '选区过长，请缩小后重试。' });
    }

    const usage = await getUsage();
    const totalChars = countCodePoints(text);
    const limit = softLimitAllows(usage.chars, totalChars, settings.dailySoftLimit);
    if (!limit.allowed) {
      throw new AppError('QUOTA_EXCEEDED', {
        message: `已达本机每日软限额（${limit.limit} 字符）。可在设置中调整或关闭。`,
        action: 'open-options',
      });
    }

    let entry = this.inFlight.get(cacheKey);
    let shared = false;
    if (entry) {
      shared = true;
    } else {
      const controller = new AbortController();
      const promise = this.cloudChunks(text, chunks, source, target, settings, controller.signal)
        .then(async (run) => {
          await recordUsage(run.charsSent, 'request');
          const stored: StoredTranslation = {
            translatedText: run.translatedText,
            ...(detected ? { detectedSource: detected } : {}),
            actualProvider: run.actualProvider,
            // The fallback label belongs to the request, not to the cached text.
            fallback: false,
          };
          await translationCache.set(cacheKey, stored);
          return run;
        })
        .finally(() => {
          this.inFlight.delete(cacheKey);
        });
      entry = { controller, consumers: new Set([docKey]), promise };
      this.inFlight.set(cacheKey, entry);
    }

    if (shared) entry.consumers.add(docKey);

    const run = await consumeWithAbort(entry.promise, signal, () => {
      const current = this.inFlight.get(cacheKey);
      if (!current) return;
      current.consumers.delete(docKey);
      if (current.consumers.size === 0) {
        current.controller.abort();
        this.inFlight.delete(cacheKey);
      }
    });

    const detectedSource = detected ?? run.detectedSource;
    return {
      requestId: input.requestId,
      translatedText: run.translatedText,
      ...(detectedSource ? { detectedSource } : {}),
      actualProvider: run.actualProvider,
      cacheHit: false,
      elapsedMs: Date.now() - started,
      configVersion,
      fallback,
    };
  }

  private async cloudChunks(
    _fullText: string,
    chunks: ReturnType<typeof splitIntoChunks>,
    source: 'auto' | 'en' | 'ja',
    target: TargetLanguage,
    settings: Settings,
    signal: AbortSignal,
  ): Promise<CloudRun> {
    const fake = await fakeProviderEnabled(settings);
    const fakeFn = fake ? await loadFakeTranslate() : null;
    const results: string[] = [];
    let charsSent = 0;
    let attempts = 0;
    let actualProvider: ProviderId = fake ? 'fake' : 'tokenhub';
    const apiKey = fake ? 'test' : await getApiKey();
    if (!fake && !apiKey) {
      throw new AppError('CONFIG_MISSING', {
        message: '尚未配置腾讯云 TokenHub API Key。',
      });
    }
    if (!fake && !(await hasTokenHubPermission(settings.tokenhub.region))) {
      throw new AppError('PERMISSION_DENIED', {
        message: '未授予腾讯云 TokenHub 域名访问权限，请在设置页重新保存 Key 并允许域名访问。',
        action: 'configure-cloud',
      });
    }

    for (const chunk of chunks) {
      if (signal.aborted) throw new AppError('CANCELLED');
      let result: { text: string; attempts: number; charsSent: number };
      if (fakeFn) {
        result = await fakeFn(chunk.text, source, target, signal);
        actualProvider = 'fake';
      } else {
        const tokenHub: TokenHubResult = await translateWithTokenHub({
          apiKey: apiKey!,
          region: settings.tokenhub.region,
          model: settings.tokenhub.model,
          text: chunk.text,
          source,
          target,
          signal,
          rateLimiter: this.cloudLimiter,
          perAttemptTimeoutMs: 8000,
          totalTimeoutMs: CLOUD_TIMEOUT_MS,
        });
        result = {
          text: tokenHub.text,
          attempts: tokenHub.attempts,
          charsSent: tokenHub.charsSent,
        };
      }
      results.push(result.text);
      charsSent += result.charsSent;
      attempts += result.attempts;
    }

    return {
      translatedText: joinChunks(results, chunks),
      actualProvider,
      charsSent,
      attempts,
    };
  }

  private outputFromCache(
    cached: StoredTranslation,
    input: TranslateInput,
    configVersion: number,
    started: number,
    fallback = false,
  ): TranslateOutput {
    return {
      requestId: input.requestId,
      translatedText: cached.translatedText,
      ...(cached.detectedSource ? { detectedSource: cached.detectedSource } : {}),
      actualProvider: cached.actualProvider,
      cacheHit: true,
      elapsedMs: Date.now() - started,
      configVersion,
      fallback: cached.fallback || fallback,
    };
  }

  async testCloud(): Promise<{ ok: true; text: string; elapsedMs: number; provider: ProviderId }> {
    const settings = await getSettings();
    const fake = await fakeProviderEnabled(settings);
    const fakeFn = fake ? await loadFakeTranslate() : null;
    const apiKey = fake ? 'test' : await getApiKey();
    if (!fake && !apiKey) {
      throw new AppError('CONFIG_MISSING', {
        message: '请先保存腾讯云 TokenHub API Key。',
      });
    }
    if (!fake && !(await hasTokenHubPermission(settings.tokenhub.region))) {
      throw new AppError('PERMISSION_DENIED', {
        message: '未授予腾讯云 TokenHub 域名访问权限，请在保存 Key 时允许域名访问。',
        action: 'configure-cloud',
      });
    }
    const started = Date.now();
    const target: TargetLanguage = 'zh-Hans';
    try {
      const result = fakeFn
        ? await fakeFn(TEST_SAMPLE, 'en', target, new AbortController().signal)
        : await translateWithTokenHub({
            apiKey: apiKey!,
            region: settings.tokenhub.region,
            model: settings.tokenhub.model,
            text: TEST_SAMPLE,
            source: 'en',
            target,
            signal: new AbortController().signal,
            rateLimiter: this.cloudLimiter,
          });
      await recordUsage(result.charsSent, 'test');
      const elapsedMs = Date.now() - started;
      return { ok: true, text: result.text, elapsedMs, provider: fake ? 'fake' : 'tokenhub' };
    } catch (error) {
      throw error instanceof AppError
        ? error
        : new AppError('INTERNAL_ERROR', {
            diagnostic: error instanceof Error ? error.name : 'test',
          });
    }
  }
}

export const translateService = new TranslateService();
