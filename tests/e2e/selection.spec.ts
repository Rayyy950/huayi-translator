import {
  clearCache,
  enModelReady,
  engineBadge,
  errorText,
  expect,
  FIXTURE_URL,
  panel,
  selectByRange,
  selectWithMouse,
  setSettings,
  test,
  translation,
  withOptionsPage,
} from './fixtures';

test.beforeEach(async ({ context, extensionId }) => {
  await setSettings(context, extensionId, {
    enabled: true,
    engineMode: 'cloud-only',
    cloudFallback: false,
    sourceLanguage: 'auto',
    targetLanguage: 'zh-Hans',
    debounceMs: 180,
    maxChars: 5000,
    dailySoftLimit: null,
    disabledHosts: [],
    useFakeProvider: true,
  });
  await clearCache(context, extensionId);
});

test('selecting text shows a translation, engine, and cache hit', async ({ context }) => {
  const page = await context.newPage();
  await page.goto(FIXTURE_URL);

  await selectWithMouse(page, '#para-en');
  await expect(translation(page)).toContainText('测试译文');
  await expect(translation(page)).toContainText('The quick brown fox');
  await expect(engineBadge(page)).toContainText('测试 Provider');
  await expect(page.locator('.direction')).toContainText('自动');

  // Collapse the previous selection before dragging again: starting a drag on
  // text that is already selected can begin a native text drag in Chromium.
  await page.mouse.click(5, 400);
  await selectWithMouse(page, '#para-en');
  await expect(page.locator('.cache-badge')).toBeVisible();
});

test('a slower earlier request never replaces the newest selection', async ({ context }) => {
  const page = await context.newPage();
  await page.goto(FIXTURE_URL);
  await page.evaluate(() => {
    const slow = document.createElement('p');
    slow.id = 'race-slow';
    slow.textContent = '[[slow]] The first slow request should never win.';
    const fast = document.createElement('p');
    fast.id = 'race-fast';
    fast.textContent = '[[fast]] The second fast request must win.';
    document.body.append(slow, fast);
  });

  await selectByRange(page, '#race-slow');
  await page.waitForTimeout(400);
  await selectByRange(page, '#race-fast');

  await expect(translation(page)).toContainText('second fast request');
  await page.waitForTimeout(2200);
  await expect(translation(page)).not.toContainText('first slow request');
});

test('two tabs translate independently', async ({ context }) => {
  const pageA = await context.newPage();
  const pageB = await context.newPage();
  await pageA.goto(FIXTURE_URL);
  await pageB.goto(FIXTURE_URL);

  await selectByRange(pageA, '#para-en');
  await selectByRange(pageB, '#para-ja');

  await expect(translation(pageA)).toContainText('The quick brown fox');
  await expect(translation(pageB)).toContainText('明日の会議');
  await expect(translation(pageA)).not.toContainText('明日の会議');
  await expect(translation(pageB)).not.toContainText('The quick brown fox');
});

test('pin survives scroll; Esc and outside click close', async ({ context }) => {
  const page = await context.newPage();
  await page.goto(FIXTURE_URL);
  await selectWithMouse(page, '#para-en');
  await expect(translation(page)).toBeVisible();

  await page.getByRole('button', { name: '固定浮层' }).click();
  await page.evaluate(() => window.scrollTo(0, 500));
  await page.waitForTimeout(300);
  await expect(panel(page)).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(panel(page)).toBeHidden();

  await selectWithMouse(page, '#para-en');
  await expect(panel(page)).toBeVisible();
  await page.mouse.click(5, 5);
  await expect(panel(page)).toBeHidden();
});

test('copy puts the translated text on the clipboard', async ({ context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: 'http://localhost:8788',
  });
  const page = await context.newPage();
  await page.goto(FIXTURE_URL);
  await selectWithMouse(page, '#para-en');
  await expect(translation(page)).toBeVisible();

  const expected = (await translation(page).textContent())?.trim() ?? '';
  await page.getByRole('button', { name: '复制译文' }).click();
  await expect(page.getByRole('button', { name: '复制译文' })).toHaveText('已复制');
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboard).toBe(expected);
});

