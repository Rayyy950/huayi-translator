/**
 * Phase A: built-in AI probe in a plain desktop Chrome page (no extension).
 * Uses a real mouse click to obtain transient user activation.
 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const PORT = 9225;
const PROFILE = '/tmp/fanyi-ai-profile';
const OUT = path.resolve(import.meta.dirname, 'plain-ai-result.json');
const URL = 'http://localhost:8787/index.html';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.logs = [];
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
      } else if (m.method === 'Runtime.consoleAPICalled') {
        const t = m.params.args.map((a) => a.value ?? a.description).join(' ');
        this.logs.push(t);
        console.log('[console]', t);
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
      }, 300000);
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
  async click(selector) {
    const rect = await this.eval(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.scrollIntoView({block:'center'}); const r = el.getBoundingClientRect(); return {x:r.x+r.width/2, y:r.y+r.height/2}; })()`,
    );
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: rect.x,
      y: rect.y,
      button: 'left',
      clickCount: 1,
    });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: rect.x,
      y: rect.y,
      button: 'left',
      clickCount: 1,
    });
  }
}

const result = {
  startedAt: new Date().toISOString(),
  facts: {},
  translations: [],
  detector: null,
  errors: [],
};
const chrome = spawn(
  CHROME,
  [
    `--user-data-dir=${PROFILE}`,
    `--remote-debugging-port=${PORT}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    URL,
  ],
  { stdio: 'ignore' },
);

try {
  const version = await getJson(`http://127.0.0.1:${PORT}/json/version`);
  result.chromeVersion = version.Browser;
  const list = await getJson(`http://127.0.0.1:${PORT}/json/list`);
  const target = list.find((t) => t.type === 'page' && t.url.startsWith('http://localhost:8787'));
  if (!target)
    throw new Error('fixture target not found: ' + JSON.stringify(list.map((t) => t.url)));
  const page = new CDP(target.webSocketDebuggerUrl);
  await page.ready;
  await page.send('Runtime.enable');
  await sleep(1000);

  result.facts = await page
    .eval(
      `JSON.stringify({
    ua: navigator.userAgent,
    secureContext: self.isSecureContext,
    hasTranslator: 'Translator' in self,
    hasLanguageDetector: 'LanguageDetector' in self,
    translatorType: typeof self.Translator,
    storageQuota: navigator.storage ? 'present' : 'absent',
  })`,
    )
    .then(JSON.parse);
  for (const [s, t] of [
    ['en', 'zh'],
    ['ja', 'zh'],
    ['en', 'zh-Hans'],
    ['ja', 'zh-Hans'],
  ]) {
    try {
      result.facts[`availability_${s}_${t}`] = await page.eval(
        `Translator.availability({sourceLanguage:${JSON.stringify(s)}, targetLanguage:${JSON.stringify(t)}})`,
      );
    } catch (e) {
      result.facts[`availability_${s}_${t}`] = 'ERR ' + e.message;
    }
  }
  if ('LanguageDetector' in globalThis) {
  }
  try {
    result.facts.detectorAvailability = await page.eval(`LanguageDetector.availability()`);
  } catch (e) {
    result.facts.detectorAvailability = 'ERR ' + e.message;
  }

  // Real click gives the page transient activation; run create() inside the click handler.
  await page.eval(`(() => {
    const btn = document.createElement('button');
    btn.id = 'ai-run';
    btn.textContent = 'run ai';
    btn.style.cssText = 'position:fixed;left:10px;top:10px;z-index:99999;padding:20px';
    document.body.appendChild(btn);
    window.__ai = { events: [], done: false };
    btn.addEventListener('click', async () => {
      const t0 = performance.now();
      try {
        const tr = await Translator.create({ sourceLanguage: 'en', targetLanguage: 'zh', monitor(m) {
          m.addEventListener('downloadprogress', e => window.__ai.events.push({ type: 'download', pair: 'en-zh', loaded: e.loaded }));
        }});
        window.__ai.events.push({ type: 'created', pair: 'en-zh', ms: Math.round(performance.now() - t0) });
        const t1 = performance.now();
        const out = await tr.translate('Where is the nearest train station, please?');
        window.__ai.events.push({ type: 'translated', pair: 'en-zh', input: 'Where is the nearest train station, please?', output: out, ms: Math.round(performance.now() - t1) });
        await tr.translate('The meeting was postponed because the manager was not satisfied with the figures.');
        try { tr.destroy(); } catch {}
      } catch (e) {
        window.__ai.events.push({ type: 'error', pair: 'en-zh', error: e?.name + ': ' + e?.message });
      }
      try {
        const t2 = performance.now();
        const tr2 = await Translator.create({ sourceLanguage: 'ja', targetLanguage: 'zh', monitor(m) {
          m.addEventListener('downloadprogress', e => window.__ai.events.push({ type: 'download', pair: 'ja-zh', loaded: e.loaded }));
        }});
        window.__ai.events.push({ type: 'created', pair: 'ja-zh', ms: Math.round(performance.now() - t2) });
        const out2 = await tr2.translate('明日の会議は午後三時からです。資料を準備してください。');
        window.__ai.events.push({ type: 'translated', pair: 'ja-zh', input: '明日の会議は午後三時からです。資料を準備してください。', output: out2, ms: Math.round(performance.now() - performance.now()) });
        try { tr2.destroy(); } catch {}
      } catch (e) {
        window.__ai.events.push({ type: 'error', pair: 'ja-zh', error: e?.name + ': ' + e?.message });
      }
      try {
        const det = await LanguageDetector.create();
        const d1 = await det.detect('これは日本語の文章です。翻訳してください。');
        const d2 = await det.detect('The quick brown fox jumps over the lazy dog.');
        window.__ai.detector = { ja: d1, en: d2 };
        det.destroy?.();
      } catch (e) { window.__ai.detectorError = e?.name + ': ' + e?.message; }
      window.__ai.done = true;
    });
  })()`);
  await sleep(500);
  await page.click('#ai-run');

  const deadline = Date.now() + 300_000;
  let lastCount = 0;
  while (Date.now() < deadline) {
    await sleep(3000);
    const state = JSON.parse(await page.eval(`JSON.stringify(window.__ai)`));
    if (state.events.length !== lastCount) {
      console.log('[ai]', JSON.stringify(state.events.slice(lastCount)));
      lastCount = state.events.length;
    }
    if (state.done) {
      result.ai = state;
      break;
    }
  }
  result.activation = await page
    .eval(
      `JSON.stringify({isActive: navigator.userActivation.isActive, hasBeenActive: navigator.userActivation.hasBeenActive})`,
    )
    .then(JSON.parse);
  if (!result.ai) result.errors.push('AI run did not finish within 300s');
} catch (e) {
  result.errors.push(`${e?.name}: ${e?.message}`);
} finally {
  result.finishedAt = new Date().toISOString();
  chrome.kill('SIGTERM');
  await mkdir(import.meta.dirname, { recursive: true });
  await writeFile(OUT, JSON.stringify(result, null, 2));
  console.log('wrote', OUT, 'errors:', result.errors);
  setTimeout(() => process.exit(0), 500);
}
