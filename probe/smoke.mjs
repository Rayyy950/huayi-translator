/**
 * Development smoke test for the built extension (test build with fake provider).
 * Loads dist-test into desktop Chrome via CDP and drives real selections.
 */
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const ROOT = path.resolve(import.meta.dirname, '..');
const EXT = `${ROOT}/dist-test`;
const PORT = 9233;
const PROFILE = '/tmp/huayi-smoke';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
      } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        this.logs.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
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
          rej(new Error(`timeout ${method}`));
        }
      }, 60_000);
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
  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

async function getJson(url, tries = 80) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch {}
    await sleep(200);
  }
  throw new Error('timeout ' + url);
}

const result = { steps: [], errors: [], checks: {} };
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

const check = (name, value) => {
  result.checks[name] = value;
  console.log(`${value ? 'PASS' : 'FAIL'} ${name}`);
};

try {
  const version = await getJson(`http://127.0.0.1:${PORT}/json/version`);
  const browser = new CDP(version.webSocketDebuggerUrl);
  await browser.ready;
  const { id: extId } = await browser.send('Extensions.loadUnpacked', { path: EXT });
  result.extId = extId;
  await sleep(2000);

  const list = async () => getJson(`http://127.0.0.1:${PORT}/json/list`);
  const waitFor = async (pred, timeout = 15_000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const t = (await list()).find(pred);
      if (t) return t;
      await sleep(300);
    }
    return null;
  };
  const open = async (url) => {
    await browser.send('Target.createTarget', { url });
    const target = await waitFor((t) => t.url.startsWith(url), 15_000);
    if (!target) throw new Error('target missing ' + url);
    const page = new CDP(target.webSocketDebuggerUrl);
    await page.ready;
    await page.send('Runtime.enable');
    await page.send('Page.enable');
    return page;
  };

  const options = await open(`chrome-extension://${extId}/options.html`);
  await sleep(1500);
  const optionsText = await options.eval(`document.body.innerText.slice(0, 400)`);
  check('options renders', optionsText.includes('划译设置'));

  const settingsResponse = await options.eval(`chrome.runtime.sendMessage({
    type: 'UPDATE_SETTINGS',
    patch: { enabled: true, engineMode: 'cloud-only', useFakeProvider: true, dailySoftLimit: null, cloudFallback: false }
  }).then(r => JSON.stringify(r))`);
  check('test provider enabled', JSON.parse(settingsResponse).ok === true);
  await options.eval(`chrome.runtime.sendMessage({type:'CLEAR_CACHE'})`);
  await sleep(300);

  const fixture = await open(`http://localhost:8787/index.html?smoke=${Date.now()}`);
  await sleep(2500);
  const hasContent = await fixture.eval(`!!document.querySelector('[data-huayi-host]')`);
  check('content script injects', hasContent === true);
  result.steps.push('fixture opened');

  const selectParagraph = async (selector) => {
    await fixture.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, clientX: 20, clientY: 20 }));
      return true;
    })()`);
  };

  await selectParagraph('#para');
  await sleep(1300);
  const panelText = await fixture.eval(
    `document.querySelector('[data-huayi-host]')?.shadowRoot?.textContent ?? ''`,
  );
  console.log('PANEL TEXT:', JSON.stringify(panelText));
  check(
    'panel shows fake translation',
    panelText.includes('测试译文') && panelText.includes('Select this English'),
  );
  check('panel shows engine', panelText.includes('TokenHub') || panelText.includes('测试'));

  // Race: slow selection first, then fast selection. Only the fast text may win.
  await fixture.eval(`(() => {
    const slow = document.createElement('p'); slow.id = 'slow-text';
    slow.textContent = '[[slow]] The first slow request should never win.';
    const fast = document.createElement('p'); fast.id = 'fast-text';
    fast.textContent = '[[fast]] The second fast request must win.';
    document.body.append(slow, fast);
  })()`);
  const selectEl = async (id) => {
    await fixture.eval(`(() => {
      const el = document.getElementById(${JSON.stringify(id)});
      const range = document.createRange(); range.selectNodeContents(el);
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, clientX: 30, clientY: 30 }));
    })()`);
  };
  await selectEl('slow-text');
  await sleep(350);
  await selectEl('fast-text');
  await sleep(2600);
  const raceText = await fixture.eval(
    `document.querySelector('[data-huayi-host]')?.shadowRoot?.textContent ?? ''`,
  );
  console.log('RACE TEXT:', JSON.stringify(raceText));
  check(
    'latest request wins',
    raceText.includes('second fast request') && !raceText.includes('first slow request'),
  );

  // Pin, scroll, close.
  await fixture.eval(`(() => {
    const root = document.querySelector('[data-huayi-host]')?.shadowRoot;
    root?.querySelector('button[aria-label="固定浮层"]')?.click();
  })()`);
  await sleep(200);
  const pinned = await fixture.eval(
    `document.querySelector('[data-huayi-host]')?.shadowRoot?.querySelector('button[aria-label="取消固定浮层"]')?.getAttribute('aria-pressed')`,
  );
  await fixture.eval(`window.scrollTo(0, 400)`);
  await sleep(300);
  const visibleAfterScroll = await fixture.eval(
    `getComputedStyle(document.querySelector('[data-huayi-host]').shadowRoot.querySelector('.huayi-container')).display`,
  );
  check('pin survives scroll', pinned === 'true' && visibleAfterScroll === 'block');
  const shot = await fixture.send('Page.captureScreenshot', { format: 'png' });
  await writeFile('/tmp/huayi-panel.png', Buffer.from(shot.data, 'base64'));

  await fixture.eval(`(() => {
    const root = document.querySelector('[data-huayi-host]')?.shadowRoot;
    root?.querySelector('button[aria-label="关闭浮层"]')?.click();
  })()`);
  await sleep(200);
  const hidden = await fixture.eval(
    `getComputedStyle(document.querySelector('[data-huayi-host]').shadowRoot.querySelector('.huayi-container')).display`,
  );
  check('close hides panel', hidden === 'none');

  // Japanese paragraph.
  await selectParagraph('p:nth-of-type(2)');
  await sleep(1300);
  const jaText = await fixture.eval(
    `document.querySelector('[data-huayi-host]')?.shadowRoot?.textContent ?? ''`,
  );
  console.log('JA TEXT:', JSON.stringify(jaText));
  check('japanese selection translates', jaText.includes('测试译文') && jaText.includes('日本語'));

  const popup = await open(`chrome-extension://${extId}/popup.html`);
  await sleep(1200);
  const popupText = await popup.eval(`document.body.innerText`);
  check('popup renders', popupText.includes('划译') && popupText.includes('固定云端'));

  result.errors.push(...options.logs, ...fixture.logs);
} catch (error) {
  result.errors.push(String(error));
  console.error(error);
} finally {
  try {
    const v = await getJson(`http://127.0.0.1:${PORT}/json/version`, 5);
    const b = new CDP(v.webSocketDebuggerUrl);
    await b.ready;
    await b.send('Browser.close');
  } catch {}
  chrome.kill('SIGTERM');
  console.log(JSON.stringify(result, null, 2));
  setTimeout(() => process.exit(result.errors.length ? 1 : 0), 500);
}