test('editable areas and form controls never trigger translation', async ({ context }) => {
  const page = await context.newPage();
  await page.goto(FIXTURE_URL);

  await page.evaluate(() => {
    const editable = document.getElementById('editable');
    if (!editable) throw new Error('missing editable');
    const range = document.createRange();
    range.selectNodeContents(editable);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
  });
  await page.waitForTimeout(900);
  await expect(panel(page)).toBeHidden();

  await page.evaluate(() => {
    const textarea = document.getElementById('ta') as HTMLTextAreaElement | null;
    if (!textarea) throw new Error('missing textarea');
    textarea.focus();
    textarea.setSelectionRange(0, textarea.value.length);
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
  });
  await page.waitForTimeout(700);
  await expect(panel(page)).toBeHidden();
});

test('overlong selections show an error instead of truncating', async ({ context }) => {
  const page = await context.newPage();
  await page.goto(FIXTURE_URL);
  await page.evaluate(() => {
    const div = document.createElement('div');
    div.id = 'too-long';
    div.textContent = 'word '.repeat(1100);
    document.body.append(div);
  });
  await selectByRange(page, '#too-long');
  await expect(errorText(page)).toContainText('超过 5000');
  await expect(page.locator('.translation')).toHaveCount(0);
});

test('HTML-looking text is rendered as text and never executed', async ({ context }) => {
  const page = await context.newPage();
  await page.goto(FIXTURE_URL);
  await selectByRange(page, '#html-text');
  await expect(translation(page)).toContainText('<img src=x');
  expect(
    await page.evaluate(() => (window as unknown as Record<string, unknown>).__xss),
  ).toBeUndefined();
});

test('cloud-only without a key gives a configuration error', async ({ context, extensionId }) => {
  await setSettings(context, extensionId, { engineMode: 'cloud-only', useFakeProvider: false });
  await withOptionsPage(context, extensionId, async (page) => {
    await page.evaluate(() => chrome.runtime.sendMessage({ type: 'CLEAR_API_KEY' }));
  });
  const page = await context.newPage();
  await page.goto(FIXTURE_URL);
  await selectWithMouse(page, '#para-en');
  await expect(errorText(page)).toContainText('尚未配置腾讯云 TokenHub API Key');
  await expect(page.getByRole('button', { name: '打开设置' })).toBeVisible();
});

test('authorized local failure falls back to cloud once and says so', async ({
  context,
  extensionId,
}) => {
  const status = await withOptionsPage(context, extensionId, async (page) =>
    page.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_MODEL_STATUS' })),
  );
  test.skip(
    enModelReady(status),
    'Chromium in this test environment has the en→zh model downloaded',
  );

  await setSettings(context, extensionId, {
    engineMode: 'local-first',
    cloudFallback: true,
    sourceLanguage: 'en',
    useFakeProvider: true,
  });
  const page = await context.newPage();
  await page.goto(FIXTURE_URL);
  await selectWithMouse(page, '#para-en');
  await expect(translation(page)).toContainText('测试译文');
  await expect(engineBadge(page)).toContainText('回退');
});

test('local-only without a usable local engine never calls the cloud', async ({
  context,
  extensionId,
}) => {
  const status = await withOptionsPage(context, extensionId, async (page) =>
    page.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_MODEL_STATUS' })),
  );
  test.skip(
    enModelReady(status),
    'Chromium in this test environment has the en→zh model downloaded',
  );

  await setSettings(context, extensionId, {
    engineMode: 'local-only',
    cloudFallback: false,
    sourceLanguage: 'en',
    useFakeProvider: true,
  });
  const page = await context.newPage();
  await page.goto(FIXTURE_URL);
  await selectWithMouse(page, '#para-en');
  await expect(errorText(page)).toContainText(/本地翻译模型|未提供 Chrome 内置翻译/);
  await expect(page.locator('.translation')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '打开设置' })).toBeVisible();
});

test('auth failure is not retryable; network failure is', async ({ context }) => {
  const page = await context.newPage();
  await page.goto(FIXTURE_URL);
  await page.evaluate(() => {
    const auth = document.createElement('p');
    auth.id = 'auth-fail';
    auth.textContent = '[[fail-auth]] This request must fail authentication.';
    const net = document.createElement('p');
    net.id = 'net-fail';
    net.textContent = '[[fail-network]] This request must fail on the network.';
    document.body.append(auth, net);
  });

  await selectByRange(page, '#auth-fail');
  await expect(errorText(page)).toContainText('API Key 无效');
  await expect(page.getByRole('button', { name: '重新翻译' })).toBeDisabled();

  await selectByRange(page, '#net-fail');
  await expect(errorText(page)).toContainText('网络请求失败');
  await expect(page.getByRole('button', { name: '重新翻译' })).toBeEnabled();
});

