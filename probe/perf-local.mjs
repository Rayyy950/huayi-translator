/**
 * Measures pointerup → panel text visible with the real Chrome built-in
 * translator, through the packaged extension. Uses a prepared profile.
 */
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const EXT = path.resolve(import.meta.dirname, '..', 'dist-test');
const PORT = 9238;
const PROFILE = process.env.PROBE_PROFILE || '/tmp/huayi-local-test-fresh';
const OUT = path.resolve(import.meta.dirname, 'perf-local.json');
const ITERATIONS = 20;
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
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
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

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Math.round(sorted[Math.max(0, index)] * 10) / 10;
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

const result = { local: [], cache: [], errors: [] };
try {
  const v = await j(`http://127.0.0.1:${PORT}/json/version`);
  const browser = new CDP(v.webSocketDebuggerUrl);
  await browser.ready;
  const { id: extId } = await browser.send('Extensions.loadUnpacked', { path: EXT });
  await sleep(2000);
  const list = async () => j(`http://127.0.0.1:${PORT}/json/list`);
  const waitT = async (pred, t = 15000) => {
    const end = Date.now() + t;
    while (Date.now() < end) {
      const x = (await list()).find(pred);
      if (x) return x;
      await sleep(300);
    }
    return null;
  };
  const open = async (url) => {
    await browser.send('Target.createTarget', { url });
    const t = await waitT((z) => z.url.startsWith(url));
    const p = new CDP(t.webSocketDebuggerUrl);
    await p.ready;
    await p.send('Runtime.enable');
    return p;
  };
  const options = await open(`chrome-extension://${extId}/options.html`);
  await sleep(1500);
  await options.eval(
    `chrome.runtime.sendMessage({type:'UPDATE_SETTINGS', patch:{enabled:true,engineMode:'local-only',sourceLanguage:'en',debounceMs:250,dailySoftLimit:null,useFakeProvider:false}})`,
  );
  const modelStatus = await options.eval(
    `chrome.runtime.sendMessage({type:'GET_MODEL_STATUS'}).then(r=>JSON.stringify(r))`,
  );
  result.modelStatus = JSON.parse(modelStatus);

  const page = await open(`http://localhost:8787/index.html?perf=${Date.now()}`);
  await sleep(2500);

  const measure = async (selector, clearCache) => {
    if (clearCache) {
      await options.eval(`chrome.runtime.sendMessage({type:'CLEAR_CACHE'})`);
      await sleep(120);
    }
    return page.eval(`(async () => {
      const host = document.querySelector('[data-huayi-host]');
      const root = host?.shadowRoot;
      if (!root) return { ms: -1, error: 'no shadow root' };
      document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
      await new Promise(r => setTimeout(r, 60));
      const el = document.querySelector(${JSON.stringify(selector)});
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      const t0 = performance.now();
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
      return await new Promise((resolve) => {
        const deadline = setTimeout(() => resolve({ ms: -1, error: 'timeout' }), 20000);
        const check = () => {
          const node = root.querySelector('.translation');
          const container = root.querySelector('.huayi-container');
          const visible = container && getComputedStyle(container).display === 'block';
          if (visible && node && node.textContent && node.textContent.trim()) {
            clearTimeout(deadline);
            resolve({
              ms: Math.round((performance.now() - t0) * 10) / 10,
              text: node.textContent.trim(),
              cache: !!root.querySelector('.cache-badge'),
              engine: root.querySelector('.engine')?.textContent ?? '',
            });
          } else {
            setTimeout(check, 5);
          }
        };
        check();
      });
    })()`);
  };

  for (let i = 0; i < ITERATIONS; i++) {
    const sample = await measure('#para', true);
    result.local.push(sample);
    await sleep(200);
  }
  for (let i = 0; i < ITERATIONS; i++) {
    const sample = await measure('#para', i === 0);
    result.cache.push(sample);
    await sleep(120);
  }
} catch (error) {
  result.errors.push(String(error));
} finally {
  try {
    const v = await j(`http://127.0.0.1:${PORT}/json/version`, 5);
    const b = new CDP(v.webSocketDebuggerUrl);
    await b.ready;
    await b.send('Browser.close');
  } catch {}
  chrome.kill('SIGTERM');
  const good = (rows) => rows.filter((row) => row.ms >= 0);
  const localTimes = good(result.local).map((row) => row.ms);
  const cacheTimes = good(result.cache).map((row) => row.ms);
  result.summary = {
    local: {
      n: localTimes.length,
      success: localTimes.length / Math.max(1, result.local.length),
      p50: percentile(localTimes, 50),
      p95: percentile(localTimes, 95),
    },
    cache: {
      n: cacheTimes.length,
      success: cacheTimes.length / Math.max(1, result.cache.length),
      p50: percentile(cacheTimes, 50),
      p95: percentile(cacheTimes, 95),
    },
  };
  await writeFile(OUT, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result.summary, null, 2));
  console.log('sample:', JSON.stringify(result.local[0]));
  setTimeout(() => process.exit(0), 400);
}
