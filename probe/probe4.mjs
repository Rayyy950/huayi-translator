/**
 * Phase A probe 4: isolated-world Translator availability on HTTP vs HTTPS.
 * Evaluates inside the content script's execution context (not the page main world).
 */
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const EXT = `${ROOT}/probe/local-ai`;
const PROFILE = '/tmp/fanyi-ext-probe-profile';
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9230;
const OUT = `${ROOT}/probe/context3-result.json`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.contexts = [];
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
      } else if (m.method === 'Runtime.executionContextCreated')
        this.contexts.push(m.params.context);
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
      }, 60_000);
    });
  }
  async eval(expression, contextId) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      ...(contextId ? { contextId } : {}),
    });
    if (r.exceptionDetails)
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
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

const chrome = spawn(
  CHROME,
  [
    `--user-data-dir=${PROFILE}`,
    `--remote-debugging-port=${PORT}`,
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const result = { at: new Date().toISOString(), pages: [] };
try {
  const version = await getJson(`http://127.0.0.1:${PORT}/json/version`);
  const browser = new CDP(version.webSocketDebuggerUrl);
  await browser.ready;
  const { id: extId } = await browser.send('Extensions.loadUnpacked', { path: EXT });
  result.extId = extId;
  result.chromeVersion = version.Browser;
  await sleep(1500);

  for (const url of [
    'https://example.com/',
    'http://neverssl.com/',
    'http://localhost:8787/index.html',
  ]) {
    await browser.send('Target.createTarget', { url });
    await sleep(3500);
    const list = await getJson(`http://127.0.0.1:${PORT}/json/list`);
    const t = list.find((x) => x.url.startsWith(url));
    if (!t) {
      result.pages.push({ url, error: 'target missing' });
      continue;
    }
    const page = new CDP(t.webSocketDebuggerUrl);
    await page.ready;
    await page.send('Runtime.enable');
    await sleep(1500);
    const isolated = page.contexts.filter(
      (c) => c.auxData?.type === 'isolated' || (c.name && c.name.includes('Feasibility')),
    );
    const out = { url, href: null, contexts: [] };
    for (const ctx of isolated) {
      try {
        out.contexts.push({
          name: ctx.name,
          origin: ctx.origin,
          facts: await page.eval(
            `(async () => ({
            href: location.href, protocol: location.protocol, secureContext: self.isSecureContext,
            hasTranslator: 'Translator' in self, hasDetector: 'LanguageDetector' in self,
            availability_en_zh: 'Translator' in self
              ? await Translator.availability({sourceLanguage:'en', targetLanguage:'zh'}).catch(e => 'ERR ' + e.name)
              : null,
          }))()`,
            ctx.id,
          ),
        });
      } catch (e) {
        out.contexts.push({ name: ctx.name, error: String(e) });
      }
    }
    result.pages.push(out);
    page.ws.close();
  }
} catch (e) {
  result.error = String(e);
} finally {
  try {
    await fetch(`http://127.0.0.1:${PORT}/json/version`)
      .then((r) => r.json())
      .then((v) => {
        const b = new CDP(v.webSocketDebuggerUrl);
        b.ready.then(() => b.send('Browser.close'));
      });
  } catch {}
  chrome.kill('SIGTERM');
  await writeFile(OUT, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  setTimeout(() => process.exit(0), 500);
}
