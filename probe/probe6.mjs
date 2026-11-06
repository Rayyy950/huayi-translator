import { spawn } from 'node:child_process';
import path from 'node:path';
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ROOT = path.resolve(import.meta.dirname, '..'),
  EXT = `${ROOT}/probe/local-ai`,
  PORT = 9232;
const URL = process.env.INSECURE_FIXTURE_URL;
if (!URL) {
  console.error('Set INSECURE_FIXTURE_URL to a non-localhost http:// fixture URL.');
  process.exit(1);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class CDP {
  constructor(u) {
    this.ws = new WebSocket(u);
    this.id = 0;
    this.p = new Map();
    this.ctx = [];
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
      } else if (m.method === 'Runtime.executionContextCreated') this.ctx.push(m.params.context);
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
          rej(new Error('timeout ' + method));
        }
      }, 60000);
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
async function j(u) {
  for (let i = 0; i < 50; i++) {
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
    `--user-data-dir=/tmp/fanyi-ext-probe-profile`,
    `--remote-debugging-port=${PORT}`,
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ],
  { stdio: 'ignore' },
);
const out = {};
try {
  const v = await j(`http://127.0.0.1:${PORT}/json/version`);
  const b = new CDP(v.webSocketDebuggerUrl);
  await b.ready;
  const { id: extId } = await b.send('Extensions.loadUnpacked', { path: EXT });
  await sleep(1000);
  await b.send('Target.createTarget', { url: `chrome-extension://${extId}/probe.html` });
  await sleep(1200);
  let list = await j(`http://127.0.0.1:${PORT}/json/list`);
  const pt = list.find((t) => t.url === `chrome-extension://${extId}/probe.html`);
  const pp = new CDP(pt.webSocketDebuggerUrl);
  await pp.ready;
  await pp.send('Runtime.enable');
  await pp.eval(`chrome.storage.local.clear()`);
  await b.send('Target.createTarget', { url: URL });
  await sleep(4000);
  list = await j(`http://127.0.0.1:${PORT}/json/list`);
  const t = list.find((x) => x.url.startsWith(URL));
  out.target = { url: t?.url, title: t?.title };
  const page = new CDP(t.webSocketDebuggerUrl);
  await page.ready;
  await page.send('Runtime.enable');
  await sleep(1500);
  out.contexts = page.ctx.map((c) => ({ name: c.name, origin: c.origin, type: c.auxData?.type }));
  const iso = page.ctx.find((c) => c.auxData?.type === 'isolated');
  if (iso) {
    out.isolated = await page.eval(
      `(async () => ({
      href: location.href, protocol: location.protocol, secureContext: self.isSecureContext,
      hasTranslator: 'Translator' in self, hasDetector: 'LanguageDetector' in self,
      availability_en_zh: 'Translator' in self ? await Translator.availability({sourceLanguage:'en',targetLanguage:'zh'}).catch(e=>'ERR '+e.name) : null,
    }))()`,
      iso.id,
    );
    // click to give activation; the probe content script should attempt create+translate
    await page.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: 20,
      y: 20,
      button: 'left',
      clickCount: 1,
    });
    await page.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: 20,
      y: 20,
      button: 'left',
      clickCount: 1,
    });
    await sleep(4000);
  }
  out.storage = JSON.parse(
    await pp.eval(`chrome.storage.local.get(null).then(d=>JSON.stringify(d))`),
  );
  pp.ws.close();
  page.ws.close();
} catch (e) {
  out.error = String(e);
} finally {
  try {
    const v = await j(`http://127.0.0.1:${PORT}/json/version`);
    const bb = new CDP(v.webSocketDebuggerUrl);
    await bb.ready;
    await bb.send('Browser.close');
  } catch {}
  chrome.kill('SIGTERM');
  console.log(JSON.stringify(out, null, 2));
  setTimeout(() => process.exit(0), 400);
}
