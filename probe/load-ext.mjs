/**
 * Phase A: can Chrome load an unpacked extension over CDP?
 * Branded Chrome 156 ignores --load-extension, so try Extensions.loadUnpacked.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const PORT = 9226;
const EXT = path.resolve(import.meta.dirname, 'local-ai');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(
  CHROME,
  [
    '--user-data-dir=/tmp/fanyi-ext-cdp-profile',
    `--remote-debugging-port=${PORT}`,
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

await sleep(3000);
const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});
let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
};
const send = (method, params = {}) =>
  new Promise((r) => {
    const i = ++id;
    pending.set(i, r);
    ws.send(JSON.stringify({ id: i, method, params }));
  });

const res = await send('Extensions.loadUnpacked', { path: EXT });
console.log('loadUnpacked:', JSON.stringify(res));
await sleep(2000);
const targets = await send('Target.getTargets');
console.log(
  'targets:',
  JSON.stringify(
    targets.result?.targetInfos?.map((t) => ({ type: t.type, url: t.url })),
    null,
    2,
  ),
);
ws.close();
chrome.kill('SIGTERM');
setTimeout(() => process.exit(0), 500);
