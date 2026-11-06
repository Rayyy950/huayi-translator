/* Phase A probe: does an offscreen document expose built-in AI? */

const report = (name, value) => {
  chrome.runtime.sendMessage({ type: 'OFFSCREEN_LOG', name, value }).catch(() => {});
};

report('hasTranslator', 'Translator' in self);
report('hasLanguageDetector', 'LanguageDetector' in self);
report('secureContext', self.isSecureContext);
report('userAgent', navigator.userAgent);
report('userActivation', navigator.userActivation?.isActive ?? null);

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'OFFSCREEN_RUN') return;
  (async () => {
    try {
      const availability = await Translator.availability({
        sourceLanguage: 'en',
        targetLanguage: 'zh',
      });
      report('availability_en_zh', availability);
    } catch (e) {
      report('availability_en_zh', `ERR ${e?.name}: ${e?.message}`);
    }
    try {
      const t0 = performance.now();
      const tr = await Translator.create({ sourceLanguage: 'en', targetLanguage: 'zh' });
      report('create_ms', Math.round(performance.now() - t0));
      const out = await tr.translate('Hello from the offscreen document.');
      report('translate_ok', out);
    } catch (e) {
      report('create_error', `${e?.name}: ${e?.message}`);
    }
    try {
      const det = await LanguageDetector.create();
      report('detect', await det.detect('This is an English sentence for detection.'));
    } catch (e) {
      report('detector_error', `${e?.name}: ${e?.message}`);
    }
    sendResponse({ ok: true });
  })();
  return true;
});
