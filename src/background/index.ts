import { ensureDefaults, ensureTrustedStorage } from '../shared/storage';
import { injectIntoOpenTabs, syncContentScripts } from './content-registry';
import { broadcastSettingsChanged, handleMessage } from './router';

async function bootstrap(): Promise<void> {
  await ensureTrustedStorage().catch(() => {});
  await ensureDefaults().catch(() => {});
  await syncContentScripts().catch(() => {});
}

chrome.runtime.onInstalled.addListener((details) => {
  void (async () => {
    await bootstrap();
    if (details.reason === 'install') {
      await injectIntoOpenTabs().catch(() => {});
      chrome.runtime.openOptionsPage().catch(() => {});
    }
  })();
});

chrome.runtime.onStartup.addListener(() => {
  void bootstrap();
});

chrome.permissions.onAdded.addListener(() => {
  void (async () => {
    await syncContentScripts().catch(() => {});
    await injectIntoOpenTabs().catch(() => {});
    await broadcastSettingsChanged().catch(() => {});
  })();
});

chrome.permissions.onRemoved.addListener(() => {
  void (async () => {
    await syncContentScripts().catch(() => {});
    await broadcastSettingsChanged().catch(() => {});
  })();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void handleMessage(message, sender).then(sendResponse);
  return true;
});

// Also run when the worker is woken by a message after a restart.
void bootstrap();
