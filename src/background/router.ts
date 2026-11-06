import { z } from 'zod';
import { AppError, toErrorPayload } from '../shared/errors';
import { isHostDisabled, normalizeHostRule } from '../shared/lang';
import { IncomingMessageSchema } from '../shared/messages';
import {
  clearApiKey,
  getApiKey,
  getCloudMeta,
  getSettings,
  saveCloudMeta,
  setApiKey,
  updateSettings,
} from '../shared/storage';
import type { TranslateOutput } from '../shared/types';
import type { RuntimeState } from '../shared/state';
import { getUsage } from '../shared/usage';
import { localEngine } from '../providers/local';
import { translationCache } from './cache-service';
import { getPermissionState, injectIntoOpenTabs, syncContentScripts } from './content-registry';
import { fakeProviderEnabled, isFakeBuild, translateService } from './translate-service';

export function isTrustedSender(sender: chrome.runtime.MessageSender): boolean {
  return (
    sender.id === chrome.runtime.id &&
    typeof sender.url === 'string' &&
    sender.url.startsWith(`chrome-extension://${chrome.runtime.id}/`)
  );
}

export function isContentSender(sender: chrome.runtime.MessageSender): boolean {
  return (
    sender.id === chrome.runtime.id &&
    typeof sender.tab?.id === 'number' &&
    typeof sender.url === 'string' &&
    /^https?:\/\//.test(sender.url)
  );
}

export async function broadcastSettingsChanged(): Promise<void> {
  let tabs: chrome.tabs.Tab[];
  try {
    tabs = await chrome.tabs.query({});
  } catch {
    return;
  }
  await Promise.allSettled(
    tabs
      .filter((tab): tab is chrome.tabs.Tab & { id: number } => typeof tab.id === 'number')
      .map((tab) => chrome.tabs.sendMessage(tab.id, { type: 'SETTINGS_CHANGED' })),
  );
}

async function buildRuntimeState(): Promise<RuntimeState> {
  const [settings, permission, local, cloud, usage] = await Promise.all([
    getSettings(),
    getPermissionState(),
    localEngine.status(),
    getCloudMeta(),
    getUsage(),
  ]);
  return {
    settings,
    permission,
    local,
    cloud,
    usage,
    fakeAvailable: await fakeProviderEnabled(settings),
  };
}

function hostFromSender(sender: chrome.runtime.MessageSender): string | undefined {
  if (!sender.url) return undefined;
  try {
    return new URL(sender.url).hostname;
  } catch {
    return undefined;
  }
}

async function dispatchTrusted(
  message: z.infer<typeof IncomingMessageSchema> & { type: string },
): Promise<unknown> {
  switch (message.type) {
    case 'GET_SETTINGS':
      return getSettings();
    case 'GET_STATE':
      return buildRuntimeState();
    case 'UPDATE_SETTINGS': {
      const patch = (message as { patch: Record<string, unknown> }).patch;
      const safePatch = { ...patch };
      if (safePatch.useFakeProvider !== undefined && !isFakeBuild()) {
        delete safePatch.useFakeProvider;
      }
      const next = await updateSettings(safePatch);
      await broadcastSettingsChanged();
      return next;
    }
    case 'SET_API_KEY': {
      const { apiKey, persist } = message as { apiKey: string; persist: boolean };
      const meta = await setApiKey(apiKey, persist);
      await broadcastSettingsChanged();
      return meta;
    }
    case 'CLEAR_API_KEY': {
      await clearApiKey();
      await broadcastSettingsChanged();
      return getCloudMeta();
    }
    case 'TEST_PROVIDER': {
      try {
        const result = await translateService.testCloud();
        const meta = await getCloudMeta();
        await saveCloudMeta({
          ...meta,
          lastTest: { ok: true, at: Date.now(), message: result.text.slice(0, 80) },
        });
        return result;
      } catch (error) {
        const meta = await getCloudMeta();
        const payload = toErrorPayload(error);
        await saveCloudMeta({
          ...meta,
          lastTest: { ok: false, at: Date.now(), message: payload.message },
        });
        throw error;
      }
    }
    case 'GET_MODEL_STATUS':
      return localEngine.status(true);
    case 'MODEL_PREPARED':
      localEngine.clearStatusCache();
      return localEngine.status(true);
    case 'CLEAR_CACHE':
      await translationCache.clear();
      return translationCache.stats();
    case 'GET_CACHE_STATS':
      return translationCache.stats();
    case 'GET_USAGE': {
      const [usage, settings] = await Promise.all([getUsage(), getSettings()]);
      return { usage, dailySoftLimit: settings.dailySoftLimit };
    }
    case 'GET_PERMISSION_STATE':
      return getPermissionState();
    case 'SYNC_CONTENT_SCRIPTS': {
      const sync = await syncContentScripts();
      const injected = await injectIntoOpenTabs();
      return { ...sync, injected };
    }
    case 'SET_SITE_ENABLED': {
      const { host, enabled } = message as { host: string; enabled: boolean };
      const normalized = normalizeHostRule(host) ?? host.toLowerCase();
      const settings = await getSettings();
      const disabled = new Set(settings.disabledHosts);
      if (enabled) disabled.delete(normalized);
      else disabled.add(normalized);
      const next = await updateSettings({ disabledHosts: Array.from(disabled) });
      await broadcastSettingsChanged();
      return next;
    }
    case 'ADD_DISABLED_HOST': {
      const { host } = message as { host: string };
      const normalized = normalizeHostRule(host);
      if (!normalized) throw new AppError('INTERNAL_ERROR', { message: '网站格式无效。' });
      const settings = await getSettings();
      const disabled = new Set(settings.disabledHosts);
      disabled.add(normalized);
      return updateSettings({ disabledHosts: Array.from(disabled) });
    }
    case 'REMOVE_DISABLED_HOST': {
      const { host } = message as { host: string };
      const normalized = normalizeHostRule(host) ?? host.toLowerCase();
      const settings = await getSettings();
      return updateSettings({
        disabledHosts: settings.disabledHosts.filter((entry) => entry !== normalized),
      });
    }
    default:
      throw new AppError('INTERNAL_ERROR', { diagnostic: 'unknown trusted message' });
  }
}

