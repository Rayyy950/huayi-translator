import { z } from 'zod';

export const ErrorPayloadSchema = z.object({
  code: z.enum([
    'UNSUPPORTED',
    'MODEL_NOT_READY',
    'MODEL_DOWNLOAD_FAILED',
    'AUTH_FAILED',
    'QUOTA_EXCEEDED',
    'RATE_LIMITED',
    'NETWORK_ERROR',
    'TIMEOUT',
    'TEXT_TOO_LONG',
    'LANGUAGE_UNCERTAIN',
    'PERMISSION_DENIED',
    'CANCELLED',
    'CONFIG_MISSING',
    'INTERNAL_ERROR',
  ]),
  message: z.string(),
  retryable: z.boolean(),
  action: z
    .enum([
      'open-options',
      'prepare-model',
      'configure-cloud',
      'grant-access',
      'reduce-selection',
      'retry',
    ])
    .optional(),
  diagnostic: z.string().optional(),
});

const requestId = z.string().min(1).max(120);

export const TranslateMessageSchema = z.object({
  type: z.literal('TRANSLATE'),
  requestId,
  text: z.string().min(1).max(20_000),
  source: z.enum(['auto', 'en', 'ja']),
  target: z.literal('zh-Hans'),
});

export const CancelMessageSchema = z.object({
  type: z.literal('CANCEL'),
  requestId,
});

export const GetPublicSettingsSchema = z.object({ type: z.literal('GET_PUBLIC_SETTINGS') });
export const GetPageStateSchema = z.object({ type: z.literal('GET_PAGE_STATE') });
export const SettingsChangedSchema = z.object({ type: z.literal('SETTINGS_CHANGED') });
export const OpenOptionsSchema = z.object({ type: z.literal('OPEN_OPTIONS') });

export const SettingsPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    engineMode: z.enum(['local-first', 'cloud-only', 'local-only']).optional(),
    cloudFallback: z.boolean().optional(),
    sourceLanguage: z.enum(['auto', 'en', 'ja']).optional(),
    targetLanguage: z.literal('zh-Hans').optional(),
    debounceMs: z.number().int().min(120).max(800).optional(),
    maxChars: z.number().int().min(500).max(5000).optional(),
    dailySoftLimit: z.number().int().min(0).max(2_000_000).nullable().optional(),
    disabledHosts: z.array(z.string().min(1).max(253)).max(500).optional(),
    tokenhub: z
      .object({
        region: z.enum(['guangzhou', 'singapore']).optional(),
        model: z.literal('hy-mt2-plus').optional(),
      })
      .optional(),
    useFakeProvider: z.boolean().optional(),
  })
  .strict();

export const UpdateSettingsSchema = z.object({
  type: z.literal('UPDATE_SETTINGS'),
  patch: SettingsPatchSchema,
});

export const GetSettingsSchema = z.object({ type: z.literal('GET_SETTINGS') });
export const GetStateSchema = z.object({ type: z.literal('GET_STATE') });

export const SetApiKeySchema = z.object({
  type: z.literal('SET_API_KEY'),
  apiKey: z.string().min(1).max(400),
  persist: z.boolean(),
});

export const ClearApiKeySchema = z.object({ type: z.literal('CLEAR_API_KEY') });
export const TestProviderSchema = z.object({ type: z.literal('TEST_PROVIDER') });
export const GetModelStatusSchema = z.object({ type: z.literal('GET_MODEL_STATUS') });
export const PrepareModelDoneSchema = z.object({ type: z.literal('MODEL_PREPARED') });
export const ClearCacheSchema = z.object({ type: z.literal('CLEAR_CACHE') });
export const GetCacheStatsSchema = z.object({ type: z.literal('GET_CACHE_STATS') });
export const GetUsageSchema = z.object({ type: z.literal('GET_USAGE') });
export const GetPermissionStateSchema = z.object({ type: z.literal('GET_PERMISSION_STATE') });
export const SyncContentScriptsSchema = z.object({ type: z.literal('SYNC_CONTENT_SCRIPTS') });

export const SetSiteEnabledSchema = z.object({
  type: z.literal('SET_SITE_ENABLED'),
  host: z.string().min(1).max(253),
  enabled: z.boolean(),
});

export const AddDisabledHostSchema = z.object({
  type: z.literal('ADD_DISABLED_HOST'),
  host: z.string().min(1).max(253),
});

export const RemoveDisabledHostSchema = z.object({
  type: z.literal('REMOVE_DISABLED_HOST'),
  host: z.string().min(1).max(253),
});

export const ContentMessageSchema = z.union([
  TranslateMessageSchema,
  CancelMessageSchema,
  GetPublicSettingsSchema,
  GetPageStateSchema,
  SettingsChangedSchema,
  OpenOptionsSchema,
]);

export const TrustedMessageSchema = z.union([
  GetSettingsSchema,
  GetStateSchema,
  UpdateSettingsSchema,
  SetApiKeySchema,
  ClearApiKeySchema,
  TestProviderSchema,
  GetModelStatusSchema,
  PrepareModelDoneSchema,
  ClearCacheSchema,
  GetCacheStatsSchema,
  GetUsageSchema,
  GetPermissionStateSchema,
  SyncContentScriptsSchema,
  SetSiteEnabledSchema,
  AddDisabledHostSchema,
  RemoveDisabledHostSchema,
]);

export const IncomingMessageSchema = z.union([ContentMessageSchema, TrustedMessageSchema]);

export type TranslateMessage = z.infer<typeof TranslateMessageSchema>;
export type CancelMessage = z.infer<typeof CancelMessageSchema>;
export type IncomingMessage = z.infer<typeof IncomingMessageSchema>;
export type TrustedMessage = z.infer<typeof TrustedMessageSchema>;
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

export interface OkResponse<T> {
  ok: true;
  data: T;
}
export interface ErrResponse {
  ok: false;
  error: z.infer<typeof ErrorPayloadSchema>;
}
export type Response<T> = OkResponse<T> | ErrResponse;
