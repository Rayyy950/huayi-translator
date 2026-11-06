import type { PermissionState } from '../shared/state';

const SCRIPT_ID = 'huayi-content';
const CONTENT_FILE = 'content.js';

export async function getPermissionState(): Promise<PermissionState> {
  const granted = await chrome.permissions.getAll();
  const origins = (granted.origins ?? []).filter(
    (origin) => origin.startsWith('http://') || origin.startsWith('https://'),
  );
  let allSites: boolean;
  try {
    allSites = await chrome.permissions.contains({
      origins: ['http://*/*', 'https://*/*'],
    });
  } catch {
    allSites = origins.includes('http://*/*') && origins.includes('https://*/*');
  }
  return { allSites, origins };
}

/** Registers one dynamic content script for every granted http/https origin. */
export async function syncContentScripts(): Promise<{ registered: boolean; matches: string[] }> {
  const { origins } = await getPermissionState();
  const matches = Array.from(new Set(origins)).filter(
    (origin) => origin.startsWith('http://') || origin.startsWith('https://'),
  );

  const existing = await chrome.scripting
    .getRegisteredContentScripts({ ids: [SCRIPT_ID] })
    .catch(() => [] as chrome.scripting.RegisteredContentScript[]);
  if (existing.length > 0) {
    await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] }).catch(() => {});
  }
  if (matches.length === 0) return { registered: false, matches };

  await chrome.scripting.registerContentScripts([
    {
      id: SCRIPT_ID,
      matches,
      js: [CONTENT_FILE],
      runAt: 'document_idle',
      allFrames: false,
      persistAcrossSessions: true,
      world: 'ISOLATED',
    },
  ]);
  return { registered: true, matches };
}

/**
 * Dynamic registration only affects pages loaded after the grant. Inject into
 * already-open matching tabs, relying on the content-script install guard to
 * avoid duplicate panels or listeners.
 */
export async function injectIntoOpenTabs(): Promise<number> {
  let injected = 0;
  let tabs: chrome.tabs.Tab[];
  try {
    tabs = await chrome.tabs.query({});
  } catch {
    return 0;
  }
  for (const tab of tabs) {
    if (typeof tab.id !== 'number' || !tab.url) continue;
    if (!/^https?:\/\//.test(tab.url)) continue;
    let granted: boolean;
    try {
      granted = await chrome.permissions.contains({
        origins: [`${new URL(tab.url).origin}/*`],
      });
    } catch {
      granted = false;
    }
    if (!granted) continue;
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: [CONTENT_FILE],
      });
      injected++;
    } catch {
      // Restricted pages and pages still loading can fail; ignore per tab.
    }
  }
  return injected;
}