async function dispatchContent(
  message: z.infer<typeof IncomingMessageSchema> & { type: string },
  sender: chrome.runtime.MessageSender,
): Promise<unknown> {
  switch (message.type) {
    case 'TRANSLATE': {
      const msg = message as {
        type: 'TRANSLATE';
        requestId: string;
        text: string;
        source: 'auto' | 'en' | 'ja';
        target: 'zh-Hans';
      };
      const settings = await getSettings();
      const host = hostFromSender(sender);
      if (host && isHostDisabled(host, settings.disabledHosts)) {
        throw new AppError('PERMISSION_DENIED', { message: '当前网站已在划译中禁用。' });
      }
      // A page can stay in the DOM after its host permission is revoked; never
      // translate for an origin that no longer holds access.
      if (sender.url) {
        let granted: boolean;
        try {
          granted = await chrome.permissions.contains({
            origins: [`${new URL(sender.url).origin}/*`],
          });
        } catch {
          granted = false;
        }
        if (!granted) {
          throw new AppError('PERMISSION_DENIED', {
            message: '当前网站未授予划译访问权限。',
            action: 'grant-access',
          });
        }
      }
      const output: TranslateOutput = await translateService.translate(
        {
          requestId: msg.requestId,
          text: msg.text,
          source: msg.source,
          target: msg.target,
          configVersion: settings.configVersion,
        },
        {
          ...(typeof sender.tab?.id === 'number' ? { tabId: sender.tab.id } : {}),
          frameId: sender.frameId ?? 0,
          ...(sender.documentId ? { documentId: sender.documentId } : {}),
          ...(host ? { host } : {}),
        },
      );
      return output;
    }
    case 'CANCEL': {
      const msg = message as { type: 'CANCEL'; requestId: string };
      translateService.cancel(
        {
          ...(typeof sender.tab?.id === 'number' ? { tabId: sender.tab.id } : {}),
          frameId: sender.frameId ?? 0,
          ...(sender.documentId ? { documentId: sender.documentId } : {}),
        },
        msg.requestId,
      );
      return { cancelled: true };
    }
    case 'OPEN_OPTIONS': {
      await chrome.runtime.openOptionsPage();
      return { opened: true };
    }
    case 'GET_PUBLIC_SETTINGS': {
      const [settings, local] = await Promise.all([getSettings(), localEngine.status()]);
      const cloudConfigured = (await fakeProviderEnabled(settings)) || (await getApiKey()) !== null;
      let siteGranted = true;
      if (sender.url) {
        try {
          siteGranted = await chrome.permissions.contains({
            origins: [`${new URL(sender.url).origin}/*`],
          });
        } catch {
          siteGranted = false;
        }
      }
      return {
        enabled: settings.enabled,
        engineMode: settings.engineMode,
        sourceLanguage: settings.sourceLanguage,
        targetLanguage: settings.targetLanguage,
        debounceMs: settings.debounceMs,
        maxChars: settings.maxChars,
        disabledHosts: settings.disabledHosts,
        configVersion: settings.configVersion,
        cloudConfigured,
        siteGranted,
        ...(local.supported ? {} : { localCapabilityNote: '此浏览器未提供 Chrome 内置翻译。' }),
      };
    }
    default:
      throw new AppError('INTERNAL_ERROR', { diagnostic: 'unknown content message' });
  }
}

export async function handleMessage(
  raw: unknown,
  sender: chrome.runtime.MessageSender,
): Promise<{ ok: true; data: unknown } | { ok: false; error: ReturnType<typeof toErrorPayload> }> {
  try {
    const parsed = IncomingMessageSchema.safeParse(raw);
    if (!parsed.success) {
      throw new AppError('INTERNAL_ERROR', { message: '消息格式无效。' });
    }
    const message = parsed.data;
    const contentTypes = new Set(['TRANSLATE', 'CANCEL', 'GET_PUBLIC_SETTINGS', 'OPEN_OPTIONS']);
    if (contentTypes.has(message.type)) {
      if (!isContentSender(sender)) {
        throw new AppError('PERMISSION_DENIED', { message: '此操作不允许来自该页面。' });
      }
      return { ok: true, data: await dispatchContent(message, sender) };
    }
    if (!isTrustedSender(sender)) {
      throw new AppError('PERMISSION_DENIED', { message: '此操作仅限于扩展设置页。' });
    }
    return { ok: true, data: await dispatchTrusted(message) };
  } catch (error) {
    return { ok: false, error: toErrorPayload(error) };
  }
}
