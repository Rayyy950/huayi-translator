export type ProviderId = 'chrome-local' | 'tokenhub' | 'fake';

export type Language = 'auto' | 'en' | 'ja' | 'zh-Hans';
export type SourceLanguage = 'auto' | 'en' | 'ja';
export type TargetLanguage = 'zh-Hans';

export type EngineMode = 'local-first' | 'cloud-only' | 'local-only';

export type ErrorCode =
  | 'UNSUPPORTED'
  | 'MODEL_NOT_READY'
  | 'MODEL_DOWNLOAD_FAILED'
  | 'AUTH_FAILED'
  | 'QUOTA_EXCEEDED'
  | 'RATE_LIMITED'
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'TEXT_TOO_LONG'
  | 'LANGUAGE_UNCERTAIN'
  | 'PERMISSION_DENIED'
  | 'CANCELLED'
  | 'CONFIG_MISSING'
  | 'INTERNAL_ERROR';

export type ActionId =
  | 'open-options'
  | 'prepare-model'
  | 'configure-cloud'
  | 'grant-access'
  | 'reduce-selection'
  | 'retry';

export interface ErrorPayload {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  action?: ActionId;
  /** Sanitized diagnostic: error name/status only. Never contains keys or full text. */
  diagnostic?: string;
}

export interface TranslateInput {
  requestId: string;
  text: string;
  source: SourceLanguage;
  target: TargetLanguage;
  configVersion: number;
}

export interface TranslateOutput {
  requestId: string;
  translatedText: string;
  detectedSource?: string;
  actualProvider: ProviderId;
  cacheHit: boolean;
  elapsedMs: number;
  configVersion: number;
  /** True when the result came from the authorized local→cloud fallback. */
  fallback: boolean;
}

export type AvailabilityState = 'unavailable' | 'downloadable' | 'downloading' | 'available';

export interface ProviderCapabilities {
  id: ProviderId;
  available: boolean;
  reason?: string;
  languages: { source: string[]; target: string[] };
  autoSource: boolean;
  streaming: boolean;
  context: boolean;
  maxCharsPerRequest: number;
  lengthUnit: 'characters' | 'tokens';
  verifiedPairs: Array<{ source: string; target: string }>;
}

export type ModelPairStatus = {
  source: 'en' | 'ja';
  target: 'zh-Hans';
  state: AvailabilityState | 'unsupported';
};

export interface LocalStatus {
  supported: boolean;
  translator: boolean;
  detector: AvailabilityState | 'unsupported';
  pairs: ModelPairStatus[];
  checkedAt: number;
  note?: string;
}

export interface CloudMeta {
  region: 'guangzhou' | 'singapore';
  model: 'hy-mt2-plus';
  hasKey: boolean;
  persist: boolean;
  savedAt?: number;
  lastTest?: { ok: boolean; at: number; message?: string };
}
