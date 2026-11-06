/**
 * End-to-end check of the real Chrome built-in Translator through the packaged
 * extension (test build, so site access is pre-granted and fake provider exists
 * but is disabled). This is Phase A/B/C local-path evidence.
 */
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const EXT = path.resolve(import.meta.dirname, '..', 'dist-test');
const PORT = 9236;
const PROFILE = process.env.PROBE_PROFILE || '/tmp/huayi-local-test-fresh';
const OUT = path.resolve(import.meta.dirname, 'local-e2e-result.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.errors = [];
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
      } else if (m.method === 'Runtime.exceptionThrown') {
        this.errors.push(
          m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text,
        );
      } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        this.errors.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
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
  async clickTestId(testId) {
    const rect = await this.eval(`(() => {
      const el = document.querySelector('[data-testid="${testId}"]');
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    if (!rect) throw new Error('missing testid ' + testId);
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

const result = { checks: {}, notes: [], errors: [] };
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

const check = (name, value, detail) => {
  result.checks[name] = { ok: Boolean(value), detail };
  console.log(`${value ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

try {
  const version = await getJson(`http://127.0.0.1:${PORT}/json/version`);
  const browser = new CDP(version.webSocketDebuggerUrl);
  await browser.ready;
  const { id: extId } = await browser.send('Extensions.loadUnpacked', { path: EXT });
  result.extId = extId;
  await sleep(2000);

  const list = async () => getJson(`http://127.0.0.1:${PORT}/json/list`);
  const waitFor = async (pred, timeout = 20_000) => {
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
    const target = await waitFor((t) => t.url.startsWith(url), 20_000);
    if (!target) throw new Error('target missing ' + url);
    const page = new CDP(target.webSocketDebuggerUrl);
    await page.ready;
    await page.send('Runtime.enable');
    await page.send('Page.enable');
    return page;
  };

  const options = await open(`chrome-extension://${extId}/options.html`);
  await sleep(1500);
  await options.eval(
    `chrome.runtime.sendMessage({type:'UPDATE_SETTINGS', patch:{enabled:true, engineMode:'local-only', sourceLanguage:'ja', cloudFallback:false, useFakeProvider:false, dailySoftLimit:null}})`,
  );
  await sleep(400);

  const status = async () =>
    JSON.parse(
      await options.eval(
        `chrome.runtime.sendMessage({type:'GET_MODEL_STATUS'}).then(r=>JSON.stringify(r))`,
      ),
    );

  const prepare = async (key) => {
    const before = await status();
    const label = key === 'detector' ? '语言检测' : key;
    result.notes.push(
      `${label} before: ${JSON.stringify(before.data?.pairs ?? before.data?.detector)}`,
    );
    await options.clickTestId(`prepare-${key}`);
    const deadline = Date.now() + 240_000;
    let last = null;
    while (Date.now() < deadline) {
      await sleep(2500);
      last = await status();
      if (!last.ok) continue;
      if (key === 'detector' && last.data.detector === 'available') {
        check(`prepare ${key}`, true, 'available');
        return;
      }
      const pair = last.data.pairs?.find((p) => p.source === key);
      if (pair?.state === 'available') {
        check(`prepare ${key}`, true, 'available');
        return;
      }
      const errorText = await options.eval(
        `document.querySelector('[data-testid="prepare-${key}"]')?.parentElement?.querySelector('.error-text')?.textContent ?? ''`,
      );
      if (errorText) {
        check(`prepare ${key}`, false, errorText);
        return;
      }
    }
    check(`prepare ${key}`, false, `timeout; last=${JSON.stringify(last)}`);
  };

  await prepare('ja');
  await prepare('en');
  await prepare('detector');

  const fixture = await open(`http://localhost:8787/index.html?local=${Date.now()}`);
  await sleep(2500);

  const select = async (selector) => {
    await fixture.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      const range = document.createRange(); range.selectNodeContents(el);
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, clientX: 40, clientY: 40 }));
    })()`);
  };
  const readPanel = () =>
    fixture
      .eval(
        `(() => {
      const root = document.querySelector('[data-huayi-host]')?.shadowRoot;
      return JSON.stringify({
        translation: root?.querySelector('.translation')?.textContent ?? '',
        engine: root?.querySelector('.engine')?.textContent ?? '',
        direction: root?.querySelector('.direction')?.textContent ?? '',
        error: root?.querySelector('.error p')?.textContent ?? '',
        cache: !!root?.querySelector('.cache-badge'),
        display: root ? getComputedStyle(root.querySelector('.huayi-container')).display : 'none',
      });
    })()`,
      )
      .then(JSON.parse);

  // Japanese, local-only, fixed source.
  await select('p:nth-of-type(2)');
  await sleep(1800);
  let panel = await readPanel();
  result.notes.push({ ja: panel });
  check(
    'local ja→zh',
    panel.translation.includes('日本') || panel.translation.includes('翻译'),
    panel.translation,
  );
  check(
    'local engine label',
    panel.engine.includes('本地') && panel.engine.includes('Chrome'),
    panel.engine,
  );

  // Cache hit on the same selection.
  await select('p:nth-of-type(2)');
  await sleep(1600);
  panel = await readPanel();
  check('cache hit badge', panel.cache === true, JSON.stringify(panel));

  // English, local-only, fixed source.
  await options.eval(
    `chrome.runtime.sendMessage({type:'UPDATE_SETTINGS', patch:{sourceLanguage:'en'}})`,
  );
  await sleep(300);
  await select('#para');
  await sleep(1800);
  panel = await readPanel();
  result.notes.push({ en: panel });
  check(
    'local en→zh',
    /[一-鿿]/.test(panel.translation) && !panel.translation.includes('[['),
    panel.translation,
  );

  // Auto detection.
  await options.eval(
    `chrome.runtime.sendMessage({type:'UPDATE_SETTINGS', patch:{sourceLanguage:'auto'}})`,
  );
  await sleep(300);
  await select('#para');
  await sleep(1800);
  panel = await readPanel();
  result.notes.push({ auto: panel });
  check('auto detection direction', panel.direction.includes('英语'), panel.direction);
  check(
    'local auto translates',
    panel.translation.length > 0 && /[一-鿿]/.test(panel.translation),
    panel.translation,
  );

  // Unpinned panel closes on scroll.
  await fixture.eval(`window.scrollTo(0, 300); window.dispatchEvent(new Event('scroll'));`);
  await sleep(400);
  panel = await readPanel();
  check('unpinned closes on scroll', panel.display === 'none', panel.display);
  await fixture.eval(`window.scrollTo(0, 0)`);

  // Insecure HTTP page (an origin that is not a secure context).
  // Set INSECURE_FIXTURE_URL to a non-localhost http:// address to run this check.
  const insecureUrl = process.env.INSECURE_FIXTURE_URL;
  if (insecureUrl) {
    const httpPage = await open(
      `${insecureUrl}${insecureUrl.includes('?') ? '&' : '?'}local=http`,
    );
    await sleep(3000);
    await httpPage.eval(`(() => {
      const el = document.querySelector('#para');
      const range = document.createRange(); range.selectNodeContents(el);
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, clientX: 40, clientY: 40 }));
    })()`);
    await sleep(2500);
    const httpPanel = await httpPage
      .eval(
        `(() => {
    const root = document.querySelector('[data-huayi-host]')?.shadowRoot;
    return JSON.stringify({ translation: root?.querySelector('.translation')?.textContent ?? '', engine: root?.querySelector('.engine')?.textContent ?? '', error: root?.querySelector('.error p')?.textContent ?? '' });
  })()`,
      )
      .then(JSON.parse);
    result.notes.push({ http: httpPanel });
    check(
      'local works on insecure HTTP page',
      httpPanel.translation.length > 0 && /[一-鿿]/.test(httpPanel.translation),
      JSON.stringify(httpPanel),
    );
  } else {
    result.notes.push('insecure HTTP page check skipped: set INSECURE_FIXTURE_URL');
  }

  result.errors.push(...options.errors, ...fixture.errors, ...httpPage.errors);
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
  await writeFile(OUT, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  setTimeout(() => process.exit(Object.values(result.checks).some((c) => !c.ok) ? 1 : 0), 500);
}