test('changing settings mid-request invalidates the stale result', async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  await page.goto(FIXTURE_URL);
  await page.evaluate(() => {
    const slow = document.createElement('p');
    slow.id = 'settings-race';
    slow.textContent = '[[slow]] This request will finish after a settings change.';
    document.body.append(slow);
  });

  await selectByRange(page, '#settings-race');
  await page.waitForTimeout(700);
  await setSettings(context, extensionId, { sourceLanguage: 'en' });
  await expect(errorText(page)).toContainText('设置已更改', { timeout: 10_000 });
  await expect(page.locator('.translation')).toHaveCount(0);
});

test('disabled site does not read selections', async ({ context, extensionId }) => {
  await withOptionsPage(context, extensionId, async (page) => {
    await page.evaluate(() =>
      chrome.runtime.sendMessage({ type: 'SET_SITE_ENABLED', host: 'localhost', enabled: false }),
    );
  });
  const page = await context.newPage();
  await page.goto(FIXTURE_URL);
  await selectWithMouse(page, '#para-en');
  await page.waitForTimeout(1200);
  await expect(panel(page)).toBeHidden();
});

test('panel stays inside a narrow viewport', async ({ context }) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 360, height: 500 });
  await page.goto(FIXTURE_URL);
  await page.evaluate(() => document.getElementById('bottom')?.scrollIntoView());
  await page.waitForTimeout(300);
  await selectByRange(page, '#bottom');
  await expect(translation(page)).toBeVisible();
  const box = await panel(page).boundingBox();
  expect(box).not.toBeNull();
  if (box) {
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(360.5);
    expect(box.y + box.height).toBeLessThanOrEqual(500.5);
  }
});

test('popup renders and toggles the global switch', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(page.getByText('划译', { exact: true })).toBeVisible();
  await page.getByLabel('全局启用划译').click();
  await expect
    .poll(async () =>
      page.evaluate(() =>
        chrome.runtime
          .sendMessage({ type: 'GET_SETTINGS' })
          .then((response) => response.data.enabled),
      ),
    )
    .toBe(false);
});

test('service worker restart leaves settings and translation working', async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  await page.goto(FIXTURE_URL);
  const browser = context.browser();
  test.skip(!browser, 'no browser CDP session');
  const cdp = await browser!.newBrowserCDPSession();
  const { targetInfos } = (await cdp.send('Target.getTargets')) as {
    targetInfos: Array<{ type: string; url: string; targetId: string }>;
  };
  const worker = targetInfos.find(
    (target) =>
      target.type === 'service_worker' &&
      target.url.includes(extensionId) &&
      target.url.endsWith('background.js'),
  );
  test.skip(!worker, 'service worker target not found');
  await cdp.send('Target.closeTarget', { targetId: worker!.targetId });
  await cdp.detach();
  await page.waitForTimeout(500);

  await selectWithMouse(page, '#para-en');
  await expect(translation(page)).toContainText('测试译文');
});

test('multi-paragraph selections keep paragraph boundaries', async ({ context }) => {
  const page = await context.newPage();
  await page.goto(FIXTURE_URL);
  await page.evaluate(() => {
    const multi = document.getElementById('multi');
    if (!multi) throw new Error('missing multi');
    const range = document.createRange();
    range.setStartBefore(multi.firstElementChild!);
    range.setEndAfter(multi.lastElementChild!);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
  });
  await expect(translation(page)).toContainText('First paragraph');
  await expect(translation(page)).toContainText('Second paragraph');
  const raw = (await translation(page).textContent()) ?? '';
  expect(raw).toContain('\n\n');
});

test('selecting text inside the panel does not trigger a new translation', async ({ context }) => {
  const page = await context.newPage();
  await page.goto(FIXTURE_URL);
  await selectWithMouse(page, '#para-en');
  await expect(translation(page)).toBeVisible();
  const before = await translation(page).textContent();

  await page.evaluate(() => {
    const node = document
      .querySelector('[data-huayi-host]')
      ?.shadowRoot?.querySelector('.translation');
    if (!node) throw new Error('missing translation');
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
  });
  await page.waitForTimeout(900);
  await expect(translation(page)).toBeVisible();
  expect(await translation(page).textContent()).toBe(before);
  await expect(page.locator('.cache-badge')).toHaveCount(0);
});

test('no panel appears without a selection', async ({ context }) => {
  const page = await context.newPage();
  await page.goto(FIXTURE_URL);
  await page.waitForTimeout(1500);
  await expect(panel(page)).toBeHidden();
});
