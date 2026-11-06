/**
 * Real-page smoke: local translation on an article, a tech doc, and a
 * client-rendered page. Uses the prepared local profile.
 */
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const EXT = path.resolve(import.meta.dirname, '..', 'dist-test');
const PORT = 9240;
const PROFILE = process.env.PROBE_PROFILE || '/tmp/huayi-local-test-fresh2';
const OUT = path.resolve(import.meta.dirname, 'real-pages.json');
const PAGES = (process.env.PAGES ?? [
  'https://en.wikipedia.org/wiki/Translation',
  'https://developer.chrome.com/docs/ai/translator-api',
  'https://react.dev/learn',
].join(',')).split(',');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(u) {
    this.ws = new WebSocket(u);
    this.id = 0;
    this.p = new Map();
    this.ready = new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = rej;
    });
    this.ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.p.has(m.id)) {
        const q = this.p.get(m.id);
        this.p.delete(m.id);
        m.error ? q.rej(new Error(JSON.stringify(m.error))) : q.res(m.result);
      }
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.p.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.p.has(id)) {
          this.p.delete(id);
          rej(new Error('timeout'));
        }
      }, 60000);
    });
  }
  async eval(e) {
    const r = await this.send('Runtime.evaluate', {
      expression: e,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails)
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
}
async function j(u) {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(u);
      if (r.ok) return r.json();
    } catch {}
    await sleep(200);
  }
  throw new Error('timeout');
}

const chrome = spawn(
  CHROME,
  [
    `--user-data-dir=${PROFILE}`,
    `--remote-debugging-port=${PORT}`,
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1280,900',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const out = { pages: [], errors: [] };
try {
  const v = await j(`http://127.0.0.1:${PORT}/json/version`);
  const browser = new CDP(v.webSocketDebuggerUrl);
  await browser.ready;
  const { id: extId } = await browser.send('Extensions.loadUnpacked', { path: EXT });
  await sleep(1800);
  await browser.send('Target.createTarget', { url: `chrome-extension://${extId}/options.html` });
  await sleep(1200);
  const list = await j(`http://127.0.0.1:${PORT}/json/list`);
  const optTarget = list.find((t) => t.url === `chrome-extension://${extId}/options.html`);
  const options = new CDP(optTarget.webSocketDebuggerUrl);
  await options.ready;
  await options.send('Runtime.enable');
  await options.eval(
    `chrome.runtime.sendMessage({type:'UPDATE_SETTINGS', patch:{enabled:true,engineMode:'local-only',sourceLanguage:'en',debounceMs:250,dailySoftLimit:null,useFakeProvider:false}})`,
  );

  for (const url of PAGES) {
    const before = Date.now();
    await browser.send('Target.createTarget', { url });
    let target = null;
    for (let i = 0; i < 60; i++) {
      const l = await j(`http://127.0.0.1:${PORT}/json/list`);
      target = l.find((t) => t.url.startsWith(url.split('#')[0]));
      if (target) break;
      await sleep(300);
    }
    if (!target) {
      out.pages.push({ url, error: 'target missing' });
      continue;
    }
    const page = new CDP(target.webSocketDebuggerUrl);
    await page.ready;
    await page.send('Runtime.enable');
    await sleep(url.includes('react.dev') ? 5000 : url.includes('developer.chrome.com') ? 6000 : 2500);
    const sample = await page.eval(`(async () => {
      const paragraphs = Array.from(document.querySelectorAll('p, li, main div'))
        .filter(p => {
          const text = (p.innerText || '').trim();
          return text.length >= 60 && text.length <= 500 &&
            p.children.length === 0 &&
            !p.closest('nav,header,footer,aside,script,style');
        });
      const el = paragraphs[0];
      if (!el) return { error: 'no paragraph' };
      const text = el.innerText.trim();
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      const t0 = performance.now();
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
      const host = document.querySelector('[data-huayi-host]');
      const root = host && host.shadowRoot;
      const result = await new Promise((resolve) => {
        const deadline = setTimeout(() => resolve({ error: 'timeout' }), 20000);
        const check = () => {
          const node = root && root.querySelector('.translation');
          const container = root && root.querySelector('.huayi-container');
          if (node && node.textContent && getComputedStyle(container).display === 'block') {
            clearTimeout(deadline);
            resolve({
              ms: Math.round((performance.now() - t0) * 10) / 10,
              translation: node.textContent.trim(),
              engine: root.querySelector('.engine')?.textContent || '',
              errorText: root.querySelector('.error p')?.textContent || '',
            });
          } else setTimeout(check, 10);
        };
        check();
      });
      return { sourceLength: text.length, source: text.slice(0, 160), ...result };
    })()`);
    out.pages.push({ url, loadAndRunMs: Date.now() - before, ...sample });
    page.ws.close();
  }
  options.ws.close();
} catch (error) {
  out.errors.push(String(error));
} finally {
  try {
    const v = await j(`http://127.0.0.1:${PORT}/json/version`, 5);
    const b = new CDP(v.webSocketDebuggerUrl);
    await b.ready;
    await b.send('Browser.close');
  } catch {}
  chrome.kill('SIGTERM');
  await writeFile(OUT, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  setTimeout(() => process.exit(0), 400);
}
