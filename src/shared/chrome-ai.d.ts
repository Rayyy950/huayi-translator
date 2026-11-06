/**
 * Chrome built-in AI surface as observed in Chrome 156 (see docs/FEASIBILITY.md).
 * These types are intentionally minimal: only what this extension calls.
 */
type AvailabilityState = 'unavailable' | 'downloadable' | 'downloading' | 'available';

interface TranslatorInstance {
  translate(text: string): Promise<string>;
  destroy(): void;
}

interface LanguageDetectorInstance {
  detect(text: string): Promise<Array<{ detectedLanguage: string; confidence: number }>>;
  destroy(): void;
}

interface DownloadMonitor {
  addEventListener(
    type: 'downloadprogress',
    listener: (event: { loaded: number; total?: number }) => void,
  ): void;
}

declare class Translator {
  static availability(options: {
    sourceLanguage: string;
    targetLanguage: string;
  }): Promise<AvailabilityState>;
  static create(options: {
    sourceLanguage: string;
    targetLanguage: string;
    monitor?: (monitor: DownloadMonitor) => void;
  }): Promise<TranslatorInstance>;
}

declare class LanguageDetector {
  static availability(options?: { expectedInputLanguages?: string[] }): Promise<AvailabilityState>;
  static create(options?: {
    monitor?: (monitor: DownloadMonitor) => void;
  }): Promise<LanguageDetectorInstance>;
}
