/* Phase A probe: record what the service worker can see, and relay offscreen results. */

const log = [];
const push = (name, value) => {
  log.push({ at: new Date().toISOString(), context: 'sw', name, value });
  chrome.storage.local.set({ swLog: log }).catch(() => {});
};

(async () => {
  push('hasTranslator', 'Translator' in self);
  push('hasLanguageDetector', 'LanguageDetector' in self);
  push('hasDOM', typeof document !== 'undefined');
  push('userAgent', navigator.userAgent);
  if ('Translator' in self) {
    try {
      push(
        'availability_en_zh',
        await Translator.availability({ sourceLanguage: 'en', targetLanguage: 'zh' }),
      );
    } catch (e) {
      push('availability_en_zh', `ERR ${e?.name}: ${e?.message}`);
    }
  }
})();

const offscreenResults = [];
const pushOffscreen = (name, value) => {
  offscreenResults.push({ at: new Date().toISOString(), context: 'offscreen', name, value });
  chrome.storage.local.set({ offscreenLog: offscreenResults }).catch(() => {});
};

async function ensureOffscreen() {
  const existing = await chrome.offscreen.hasDocument().catch(() => false);
  if (existing) return 'already-open';
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['TESTING'],
    justification: 'Phase A feasibility probe of Chrome built-in AI in an offscreen document',
  });
  return 'created';
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'OFFSCREEN_LOG') {
    pushOffscreen(String(msg.name), msg.value);
    return;
  }

  if (msg.type === 'CONTENT_LOG') {
    const entry = {
      at: new Date().toISOString(),
      context: 'content',
      tabId: sender.tab?.id,
      frameId: sender.frameId,
      name: String(msg.name),
      value: msg.value,
    };
    chrome.storage.local
      .get('contentLog')
      .then(({ contentLog = [] }) => {
        contentLog.push(entry);
        return chrome.storage.local.set({ contentLog });
      })
      .catch(() => {});
    return;
  }

  if (msg.type === 'SW_LOG') {
    sendResponse({ ok: true, log });
    return;
  }

  if (msg.type === 'RUN_OFFSCREEN_PROBE') {
    (async () => {
      try {
        const status = await ensureOffscreen();
        pushOffscreen('document', status);
        await chrome.runtime.sendMessage({ type: 'OFFSCREEN_RUN' }).catch((e) => {
          pushOffscreen('sendMessageError', String(e));
        });
      } catch (e) {
        pushOffscreen('createError', `${e?.name}: ${e?.message}`);
      }
    })();
    return;
  }

  if (msg.type === 'OFFSCREEN_RESULT') {
    sendResponse({ ok: 'true' });
    return;
  }
});
