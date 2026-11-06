import { test as base, chromium, type BrowserContext, type Page } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const FIXTURE_URL = 'http://localhost:8788/index.html';

export const test = base.extend<{ context: BrowserContext; extensionId: string }>({
  context: async ({}, use) => {
    const extensionPath = path.resolve(import.meta.dirname, '..', '..', 'dist-test');
    const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'huayi-e2e-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        '--enable-unsafe-extension-debugging',
        '--no-first-run',
        '--no-default-browser-check',
        '--window-size=1280,900',
      ],
    });
    await use(context);
    await context.close();
  },
  extensionId: async ({ context }, use) => {
    let worker = context.serviceWorkers()[0];
    if (!worker) {
      worker = await context.waitForEvent('serviceworker', { timeout: 20_000 });
    }
    await use(new URL(worker.url()).host);
  },
});

export { expect } from '@playwright/test';

export async function setSettings(
  context: BrowserContext,
  extensionId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  const response = await page.evaluate(
    (payload) => chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', patch: payload }),
    patch,
  );
  if (!response?.ok) throw new Error(`UPDATE_SETTINGS failed: ${JSON.stringify(response)}`);
  await page.close();
}

export async function clearCache(context: BrowserContext, extensionId: string): Promise<void> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await page.evaluate(() => chrome.runtime.sendMessage({ type: 'CLEAR_CACHE' }));
  await page.close();
}

export async function withOptionsPage<T>(
  context: BrowserContext,
  extensionId: string,
  fn: (page: Page) => Promise<T>,
): Promise<T> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  try {
    return await fn(page);
  } finally {
    await page.close();
  }
}

export async function selectWithMouse(page: Page, selector: string): Promise<void> {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`no box for ${selector}`);
  // Use the middle of the first line: multi-line paragraphs otherwise start
  // the drag in the gap between lines and select nothing.
  const y = box.y + Math.min(box.height / 2, 14);
  await page.mouse.move(box.x + 4, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 4, y, { steps: 8 });
  await page.mouse.up();
}

export async function selectByRange(page: Page, selector: string): Promise<void> {
  await page.evaluate((sel) => {
    const element = document.querySelector(sel);
    if (!element) throw new Error(`missing ${sel}`);
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(
      new PointerEvent('pointerup', { bubbles: true, button: 0, clientX: 20, clientY: 20 }),
    );
  }, selector);
}

export function enModelReady(status: unknown): boolean {
  const data = (status as { data?: { pairs?: Array<{ source: string; state: string }> } })?.data;
  return data?.pairs?.find((pair) => pair.source === 'en')?.state === 'available';
}

export function panel(page: Page) {
  return page.locator('.huayi-container');
}

export function translation(page: Page) {
  return page.locator('.translation');
}

export function engineBadge(page: Page) {
  return page.locator('.engine');
}

export function errorText(page: Page) {
  return page.locator('.error p').first();
}
