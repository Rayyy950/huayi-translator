/* Phase A probe page. Records raw facts only; nothing here ships. */

const own = [];
const out = document.getElementById('out');

const snap = async () => {
  const {
    swLog = [],
    offscreenLog = [],
    contentLog = [],
  } = await chrome.storage.local.get(['swLog', 'offscreenLog', 'contentLog']);
  const payload = { own, sw: swLog, offscreen: offscreenLog, content: contentLog };
  out.textContent = JSON.stringify(payload, null, 2);
  document.title = `probe-${own.length}-${swLog.length}-${offscreenLog.length}-${contentLog.length}`;
};

const log = (name, value) => {
  own.push({ at: new Date().toISOString(), context: 'options', name, value });
  console.log('[probe]', name, typeof value === 'string' ? value : JSON.stringify(value));
  return snap();
};

async function translateWith(sourceLanguage, targetLanguage, samples) {
  const t0 = performance.now();
  let created = null;
  try {
    created = await Translator.create({
      sourceLanguage,
      targetLanguage,
      monitor(m) {
        m.addEventListener('downloadprogress', (e) => {
          log(`download_${sourceLanguage}_${targetLanguage}`, e.loaded);
        });
      },
    });
    log(`create_${sourceLanguage}_${targetLanguage}_ms`, Math.round(performance.now() - t0));
  } catch (e) {
    log(`create_${sourceLanguage}_${targetLanguage}_error`, `${e?.name}: ${e?.message}`);
    return;
  }
  for (const sample of samples) {
    const t1 = performance.now();
    try {
      const translated = await created.translate(sample);
      log(`translate_${sourceLanguage}_${targetLanguage}`, {
        input: sample,
        output: translated,
        ms: Math.round(performance.now() - t1),
      });
    } catch (e) {
      log(`translate_${sourceLanguage}_${targetLanguage}_error`, `${e?.name}: ${e?.message}`);
    }
  }
  try {
    created.destroy?.();
  } catch {}
}

(async () => {
  log('userAgent', navigator.userAgent);
  log('secureContext', self.isSecureContext);
  log('hasTranslator', 'Translator' in self);
  log('hasLanguageDetector', 'LanguageDetector' in self);
  log('translatorType', typeof self.Translator);
  log('userActivation_active_on_load', navigator.userActivation?.isActive ?? null);

  if ('Translator' in self) {
    for (const [s, t] of [
      ['en', 'zh'],
      ['ja', 'zh'],
      ['en', 'zh-Hans'],
      ['ja', 'zh-Hans'],
    ]) {
      try {
        log(
          `availability_${s}_${t}`,
          await Translator.availability({ sourceLanguage: s, targetLanguage: t }),
        );
      } catch (e) {
        log(`availability_${s}_${t}`, `ERR ${e?.name}: ${e?.message}`);
      }
    }
  }

  if ('LanguageDetector' in self) {
    try {
      log('detector_availability_noargs', await LanguageDetector.availability());
    } catch (e) {
      log('detector_availability_noargs', `ERR ${e?.name}: ${e?.message}`);
    }
    try {
      log(
        'detector_availability_en_ja',
        await LanguageDetector.availability({ expectedInputLanguages: ['en', 'ja'] }),
      );
    } catch (e) {
      log('detector_availability_en_ja', `ERR ${e?.name}: ${e?.message}`);
    }
    try {
      const det = await LanguageDetector.create();
      log('detect_ja', await det.detect('これは日本語の文章です。翻訳してください。'));
      log('detect_en', await det.detect('The quick brown fox jumps over the lazy dog.'));
      det.destroy?.();
    } catch (e) {
      log('detector_create_error', `${e?.name}: ${e?.message}`);
    }
  }
})();

document.getElementById('btn-en').addEventListener('click', async () => {
  log('click_en_userActivation', {
    isActive: navigator.userActivation?.isActive ?? null,
    hasBeenActive: navigator.userActivation?.hasBeenActive ?? null,
  });
  await translateWith('en', 'zh', ['Hello world.', 'Where is the nearest train station?']);
});

document.getElementById('btn-ja').addEventListener('click', async () => {
  log('click_ja_userActivation', {
    isActive: navigator.userActivation?.isActive ?? null,
    hasBeenActive: navigator.userActivation?.hasBeenActive ?? null,
  });
  await translateWith('ja', 'zh', ['こんにちは世界。', '最寄りの駅はどこですか。']);
});

document.getElementById('btn-nogesture').addEventListener('click', () => {
  // The click is only used to record intent; create runs after activation has expired.
  setTimeout(async () => {
    const state = {
      isActive: navigator.userActivation?.isActive ?? null,
      hasBeenActive: navigator.userActivation?.hasBeenActive ?? null,
    };
    log('nogesture_userActivation', state);
    try {
      const t0 = performance.now();
      const tr = await Translator.create({ sourceLanguage: 'en', targetLanguage: 'zh' });
      log('nogesture_create_ok_ms', Math.round(performance.now() - t0));
      log('nogesture_translate', await tr.translate('No gesture was used for this one.'));
      tr.destroy?.();
    } catch (e) {
      log('nogesture_create_error', `${e?.name}: ${e?.message}`);
    }
  }, 6000);
});

document.getElementById('btn-offscreen').addEventListener('click', () => {
  chrome.runtime
    .sendMessage({ type: 'RUN_OFFSCREEN_PROBE' })
    .catch((e) => log('offscreen_dispatch_error', String(e)));
  setTimeout(snap, 12000);
});

document.getElementById('btn-refresh').addEventListener('click', snap);

setInterval(snap, 2500);
snap();
