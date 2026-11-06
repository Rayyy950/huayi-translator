import { AppError } from '../shared/errors';
import { mapDetectedLanguage } from '../shared/lang';
import type { LocalStatus, ModelPairStatus, TargetLanguage } from '../shared/types';
import {
  getDetectorApi,
  getTranslatorApi,
  type AiAvailability,
  type LanguageDetectorInstance,
  type TranslatorInstance,
} from './chrome-ai';

const LOCAL_MAX_CHARS = 2000;

export type DetectedLanguage = { language: string; confidence: number };

function toAvailability(value: string): AiAvailability {
  if (value === 'available' || value === 'downloadable' || value === 'downloading') return value;
  return 'unavailable';
}

function abortError(): Error {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Runs Chrome's built-in Translator in the service worker. Verified on Chrome
 * 156; the API is not documented for workers, so every call is capability-checked.
 */
export class LocalEngine {
  private translatorPromises = new Map<string, Promise<TranslatorInstance>>();
  private detectorPromise: Promise<LanguageDetectorInstance> | null = null;
  private lock: Promise<void> = Promise.resolve();
  private lastStatus: LocalStatus | null = null;

  constructor(private readonly statusTtlMs = 30_000) {}

  get maxCharsPerRequest(): number {
    return LOCAL_MAX_CHARS;
  }

  isSupported(): boolean {
    return getTranslatorApi() !== null;
  }

  private async withLock<T>(run: () => Promise<T>): Promise<T> {
    const previous = this.lock;
    let release!: () => void;
    this.lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await run();
    } finally {
      release();
    }
  }

  private translatorKey(source: string, target: string): string {
    return `${source}:${target}`;
  }

  private async getTranslator(source: string, target: string): Promise<TranslatorInstance> {
    const api = getTranslatorApi();
    if (!api) {
      throw new AppError('UNSUPPORTED', {
        message: '当前浏览器不支持 Chrome 内置翻译。',
        diagnostic: 'Translator missing',
      });
    }
    const key = this.translatorKey(source, target);
    const existing = this.translatorPromises.get(key);
    if (existing) return existing;
    const promise = (async () => {
      const availability = toAvailability(
        await api
          .availability({ sourceLanguage: source, targetLanguage: target })
          .catch(() => 'unavailable'),
      );
      if (availability !== 'available') {
        throw new AppError('MODEL_NOT_READY', {
          message:
            availability === 'downloadable' || availability === 'downloading'
              ? '本地翻译模型尚未准备，请在设置页点击“准备本地翻译”。'
              : '本地翻译模型不可用。',
          diagnostic: `availability=${availability}`,
        });
      }
      try {
        return await api.create({ sourceLanguage: source, targetLanguage: target });
      } catch (error) {
        const name = error instanceof Error ? error.name : 'unknown';
        if (name === 'NotAllowedError') {
          throw new AppError('MODEL_NOT_READY', {
            message: '本地模型需要一次用户点击才能准备，请在设置页操作。',
            diagnostic: name,
          });
        }
        throw new AppError('UNSUPPORTED', {
          message: '无法创建本地翻译实例。',
          diagnostic: name,
        });
      }
    })().catch((error) => {
      this.translatorPromises.delete(key);
      throw error;
    });
    this.translatorPromises.set(key, promise);
    return promise;
  }

  async translate(
    source: string,
    target: TargetLanguage,
    text: string,
    signal: AbortSignal,
  ): Promise<string> {
    const translator = await this.getTranslator(source, target);
    return this.withLock(async () => {
      try {
        const value = await withAbort(translator.translate(text), signal);
        if (signal.aborted) throw abortError();
        return value;
      } catch (error) {
        if (error instanceof AppError) throw error;
        if (error instanceof Error && (error.name === 'AbortError' || signal.aborted)) {
          throw new AppError('CANCELLED');
        }
        throw new AppError('INTERNAL_ERROR', {
          diagnostic: error instanceof Error ? error.name : 'local translate',
        });
      }
    });
  }

  private async getDetector(): Promise<LanguageDetectorInstance> {
    const api = getDetectorApi();
    if (!api) {
      throw new AppError('UNSUPPORTED', {
        message: '当前浏览器不支持语言检测。',
        diagnostic: 'LanguageDetector missing',
      });
    }
    if (this.detectorPromise) return this.detectorPromise;
    const promise = (async () => {
      const availability = toAvailability(await api.availability().catch(() => 'unavailable'));
      if (availability !== 'available') {
        throw new AppError('MODEL_NOT_READY', {
          message: '语言检测模型尚未准备，请在设置页点击“准备语言检测”。',
          diagnostic: `detector=${availability}`,
        });
      }
      try {
        return await api.create();
      } catch (error) {
        throw new AppError('MODEL_NOT_READY', {
          message: '语言检测模型尚未准备。',
          diagnostic: error instanceof Error ? error.name : 'detector',
        });
      }
    })().catch((error) => {
      this.detectorPromise = null;
      throw error;
    });
    this.detectorPromise = promise;
    return promise;
  }

  async detect(text: string, signal: AbortSignal): Promise<DetectedLanguage | null> {
    const detector = await this.getDetector();
    const results = await withAbort(detector.detect(text), signal);
    const top = results?.[0];
    if (!top) return null;
    return { language: top.detectedLanguage, confidence: top.confidence };
  }

  /** Map a detected BCP-47 tag to en/ja. */
  static mapLanguage(code: string): 'en' | 'ja' | 'zh-Hans' | 'other' {
    return mapDetectedLanguage(code);
  }

  async status(force = false): Promise<LocalStatus> {
    if (!force && this.lastStatus && Date.now() - this.lastStatus.checkedAt < this.statusTtlMs) {
      return this.lastStatus;
    }
    const api = getTranslatorApi();
    const detectorApi = getDetectorApi();
    const pairs: ModelPairStatus[] = [
      { source: 'en', target: 'zh-Hans', state: 'unsupported' },
      { source: 'ja', target: 'zh-Hans', state: 'unsupported' },
    ];
    let detector: LocalStatus['detector'] = detectorApi ? 'unavailable' : 'unsupported';
    if (api) {
      for (const pair of pairs) {
        try {
          pair.state = toAvailability(
            await api.availability({ sourceLanguage: pair.source, targetLanguage: pair.target }),
          );
        } catch {
          pair.state = 'unsupported';
        }
      }
    }
    if (detectorApi) {
      try {
        detector = toAvailability(await detectorApi.availability());
      } catch {
        detector = 'unavailable';
      }
    }
    const status: LocalStatus = {
      supported: api !== null,
      translator: api !== null,
      detector,
      pairs,
      checkedAt: Date.now(),
      ...(api || detectorApi
        ? {}
        : { note: '此 Chrome 未暴露内置翻译 API（需要桌面版 Chrome 138+）。' }),
    };
    this.lastStatus = status;
    return status;
  }

  clearStatusCache(): void {
    this.lastStatus = null;
  }
}

export const localEngine = new LocalEngine();
