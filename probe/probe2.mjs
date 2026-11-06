/**
 * Phase A probe 2 (extension contexts, lifecycle, local corpus).
 * Reuses the models downloaded by probe 1 in /tmp/fanyi-ext-probe-profile.
 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const EXT = `${ROOT}/probe/local-ai`;
const OUT = `${ROOT}/probe/context-result.json`;
const CORPUS_OUT = `${ROOT}/probe/quality-local.json`;
const PROFILE = '/tmp/fanyi-ext-probe-profile';
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9228;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EN = [
  'serendipity',
  'The bank approved the loan after reviewing the documents.',
  'A bank of clouds gathered over the river bank before the storm.',
  'She did not agree that the report was complete.',
  'The device measures 12.5 centimeters and weighs 380 grams.',
  'No later than 5 p.m. on March 3, 2027, submit the signed contract.',
  'The API returns a 429 status code when the request rate limit is exceeded.',
  'Although the prototype worked in the lab, it failed under heavy load in production.',
  'The committee, which had met three times without reaching a decision, postponed the vote again.',
  'The patient recovered quickly; however, the follow-up scan showed a small abnormality.',
  'The museum’s new wing houses paintings by Monet, Renoir, and Degas.',
  'Please confirm whether the shipment has left the warehouse.',
  'All employees must complete the safety training before entering the construction site.',
  'He said that he would call back after the meeting, but he never did.',
  'The temperature dropped to −7°C overnight, and the roads became icy.',
  'Bitcoin fell 8% on Tuesday, while gold rose slightly.',
  'The novel’s protagonist struggles with grief, memory, and the passage of time.',
  'This feature is disabled by default; enable it in Settings → Privacy.',
  'The study found no significant difference between the two treatments.',
  'Despite the rain, thousands of people attended the outdoor concert.',
];

const JA = [
  '木漏れ日',
  '昨日は駅前の喫茶店で友達と会いました。',
  '彼は忙しいと言っていたが、実際にはそれほど忙しくなかった。',
  'この機械は幅30センチ、重さは約2キロです。',
  '会議は来週の火曜日の午後3時から行われる予定です。',
  '窓を閉めてもいいですか。',
  '雨が降ったので、試合は中止になった。',
  '彼女は日本語だけでなく、英語と中国語も話せる。',
  'この薬は食後に服用してください。眠くなる場合があります。',
  'レポートはまだ提出していません。',
  '東京と大阪を結ぶ新幹線は、1時間に最大12本運行されている。',
  '人生には、どうしても避けられない別れがある。',
  '駅までの道を教えていただけませんか。',
  '値段は少し高いですが、品質はとても良いです。',
  'その話は本当なのか、私にはよく分からない。',
  '会議の資料を先に送っておきます。',
  '彼が来るかどうかはまだ分からない。',
  '子供たちは公園で元気に遊んでいる。',
  'ご不明な点がございましたら、お気軽にお問い合わせください。',
  '台風の影響で、明日の便は欠航となる見込みです。',
];

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.ready = new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = rej;
    });
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
      }
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          rej(new Error('timeout ' + method));
        }
      }, 360_000);
    });
  }
  async eval(expression, awaitPromise = true) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
    });
    if (r.exceptionDetails)
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
  async click(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      clickCount: 1,
    });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      clickCount: 1,
    });
  }
  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

async function getJson(url, tries = 100) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch {}
    await sleep(200);
  }
  throw new Error('timeout ' + url);
}

const launch = (extra = []) =>
  spawn(
    CHROME,
    [
      `--user-data-dir=${PROFILE}`,
      `--remote-debugging-port=${PORT}`,
      '--enable-unsafe-extension-debugging',
      '--offscreen-document-testing',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
      ...extra,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

async function main() {
  const result = { startedAt: new Date().toISOString(), sections: {}, errors: [] };
  let chrome = launch();
  let browser;
  try {
    const version = await getJson(`http://127.0.0.1:${PORT}/json/version`);
    result.chromeVersion = version.Browser;
    browser = new CDP(version.webSocketDebuggerUrl);
    await browser.ready;
    const { id: extId } = await browser.send('Extensions.loadUnpacked', { path: EXT });
    result.extId = extId;
    await sleep(1500);

    const targets = async () => getJson(`http://127.0.0.1:${PORT}/json/list`);
    const findTarget = async (pred, timeout = 10_000) => {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        const t = (await targets()).find(pred);
        if (t) return t;
        await sleep(300);
      }
      return null;
    };

    // --- Service worker context ---
    const swTarget = await findTarget((t) => t.type === 'service_worker' && t.url.includes(extId));
    if (!swTarget) throw new Error('service worker target not found');
    const sw = new CDP(swTarget.webSocketDebuggerUrl);
    await sw.ready;
    await sw.send('Runtime.enable');
    result.sections.sw = JSON.parse(
      await sw.eval(
        `(async () => {
      const out = { hasTranslator: 'Translator' in self, hasDocument: typeof document !== 'undefined' };
      try { out.availability = await Translator.availability({sourceLanguage:'en', targetLanguage:'zh'}); } catch (e) { out.availabilityError = e.name + ': ' + e.message; }
      try {
        const t0 = performance.now();
        const tr = await Translator.create({sourceLanguage:'en', targetLanguage:'zh'});
        out.createMs = Math.round(performance.now() - t0);
        const t1 = performance.now();
        out.translated = await tr.translate('Service workers can translate this sentence.');
        out.translateMs = Math.round(performance.now() - t1);
        tr.destroy?.();
      } catch (e) { out.createError = e.name + ': ' + e.message; }
      try { out.detector = await (await LanguageDetector.create()).detect('これは日本語です。'); } catch (e) { out.detectorError = e.name + ': ' + e.message; }
      return JSON.stringify(out);
    })()`.replace(/\n/g, ' '),
      ),
    );
    sw.close();

    // --- Content script on https and http pages ---
    const contextProbe = async (url, label) => {
      await browser.send('Target.createTarget', { url });
      const t = await findTarget((x) => x.url.startsWith(url), 15_000);
      if (!t) return { url, error: 'target missing' };
      const page = new CDP(t.webSocketDebuggerUrl);
      await page.ready;
      await page.send('Runtime.enable');
      await sleep(2000);
      await page.eval(`(() => { window.__probeReady = true; })()`);
      const facts = JSON.parse(
        await page
          .eval(
            `JSON.stringify({
        url: location.href, secureContext: self.isSecureContext,
        hasTranslator: 'Translator' in self, hasLanguageDetector: 'LanguageDetector' in self,
        availability: await Translator.availability({sourceLanguage:'en', targetLanguage:'zh'}).catch(e => 'ERR ' + e.name),
      })`,
          )
          .catch((e) => JSON.stringify({ error: String(e) })),
      );
      await page.click(5, 5);
      await sleep(4000);
      page.close();
      const log = await new Promise(async (resolve) => {
        // read via the probe storage from a fresh probe page below
        resolve(null);
      });
      return { label, ...facts };
    };
    const httpsPage = await contextProbe('https://example.com/', 'https');
    const httpPage = await contextProbe('http://neverssl.com/', 'http');

    // --- Offscreen (TESTING reason only, with the probe-only switch) ---
    await browser.send('Target.createTarget', { url: `chrome-extension://${extId}/probe.html` });
    const probeTarget = await findTarget((t) => t.url === `chrome-extension://${extId}/probe.html`);
    const probePage = new CDP(probeTarget.webSocketDebuggerUrl);
    await probePage.ready;
    await probePage.send('Runtime.enable');
    await sleep(1500);
    await probePage.eval(`chrome.runtime.sendMessage({type:'RUN_OFFSCREEN_PROBE'})`);
    await sleep(9000);
    const stored = JSON.parse(
      await probePage.eval(`chrome.storage.local.get(null).then(d => JSON.stringify(d))`),
    );
    result.sections.contentLogs = stored.contentLog ?? [];
    result.sections.offscreenLogs = stored.offscreenLog ?? [];

    // --- Corpus run in the extension page (models already available) ---
    const corpus = await probePage.eval(
      `(async () => {
      const out = [];
      const runPair = async (sourceLanguage, samples) => {
        const tr = await Translator.create({ sourceLanguage, targetLanguage: 'zh-Hans' });
        for (const text of samples) {
          const t0 = performance.now();
          try {
            const translated = await tr.translate(text);
            out.push({ sourceLanguage, text, translated, ms: Math.round(performance.now() - t0) });
          } catch (e) {
            out.push({ sourceLanguage, text, error: e.name + ': ' + e.message });
          }
        }
        tr.destroy?.();
      };
      await runPair('en', ${JSON.stringify(EN)});
      await runPair('ja', ${JSON.stringify(JA)});
      return JSON.stringify(out);
    })()`,
      true,
    );
    await writeFile(
      CORPUS_OUT,
      JSON.stringify(
        { at: new Date().toISOString(), chrome: result.chromeVersion, rows: JSON.parse(corpus) },
        null,
        2,
      ),
    );
    result.sections.corpus = { file: CORPUS_OUT, rows: JSON.parse(corpus).length };

    probePage.close();
  } catch (e) {
    result.errors.push(`${e?.name}: ${e?.message}`);
  } finally {
    try {
      await browser?.send('Browser.close');
    } catch {}
    browser?.close();
    await sleep(1500);
    chrome.kill('SIGTERM');
  }

  // --- Restart: verify models persist and measure cold-SW hot translation ---
  try {
    chrome = launch(['--disable-background-networking']);
    const version = await getJson(`http://127.0.0.1:${PORT}/json/version`);
    browser = new CDP(version.webSocketDebuggerUrl);
    await browser.ready;
    // The extension is unpacked into the profile and persists for the profile.
    const targets = await sleep(2500).then(() => getJson(`http://127.0.0.1:${PORT}/json/list`));
    let swTarget = targets.find(
      (t) =>
        t.type === 'service_worker' && t.url.includes('sw.js') && t.url.includes(RESULT_EXT_ID),
    );
    // fallback: find our extension id by looking for probe page-able id from previous section
    const extId = result.extId;
    swTarget =
      swTarget ?? targets.find((t) => t.type === 'service_worker' && t.url.includes(extId));
    if (swTarget) {
      const sw = new CDP(swTarget.webSocketDebuggerUrl);
      await sw.ready;
      await sw.send('Runtime.enable');
      result.sections.restartSw = JSON.parse(
        await sw.eval(`(async () => {
        const out = {};
        try { out.availability = await Translator.availability({sourceLanguage:'en', targetLanguage:'zh'}); } catch (e) { out.availabilityError = e.name + ': ' + e.message; }
        try {
          const t0 = performance.now();
          const tr = await Translator.create({sourceLanguage:'en', targetLanguage:'zh'});
          out.createMs = Math.round(performance.now() - t0);
          const t1 = performance.now();
          out.translated = await tr.translate('After a browser restart, does translation still work?');
          out.translateMs = Math.round(performance.now() - t1);
        } catch (e) { out.createError = e.name + ': ' + e.message; }
        return JSON.stringify(out);
      })()`),
      );
      sw.close();
    } else {
      result.sections.restartSw = {
        error: 'service worker target not found after restart',
        targets: targets.map((t) => t.url),
      };
    }
    // Check the fixture page content script after restart.
    await browser.send('Target.createTarget', { url: 'http://localhost:8787/index.html' });
    await sleep(3000);
    const pageTargets = await getJson(`http://127.0.0.1:${PORT}/json/list`);
    const fixture = pageTargets.find((t) => t.url.startsWith('http://localhost:8787'));
    if (fixture) {
      const page = new CDP(fixture.webSocketDebuggerUrl);
      await page.ready;
      await page.send('Runtime.enable');
      await sleep(1000);
      result.sections.restartContent = JSON.parse(
        await page.eval(`(async () => JSON.stringify({
        secureContext: self.isSecureContext,
        hasTranslator: 'Translator' in self,
        availability: await Translator.availability({sourceLanguage:'ja', targetLanguage:'zh'}).catch(e => 'ERR ' + e.name),
        hasContentMarker: !!window.__fanyiProbe,
      }))()`),
      );
      page.close();
    }
  } catch (e) {
    result.errors.push(`restart: ${e?.name}: ${e?.message}`);
  } finally {
    try {
      await browser?.send('Browser.close');
    } catch {}
    browser?.close();
    chrome.kill('SIGTERM');
    result.finishedAt = new Date().toISOString();
    await mkdir(`${ROOT}/probe`, { recursive: true });
    await writeFile(OUT, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
    setTimeout(() => process.exit(0), 300);
  }
}

const RESULT_EXT_ID = ''; // filled at runtime; restart lookup uses result.extId
main();
