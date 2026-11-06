/**
 * Phase A probe 3: HTTP vs HTTPS content scripts, restart persistence, offline hot start.
 */
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const EXT = `${ROOT}/probe/local-ai`;
const PROFILE = '/tmp/fanyi-ext-probe-profile';
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9229;
const OUT = `${ROOT}/probe/context2-result.json`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
      }, 120_000);
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
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
      ...extra,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

async function runSession(label) {
  const out = { label, contexts: {}, sw: null, notes: [] };
  const chrome = launch();
  let browser;
  try {
    const version = await getJson(`http://127.0.0.1:${PORT}/json/version`);
    out.chromeVersion = version.Browser;
    browser = new CDP(version.webSocketDebuggerUrl);
    await browser.ready;
    const { id: extId } = await browser.send('Extensions.loadUnpacked', { path: EXT });
    out.extId = extId;
    await sleep(2000);

    const list = async () => getJson(`http://127.0.0.1:${PORT}/json/list`);
    const waitTarget = async (pred, timeout = 15_000) => {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        const t = (await list()).find(pred);
        if (t) return t;
        await sleep(300);
      }
      return null;
    };

    // Open a probe page and clear logs so entries belong to this session.
    await browser.send('Target.createTarget', { url: `chrome-extension://${extId}/probe.html` });
    const probeTarget = await waitTarget((t) => t.url === `chrome-extension://${extId}/probe.html`);
    const probe = new CDP(probeTarget.webSocketDebuggerUrl);
    await probe.ready;
    await probe.send('Runtime.enable');
    await sleep(1200);
    await probe.eval(`chrome.storage.local.clear()`);
    out.notes.push('cleared extension storage');

    // SW cold start
    const swTarget = await waitTarget(
      (t) => t.type === 'service_worker' && t.url.includes(`${extId}/sw.js`),
    );
    if (swTarget) {
      const sw = new CDP(swTarget.webSocketDebuggerUrl);
      await sw.ready;
      await sw.send('Runtime.enable');
      out.sw = JSON.parse(
        await sw.eval(`(async () => {
        const o = {};
        try { o.availability_en_zh = await Translator.availability({sourceLanguage:'en', targetLanguage:'zh'}); } catch (e) { o.availabilityError = e.name + ': ' + e.message; }
        try {
          const t0 = performance.now();
          const tr = await Translator.create({sourceLanguage:'en', targetLanguage:'zh'});
          o.createMs = Math.round(performance.now() - t0);
          let t1 = performance.now();
          o.translate = await tr.translate('The weather is nice today.');
          o.firstTranslateMs = Math.round(performance.now() - t1);
          t1 = performance.now();
          o.translate2 = await tr.translate('Please close the door.');
          o.secondTranslateMs = Math.round(performance.now() - t1);
        } catch (e) { o.createError = e.name + ': ' + e.message; }
        return JSON.stringify(o);
      })()`),
      );
      sw.close();
    } else {
      out.notes.push('no SW target');
    }

    const probeContext = async (url, label) => {
      await browser.send('Target.createTarget', { url });
      const t = await waitTarget((x) => x.url.startsWith(url), 20_000);
      if (!t) return { label, error: 'target missing', url };
      const page = new CDP(t.webSocketDebuggerUrl);
      await page.ready;
      await page.send('Runtime.enable');
      await sleep(2500);
      const facts = await page
        .eval(
          `(async () => ({
        href: location.href, protocol: location.protocol, secureContext: self.isSecureContext,
        hasTranslator: 'Translator' in self,
        availability_en_zh: await Translator.availability({sourceLanguage:'en', targetLanguage:'zh'}).catch(e => 'ERR ' + e.name),
      }))()`,
        )
        .catch((e) => ({ error: String(e) }));
      await page.click(5, 5);
      await sleep(3500);
      page.close();
      return { label, ...facts };
    };

    out.contexts.https = await probeContext('https://example.com/', 'https-example');
    out.contexts.http = await probeContext('http://neverssl.com/', 'http-neverssl');

    await sleep(1000);
    const stored = JSON.parse(
      await probe.eval(`chrome.storage.local.get(null).then(d => JSON.stringify(d))`),
    );
    out.contentLogs = stored.contentLog ?? [];
    out.offscreenLogs = stored.offscreenLog ?? [];

    // Offline hot start in the SW (disable network globally through the browser target).
    const swTarget2 = await waitTarget(
      (t) => t.type === 'service_worker' && t.url.includes(`${extId}/sw.js`),
      5000,
    );
    if (swTarget2) {
      const sw = new CDP(swTarget2.webSocketDebuggerUrl);
      await sw.ready;
      await sw.send('Runtime.enable');
      try {
        await sw.send('Network.enable');
        await sw.send('Network.emulateNetworkConditions', {
          offline: true,
          latency: 0,
          downloadThroughput: 0,
          uploadThroughput: 0,
        });
        out.offlineSw = JSON.parse(
          await sw.eval(`(async () => {
          const o = {};
          try {
            const t0 = performance.now();
            const tr = await Translator.create({sourceLanguage:'ja', targetLanguage:'zh'});
            o.createMs = Math.round(performance.now() - t0);
            o.translate = await tr.translate('オフラインでも翻訳できるでしょうか。');
          } catch (e) { o.error = e.name + ': ' + e.message; }
          return JSON.stringify(o);
        })()`),
        );
        await sw.send('Network.emulateNetworkConditions', {
          offline: false,
          latency: 0,
          downloadThroughput: -1,
          uploadThroughput: -1,
        });
      } catch (e) {
        out.offlineSw = { error: String(e) };
      }
      sw.close();
    }
    probe.close();
  } catch (e) {
    out.error = `${e?.name}: ${e?.message}`;
  } finally {
    try {
      await browser?.send('Browser.close');
    } catch {}
    browser?.close();
    await sleep(1500);
    chrome.kill('SIGTERM');
  }
  return out;
}

const result = { startedAt: new Date().toISOString(), sessions: [] };
result.sessions.push(await runSession('cold-after-extension-reload'));
result.sessions.push(await runSession('second-restart'));
result.finishedAt = new Date().toISOString();
await writeFile(OUT, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
process.exit(0);
