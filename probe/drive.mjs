/**
 * Phase A probe driver. Uses CDP Extensions.loadUnpacked (Chrome 156 ignores --load-extension).
 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const EXT = path.join(ROOT, 'probe', 'local-ai');
const PROFILE = process.env.PROBE_PROFILE || '/tmp/fanyi-ext-probe-profile';
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.PROBE_PORT || 9227);
const FIXTURE_URL = process.env.PROBE_FIXTURE_URL || 'http://localhost:8787/index.html';
const OUT = process.env.PROBE_OUT || path.join(ROOT, 'probe', 'ext-result.json');
const SKIP_AI = process.env.PROBE_SKIP_AI === '1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, tries = 100) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch {}
    await sleep(200);
  }
  throw new Error(`timeout waiting for ${url}`);
}

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
      } else if (m.method === 'Runtime.consoleAPICalled') {
        const text = m.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
        if (text.startsWith('[probe]')) console.log(`[page] ${text.slice(0, 300)}`);
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
          rej(new Error('CDP timeout ' + method));
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
  async click(selector) {
    const rect = await this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({block:'center'});
      const r = el.getBoundingClientRect();
      return {x: r.x + r.width/2, y: r.y + r.height/2};
    })()`);
    if (!rect) throw new Error('selector missing ' + selector);
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

const result = { startedAt: new Date().toISOString(), steps: [], error: null };
const chrome = spawn(
  CHROME,
  [
    `--user-data-dir=${PROFILE}`,
    `--remote-debugging-port=${PORT}`,
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

let browser, page;
const waitUntil = async (predicate, timeoutMs, everyMs = 2000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await predicate();
    if (v) return v;
    await sleep(everyMs);
  }
  return null;
};

try {
  const version = await getJson(`http://127.0.0.1:${PORT}/json/version`);
  result.chromeVersion = version.Browser;
  browser = new CDP(version.webSocketDebuggerUrl);
  await browser.ready;
  const loaded = await browser.send('Extensions.loadUnpacked', { path: EXT });
  result.extId = loaded.id;
  result.steps.push('extension loaded via CDP');

  const created = await browser.send('Target.createTarget', {
    url: `chrome-extension://${loaded.id}/probe.html`,
  });
  result.probeTarget = created.targetId;
  const target = await waitUntil(async () => {
    const list = await getJson(`http://127.0.0.1:${PORT}/json/list`);
    return list.find((t) => t.url === `chrome-extension://${loaded.id}/probe.html`);
  }, 10_000);
  if (!target) throw new Error('probe page target missing');
  page = new CDP(target.webSocketDebuggerUrl);
  await page.ready;
  await page.send('Runtime.enable');
  result.steps.push('opened probe page');

  const read = async () => {
    const text = await page.eval(`document.getElementById('out')?.textContent ?? 'null'`);
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text };
    }
  };

  await sleep(3000);
  result.extensionInitial = await read();
  result.steps.push('initial availability in extension page');

  if (!SKIP_AI) {
    await page.click('#btn-en');
    result.steps.push('clicked en→zh prepare');
    await waitUntil(
      async () => {
        const r = await read();
        return r.own?.some((e) => e.name === 'translate_en_zh' || e.name === 'create_en_zh_error');
      },
      240_000,
      2500,
    );

    await page.click('#btn-ja');
    result.steps.push('clicked ja→zh prepare');
    await waitUntil(
      async () => {
        const r = await read();
        return r.own?.some((e) => e.name === 'translate_ja_zh' || e.name === 'create_ja_zh_error');
      },
      240_000,
      2500,
    );
  }

  result.extensionAfterPairs = await read();

  // Reload to see whether models are now available and whether create works without activation.
  await page.send('Page.reload');
  await sleep(2500);
  await page.click('#btn-nogesture');
  await sleep(9000);
  result.extensionNoGesture = await read();
  result.steps.push('tested create without user activation');

  await page.click('#btn-offscreen');
  result.steps.push('clicked offscreen probe');
  await sleep(15_000);
  result.extensionAfterOffscreen = await read();

  // Content-script probe on a real http page.
  await browser.send('Target.createTarget', { url: FIXTURE_URL });
  const fixtureTarget = await waitUntil(async () => {
    const list = await getJson(`http://127.0.0.1:${PORT}/json/list`);
    return list.find((t) => t.url.startsWith(FIXTURE_URL));
  }, 10_000);
  if (fixtureTarget) {
    const fp = new CDP(fixtureTarget.webSocketDebuggerUrl);
    await fp.ready;
    await fp.send('Runtime.enable');
    await fp.click('#para');
    result.steps.push('clicked fixture page for content-script probe');
    await sleep(9000);
    fp.close();
  } else {
    result.steps.push('fixture target missing (server running?)');
  }

  await page.click('#btn-refresh').catch(() => {});
  await sleep(1500);
  result.logs = JSON.parse(
    await page.eval(`chrome.storage.local.get(null).then(d => JSON.stringify(d))`),
  );
  result.steps.push('read aggregated logs');
} catch (e) {
  result.error = `${e?.name}: ${e?.message}`;
} finally {
  result.finishedAt = new Date().toISOString();
  try {
    await browser?.send('Browser.close');
  } catch {}
  page?.close();
  browser?.close();
  setTimeout(() => chrome.kill('SIGTERM'), 1000);
  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(result, null, 2));
  console.log('\nwrote', OUT, 'error:', result.error);
  setTimeout(() => process.exit(0), 300);
}
