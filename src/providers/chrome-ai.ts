export type AiAvailability = 'unavailable' | 'downloadable' | 'downloading' | 'available';

export interface AiMonitor {
  addEventListener(
    type: 'downloadprogress',
    listener: (event: { loaded: number; total?: number }) => void,
  ): void;
}

type TranslatorStatic = {
  availability(options: {
    sourceLanguage: string;
    targetLanguage: string;
  }): Promise<AiAvailability>;
  create(options: {
    sourceLanguage: string;
    targetLanguage: string;
    monitor?: (monitor: AiMonitor) => void;
  }): Promise<TranslatorInstance>;
};

type DetectorStatic = {
  availability(options?: { expectedInputLanguages?: string[] }): Promise<AiAvailability>;
  create(options?: { monitor?: (monitor: AiMonitor) => void }): Promise<LanguageDetectorInstance>;
};

export interface TranslatorInstance {
  translate(text: string): Promise<string>;
  destroy(): void;
}

export interface LanguageDetectorInstance {
  detect(text: string): Promise<Array<{ detectedLanguage: string; confidence: number }>>;
  destroy(): void;
}

export function getTranslatorApi(): TranslatorStatic | null {
  const api = (globalThis as unknown as { Translator?: TranslatorStatic }).Translator;
  return typeof api === 'object' || typeof api === 'function' ? (api ?? null) : null;
}

export function getDetectorApi(): DetectorStatic | null {
  const api = (globalThis as unknown as { LanguageDetector?: DetectorStatic }).LanguageDetector;
  return typeof api === 'object' || typeof api === 'function' ? (api ?? null) : null;
}

export function hasTranslator(): boolean {
  return getTranslatorApi() !== null;
}

export function hasDetector(): boolean {
  return getDetectorApi() !== null;
}
