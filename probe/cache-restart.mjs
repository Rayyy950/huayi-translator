/**
 * Verifies that the translation cache (chrome.storage.session) does not survive
 * a clean browser restart, while settings (chrome.storage.local) do.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const EXT = path.resolve(import.meta.dirname, '..', 'dist-test');
const PROFILE = '/tmp/huayi-cache-restart';
const PORT = 9239;
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
      }, 30000);
    });
  }
  async eval(e) {
    const r = await this.send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
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
  throw new Error('timeout ' + u);
}

const launch = () =>
  spawn(
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

async function session(label) {
  const chrome = launch();
  const version = await j(`http://127.0.0.1:${PORT}/json/version`);
  const browser = new CDP(version.webSocketDebuggerUrl);
  await browser.ready;
  const { id: extId } = await browser.send('Extensions.loadUnpacked', { path: EXT });
  await sleep(1500);
  const out = { label, extId };
  const targets = await j(`http://127.0.0.1:${PORT}/json/list`);
  const waitFor = async (pred, timeout = 15000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const t = (await j(`http://127.0.0.1:${PORT}/json/list`)).find(pred);
      if (t) return t;
      await sleep(300);
    }
    return null;
  };
  await browser.send('Target.createTarget', { url: `chrome-extension://${extId}/options.html` });
  const target = await waitFor((t) => t.url === `chrome-extension://${extId}/options.html`);
  const page = new CDP(target.webSocketDebuggerUrl);
  await page.ready;
  await page.send('Runtime.enable');
  await sleep(1200);
  out.statsBefore = JSON.parse(
    await page.eval(`chrome.runtime.sendMessage({type:'GET_CACHE_STATS'}).then(r=>JSON.stringify(r))`),
  );
  out.settings = JSON.parse(
    await page.eval(`chrome.runtime.sendMessage({type:'GET_SETTINGS'}).then(r=>JSON.stringify(r.data))`),
  );
  if (label === 'first') {
    await page.eval(
      `chrome.runtime.sendMessage({type:'UPDATE_SETTINGS', patch:{enabled:true,engineMode:'cloud-only',sourceLanguage:'auto',useFakeProvider:true,dailySoftLimit:null}})`,
    );
    await page.eval(`chrome.runtime.sendMessage({type:'CLEAR_CACHE'})`);
    await browser.send('Target.createTarget', { url: 'http://localhost:8787/index.html?cache-restart=1' });
    const fixture = await waitFor((t) => t.url.includes('localhost:8787'));
    const fp = new CDP(fixture.webSocketDebuggerUrl);
    await fp.ready;
    await fp.send('Runtime.enable');
    await sleep(2000);
    await fp.eval(`(() => {
      const el = document.querySelector('#para');
      const range = document.createRange(); range.selectNodeContents(el);
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
    })()`);
    await sleep(2000);
    out.translated = await fp.eval(
      `document.querySelector('[data-huayi-host]')?.shadowRoot?.querySelector('.translation')?.textContent ?? ''`,
    );
    await sleep(800);
    out.statsBefore = JSON.parse(
      await page.eval(`chrome.runtime.sendMessage({type:'GET_CACHE_STATS'}).then(r=>JSON.stringify(r))`),
    );
    fp.ws.close();
  }
  page.ws.close();
  await browser.send('Browser.close');
  browser.ws.close();
  const exited = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 10_000);
    chrome.on('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  out.cleanExit = exited;
  if (!exited) chrome.kill('SIGTERM');
  await sleep(800);
  return out;
}

const first = await session('first');
const second = await session('second');
console.log(
  JSON.stringify(
    {
      first: {
        translated: first.translated,
        statsBefore: first.statsBefore,
        cleanExit: first.cleanExit,
        enabled: first.settings.enabled,
      },
      second: { statsAfterRestart: second.statsBefore, cleanExit: second.cleanExit },
      cacheCleared: (second.statsBefore?.data?.entries ?? -1) === 0,
      settingsPersisted: second.settings.enabled === true && second.settings.engineMode === 'cloud-only',
      translationWorked: String(first.translated).includes('测试译文'),
    },
    null,
    2,
  ),
);
process.exit(0);
