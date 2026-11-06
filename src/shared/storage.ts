import {
  API_KEY_LOCAL,
  API_KEY_SESSION,
  CLOUD_META_KEY,
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  SettingsSchema,
  applyPatch,
  parseSettings,
  type Settings,
  type SettingsPatch,
} from './settings';
import type { CloudMeta } from './types';

export async function ensureTrustedStorage(): Promise<void> {
  try {
    await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  } catch {
    // Older Chrome builds may not support this call; session storage is trusted by default.
  }
  try {
    await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  } catch {
    // Best effort: content scripts still never receive keys through messages.
  }
}

export async function getSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return parseSettings(stored[SETTINGS_KEY]);
}

export async function saveSettings(settings: Settings): Promise<void> {
  const parsed = SettingsSchema.parse(settings);
  await chrome.storage.local.set({ [SETTINGS_KEY]: parsed });
}

export async function updateSettings(patch: SettingsPatch): Promise<Settings> {
  const current = await getSettings();
  const next = applyPatch(current, patch);
  await saveSettings(next);
  return next;
}

export async function ensureDefaults(): Promise<Settings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  if (!stored[SETTINGS_KEY]) {
    await saveSettings(DEFAULT_SETTINGS);
    return DEFAULT_SETTINGS;
  }
  return parseSettings(stored[SETTINGS_KEY]);
}

export async function getCloudMeta(): Promise<CloudMeta> {
  const stored = await chrome.storage.local.get(CLOUD_META_KEY);
  const raw = stored[CLOUD_META_KEY] as Partial<CloudMeta> | undefined;
  const settings = await getSettings();
  const key = await getApiKey();
  return {
    region: raw?.region ?? settings.tokenhub.region,
    model: 'hy-mt2-plus',
    hasKey: Boolean(key),
    persist: raw?.persist ?? false,
    ...(raw?.savedAt ? { savedAt: raw.savedAt } : {}),
    ...(raw?.lastTest ? { lastTest: raw.lastTest } : {}),
  };
}

export async function saveCloudMeta(meta: CloudMeta): Promise<void> {
  await chrome.storage.local.set({ [CLOUD_META_KEY]: meta });
}

export async function setApiKey(rawKey: string, persist: boolean): Promise<CloudMeta> {
  const key = rawKey.trim();
  if (!key) throw new Error('empty key');
  if (persist) {
    await chrome.storage.local.set({ [API_KEY_LOCAL]: key });
    await chrome.storage.session.remove(API_KEY_SESSION);
  } else {
    await chrome.storage.session.set({ [API_KEY_SESSION]: key });
    await chrome.storage.local.remove(API_KEY_LOCAL);
  }
  const settings = await getSettings();
  const meta: CloudMeta = {
    region: settings.tokenhub.region,
    model: 'hy-mt2-plus',
    hasKey: true,
    persist,
    savedAt: Date.now(),
  };
  await saveCloudMeta(meta);
  await updateSettings({
    tokenhub: { region: settings.tokenhub.region, model: 'hy-mt2-plus' },
  });
  await bumpConfigVersion();
  return meta;
}

export async function getApiKey(): Promise<string | null> {
  const session = await chrome.storage.session.get(API_KEY_SESSION);
  const sessionKey = session[API_KEY_SESSION];
  if (typeof sessionKey === 'string' && sessionKey) return sessionKey;
  const local = await chrome.storage.local.get(API_KEY_LOCAL);
  const localKey = local[API_KEY_LOCAL];
  return typeof localKey === 'string' && localKey ? localKey : null;
}

/** Credential changes affect translation results and must invalidate in-flight requests. */
export async function bumpConfigVersion(): Promise<Settings> {
  const settings = await getSettings();
  const next = { ...settings, configVersion: settings.configVersion + 1 };
  await saveSettings(next);
  return next;
}

export async function clearApiKey(): Promise<void> {
  await chrome.storage.session.remove(API_KEY_SESSION);
  await chrome.storage.local.remove(API_KEY_LOCAL);
  const settings = await getSettings();
  await saveCloudMeta({
    region: settings.tokenhub.region,
    model: 'hy-mt2-plus',
    hasKey: false,
    persist: false,
  });
  await updateSettings({ tokenhub: { region: settings.tokenhub.region } });
  await bumpConfigVersion();
}
