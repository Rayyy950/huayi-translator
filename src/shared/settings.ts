import { z } from 'zod';
import type { CloudMeta, EngineMode, SourceLanguage, TargetLanguage } from './types';

export const SETTINGS_KEY = 'settings.v1';
export const API_KEY_LOCAL = 'tokenhub.apiKey.local';
export const API_KEY_SESSION = 'tokenhub.apiKey.session';
export const CLOUD_META_KEY = 'tokenhub.meta.v1';
export const USAGE_KEY = 'usage.v1';

export const SettingsSchema = z.object({
  schemaVersion: z.literal(1),
  configVersion: z.number().int().nonnegative(),
  enabled: z.boolean(),
  engineMode: z.enum(['local-first', 'cloud-only', 'local-only']),
  cloudFallback: z.boolean(),
  sourceLanguage: z.enum(['auto', 'en', 'ja']),
  targetLanguage: z.literal('zh-Hans'),
  debounceMs: z.number().int().min(120).max(800),
  maxChars: z.number().int().min(500).max(5000),
  dailySoftLimit: z.number().int().min(0).max(2_000_000).nullable(),
  disabledHosts: z.array(z.string().min(1).max(253)).max(500),
  tokenhub: z.object({
    region: z.enum(['guangzhou', 'singapore']),
    model: z.literal('hy-mt2-plus'),
  }),
  /** Test-build only. Ignored in production builds. */
  useFakeProvider: z.boolean().optional(),
});

export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  schemaVersion: 1,
  configVersion: 1,
  enabled: true,
  engineMode: 'local-first',
  cloudFallback: false,
  sourceLanguage: 'auto',
  targetLanguage: 'zh-Hans',
  debounceMs: 250,
  maxChars: 5000,
  dailySoftLimit: 20_000,
  disabledHosts: [],
  tokenhub: { region: 'guangzhou', model: 'hy-mt2-plus' },
};

export const CLOUD_DEFAULTS: CloudMeta = {
  region: 'guangzhou',
  model: 'hy-mt2-plus',
  hasKey: false,
  persist: false,
};

const CONFIG_KEYS = [
  'engineMode',
  'cloudFallback',
  'sourceLanguage',
  'targetLanguage',
  'tokenhub.region',
  'tokenhub.model',
] as const;

function readPath(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[key];
    return undefined;
  }, value);
}

export function affectsConfig(before: Settings, after: Settings): boolean {
  return CONFIG_KEYS.some((key) => readPath(before, key) !== readPath(after, key));
}

export function parseSettings(raw: unknown): Settings {
  const merged =
    raw && typeof raw === 'object' ? { ...DEFAULT_SETTINGS, ...raw } : DEFAULT_SETTINGS;
  const parsed = SettingsSchema.safeParse(merged);
  if (parsed.success) return parsed.data;
  return { ...DEFAULT_SETTINGS, configVersion: DEFAULT_SETTINGS.configVersion };
}

export interface PublicSettings {
  enabled: boolean;
  engineMode: EngineMode;
  sourceLanguage: SourceLanguage;
  targetLanguage: TargetLanguage;
  debounceMs: number;
  maxChars: number;
  disabledHosts: string[];
  cloudConfigured: boolean;
  configVersion: number;
  siteGranted?: boolean;
  localCapabilityNote?: string;
}

export interface SettingsPatch {
  enabled?: boolean;
  engineMode?: EngineMode;
  cloudFallback?: boolean;
  sourceLanguage?: SourceLanguage;
  targetLanguage?: TargetLanguage;
  debounceMs?: number;
  maxChars?: number;
  dailySoftLimit?: number | null;
  disabledHosts?: string[];
  tokenhub?: { region?: 'guangzhou' | 'singapore'; model?: 'hy-mt2-plus' };
  useFakeProvider?: boolean;
}

export function applyPatch(settings: Settings, patch: SettingsPatch): Settings {
  const next: Settings = {
    ...settings,
    ...patch,
    tokenhub: { ...settings.tokenhub, ...(patch.tokenhub ?? {}) },
  };
  if (affectsConfig(settings, next)) {
    next.configVersion = settings.configVersion + 1;
  }
  return next;
}
