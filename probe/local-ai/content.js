/* Phase A probe: built-in AI from an isolated-world content script. */

(() => {
  const report = (name, value) => {
    chrome.runtime.sendMessage({ type: 'CONTENT_LOG', name, value }).catch(() => {});
  };

  report('url', location.href);
  report('protocol', location.protocol);
  window.__fanyiProbe = true;
  report('secureContext', self.isSecureContext);
  report('hasTranslator', 'Translator' in self);
  report('hasLanguageDetector', 'LanguageDetector' in self);
  report('translatorType', typeof self.Translator);
  report('userActivation_on_load', navigator.userActivation?.isActive ?? null);

  if ('Translator' in self) {
    for (const [s, t] of [
      ['en', 'zh'],
      ['ja', 'zh'],
    ]) {
      Translator.availability({ sourceLanguage: s, targetLanguage: t })
        .then((v) => report(`availability_${s}_${t}`, v))
        .catch((e) => report(`availability_${s}_${t}`, `ERR ${e?.name}: ${e?.message}`));
    }
  }

  // The page click gives the document transient activation; try create() in the isolated world.
  window.addEventListener(
    'click',
    async (event) => {
      report('click_userActivation', navigator.userActivation?.isActive ?? null);
      report('click_target', event.target?.tagName ?? null);
      try {
        const t0 = performance.now();
        const tr = await Translator.create({ sourceLanguage: 'en', targetLanguage: 'zh' });
        report('create_ok_ms', Math.round(performance.now() - t0));
        const translated = await tr.translate('Where is the nearest station?');
        report('translate_ok', translated);
        tr.destroy?.();
      } catch (e) {
        report('create_error', `${e?.name}: ${e?.message}`);
      }
    },
    { capture: true, once: true },
  );
})();
