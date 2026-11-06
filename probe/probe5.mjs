import { spawn } from 'node:child_process';
import path from 'node:path';
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ROOT = path.resolve(import.meta.dirname, '..'),
  EXT = `${ROOT}/probe/local-ai`,
  PORT = 9231;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class CDP {
  constructor(u) {
    this.ws = new WebSocket(u);
    this.id = 0;
    this.p = new Map();
    this.ctx = [];
    this.evs = [];
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
      } else {
        this.evs.push(m.method);
        if (m.method === 'Runtime.executionContextCreated') this.ctx.push(m.params.context);
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
const out = { targets: [], logs: {}, permissions: null };
try {
  const v = await j(`http://127.0.0.1:${PORT}/json/version`);
  const b = new CDP(v.webSocketDebuggerUrl);
  await b.ready;
  const { id: extId } = await b.send('Extensions.loadUnpacked', { path: EXT });
  out.extId = extId;
  await sleep(1500);
  // probe page to read storage + permissions
  await b.send('Target.createTarget', { url: `chrome-extension://${extId}/probe.html` });
  await sleep(1500);
  let list = await j(`http://127.0.0.1:${PORT}/json/list`);
  const pt = list.find((t) => t.url === `chrome-extension://${extId}/probe.html`);
  const pp = new CDP(pt.webSocketDebuggerUrl);
  await pp.ready;
  await pp.send('Runtime.enable');
  await sleep(800);
  await pp.eval(`chrome.storage.local.clear()`);
  out.permissions = JSON.parse(
    await pp.eval(`chrome.permissions.getAll().then(p=>JSON.stringify(p))`),
  );
  for (const url of ['http://neverssl.com/', 'http://info.cern.ch/', 'http://example.com/']) {
    await b.send('Target.createTarget', { url });
    await sleep(5000);
    list = await j(`http://127.0.0.1:${PORT}/json/list`);
    const t = list.find((x) => x.url.startsWith(url));
    if (!t) {
      out.targets.push({ url, error: 'missing' });
      continue;
    }
    const page = new CDP(t.webSocketDebuggerUrl);
    await page.ready;
    await page.send('Runtime.enable');
    await sleep(2000);
    const facts = await page
      .eval(
        `JSON.stringify({href:location.href,secure:isSecureContext,hasTranslator:'Translator' in self})`,
      )
      .catch((e) => String(e));
    out.targets.push({
      url,
      actualUrl: t.url,
      title: t.title,
      contexts: page.ctx.map((c) => ({ name: c.name, origin: c.origin, type: c.auxData?.type })),
      mainWorld: facts,
    });
    page.ws.close();
    await sleep(1000);
  }
  const st = JSON.parse(await pp.eval(`chrome.storage.local.get(null).then(d=>JSON.stringify(d))`));
  out.logs = st.contentLog ?? [];
  pp.ws.close();
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
