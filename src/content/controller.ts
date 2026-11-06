import { AppError } from '../shared/errors';
import { countCodePoints, isHostDisabled, languageDisplayName } from '../shared/lang';
import type { PublicSettings } from '../shared/settings';
import type { ErrorPayload, TranslateOutput } from '../shared/types';
import { sendRuntimeMessage } from './messages-client';
import { PanelMount } from './panel/mount';
import type { PanelViewState } from './panel/Panel';
import { captureSelection, eventInsidePanel, type AnchorRect } from './selection';

const CLIENT_TIMEOUT_MS = 25_000;

interface Snapshot {
  text: string;
  rect: AnchorRect;
}

function providerKind(engineMode: PublicSettings['engineMode']): PanelViewState['providerKind'] {
  return engineMode === 'cloud-only' ? 'cloud' : 'local';
}

function pendingEngineLabel(settings: PublicSettings): string {
  if (settings.engineMode === 'cloud-only') return '云端 · 腾讯云 TokenHub';
  if (settings.localCapabilityNote) {
    return '本地不可用';
  }
  return '本地 · Chrome 内置翻译';
}

function resultEngineLabel(result: TranslateOutput): string {
  switch (result.actualProvider) {
    case 'chrome-local':
      return '本地 · Chrome 内置翻译';
    case 'tokenhub':
      return '云端 · 腾讯云 TokenHub';
    case 'fake':
      return '测试 Provider（仅测试构建）';
    default:
      return result.actualProvider;
  }
}

function resultProviderKind(result: TranslateOutput): PanelViewState['providerKind'] {
  if (result.actualProvider === 'chrome-local') return 'local';
  if (result.actualProvider === 'tokenhub') return 'cloud';
  return 'test';
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to execCommand for insecure pages.
  }
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.cssText =
      'position: fixed; left: -9999px; top: 0; width: 1px; height: 1px; opacity: 0; pointer-events: none;';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    textarea.remove();
    return ok;
  } catch {
    return false;
  }
}

export class ContentController {
  private settings: PublicSettings | null = null;
  private mount: PanelMount | null = null;
  private view: PanelViewState | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingSnapshot: Snapshot | null = null;
  private currentRequestId: string | null = null;
  private requestTimeout: ReturnType<typeof setTimeout> | null = null;
  private visible = false;
  private pinned = false;
  private readonly documentId =
    globalThis.crypto?.randomUUID?.() ?? `doc-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  private sequence = 0;
  private started = false;

  start(): void {
    if (this.started) return;
    this.started = true;
    this.mount = new PanelMount({
      onClose: () => this.hide(),
      onTogglePin: () => this.togglePin(),
      onCopy: (text) => copyText(text),
      onRetry: () => this.retry(),
      onOpenOptions: () => void sendRuntimeMessage({ type: 'OPEN_OPTIONS' }).catch(() => {}),
    });

    document.addEventListener('pointerup', this.onPointerUp, true);
    document.addEventListener('pointerdown', this.onPointerDown, true);
    document.addEventListener('selectionchange', this.onSelectionChange);
    document.addEventListener('keydown', this.onKeyDown, true);
    window.addEventListener('scroll', this.onScrollOrResize, { passive: true });
    window.addEventListener('resize', this.onScrollOrResize, { passive: true });
    window.addEventListener('pagehide', this.onPageHide);

    chrome.runtime.onMessage.addListener(this.onRuntimeMessage);
    void this.refreshSettings();
  }

  private refreshSettings = async (): Promise<void> => {
    try {
      const response = await sendRuntimeMessage<PublicSettings>({ type: 'GET_PUBLIC_SETTINGS' });
      if (response.ok) {
        this.settings = response.data;
        if (
          !response.data.enabled ||
          isHostDisabled(location.hostname, response.data.disabledHosts)
        ) {
          this.hide();
        }
      }
    } catch {
      // The extension may have been reloaded; content scripts then go stale.
    }
  };

  private onRuntimeMessage = (
    message: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void,
  ): boolean => {
    if (sender.id !== chrome.runtime.id) return false;
    if (
      message &&
      typeof message === 'object' &&
      (message as { type?: string }).type === 'SETTINGS_CHANGED'
    ) {
      void this.refreshSettings();
      return false;
    }
    if (
      message &&
      typeof message === 'object' &&
      (message as { type?: string }).type === 'GET_PAGE_STATE'
    ) {
      sendResponse({
        host: location.hostname,
        href: location.href,
        enabled: this.isSiteEnabled(),
        visible: this.visible,
        pinned: this.pinned,
      });
      return false;
    }
    return false;
  };

  private isSiteEnabled(): boolean {
    if (!this.settings) return true;
    if (this.settings.siteGranted === false) return false;
    return !isHostDisabled(location.hostname, this.settings.disabledHosts);
  }

  private onPointerUp = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    if (eventInsidePanel(event, this.mount?.host ?? null)) return;
    setTimeout(() => this.captureCandidate(), 0);
  };

  private onPointerDown = (event: PointerEvent): void => {
    if (!this.visible) return;
    if (eventInsidePanel(event, this.mount?.host ?? null)) return;
    if (!this.pinned) this.hide();
  };

  private onSelectionChange = (): void => {
    if (!this.pendingTimer || !this.pendingSnapshot) return;
    const captured = captureSelection(document, this.mount?.host ?? null);
    if (!captured.ok) return;
    if (captured.text === this.pendingSnapshot.text) return;
    this.pendingSnapshot = { text: captured.text, rect: captured.rect };
    this.schedulePending();
  };

  private onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && this.visible) {
      event.stopPropagation();
      this.hide();
    }
  };

  private onScrollOrResize = (): void => {
    if (!this.visible) return;
    if (this.pinned) {
      this.mount?.reposition();
    } else {
      this.hide();
    }
  };

  private onPageHide = (): void => {
    if (this.currentRequestId) {
      void sendRuntimeMessage({ type: 'CANCEL', requestId: this.currentRequestId }).catch(() => {});
    }
  };

  private captureCandidate(): void {
    if (!this.isSiteEnabled()) return;
    const captured = captureSelection(document, this.mount?.host ?? null);
    if (!captured.ok) return;
    this.pendingSnapshot = { text: captured.text, rect: captured.rect };
    this.schedulePending();
  }

  private schedulePending(): void {
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    const delay = this.settings?.debounceMs ?? 250;
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null;
      const snapshot = this.pendingSnapshot;
      this.pendingSnapshot = null;
      if (snapshot) void this.beginRequest(snapshot);
    }, delay);
  }

  private ensureSettings(): Promise<PublicSettings | null> {
    if (this.settings) return Promise.resolve(this.settings);
    return this.refreshSettings().then(() => this.settings);
  }

  private async beginRequest(snapshot: Snapshot): Promise<void> {
    const settings = await this.ensureSettings();
    if (!settings) return;
    if (!settings.enabled || !this.isSiteEnabled()) {
      this.hide();
      return;
    }
    if (countCodePoints(snapshot.text) > settings.maxChars) {
      this.showError(
        {
          code: 'TEXT_TOO_LONG',
          message: `选区超过 ${settings.maxChars} 个字符，请缩小选区后重试。`,
          retryable: false,
          action: 'reduce-selection',
        },
        settings,
        snapshot.rect,
      );
      return;
    }

    if (this.currentRequestId) this.cancelRequest(this.currentRequestId);
    const requestId = `${this.documentId}:${++this.sequence}`;
    this.currentRequestId = requestId;
    this.lastSourceText = snapshot.text;
    this.lastRect = snapshot.rect;
    if (!this.pinned) this.mount?.setAnchor(snapshot.rect);

    const view: PanelViewState = {
      phase: 'loading',
      sourceLabel:
        settings.sourceLanguage === 'auto' ? '自动' : languageDisplayName(settings.sourceLanguage),
      targetLabel: languageDisplayName(settings.targetLanguage),
      engineLabel: pendingEngineLabel(settings),
      providerKind: providerKind(settings.engineMode),
      fallback: false,
      pinned: this.pinned,
      requestId,
    };
    this.view = view;
    this.mount?.render(view);
    this.mount?.show();
    this.visible = true;

    if (this.requestTimeout) clearTimeout(this.requestTimeout);
    this.requestTimeout = setTimeout(() => {
      if (this.currentRequestId !== requestId) return;
      this.currentRequestId = null;
      this.cancelRequest(requestId);
      this.showError(
        {
          code: 'TIMEOUT',
          message: '翻译请求超时，请重试。',
          retryable: true,
        },
        settings,
        snapshot.rect,
        requestId,
      );
    }, CLIENT_TIMEOUT_MS);

    try {
      const response = await sendRuntimeMessage<TranslateOutput>({
        type: 'TRANSLATE',
        requestId,
        text: snapshot.text,
        source: settings.sourceLanguage,
        target: settings.targetLanguage,
      });
      if (this.currentRequestId !== requestId) return;
      if (this.requestTimeout) {
        clearTimeout(this.requestTimeout);
        this.requestTimeout = null;
      }
      if (response.ok) {
        const result = response.data;
        this.currentRequestId = null;
        const next: PanelViewState = {
          phase: 'done',
          sourceLabel: result.detectedSource
            ? languageDisplayName(result.detectedSource)
            : view.sourceLabel,
          targetLabel: view.targetLabel,
          engineLabel: resultEngineLabel(result),
          providerKind: resultProviderKind(result),
          fallback: result.fallback,
          pinned: this.pinned,
          result,
          cacheHit: result.cacheHit,
          requestId,
        };
        this.view = next;
        this.mount?.render(next);
        this.mount?.show();
      } else {
        // A cancel caused by a newer selection or a closed panel is stale here;
        // a cancel caused by a settings change still belongs to this request.
        if (this.currentRequestId !== requestId) return;
        this.currentRequestId = null;
        this.showError(response.error, settings, snapshot.rect, requestId);
      }
    } catch {
      if (this.currentRequestId !== requestId) return;
      this.currentRequestId = null;
      this.showError(
        new AppError('INTERNAL_ERROR', {
          message: '无法连接扩展后台，请刷新页面后重试。',
        }).toPayload(),
        settings,
        snapshot.rect,
        requestId,
      );
    }
  }

  private showError(
    error: ErrorPayload,
    settings: PublicSettings,
    rect: AnchorRect,
    requestId?: string,
  ): void {
    if (!this.pinned) this.mount?.setAnchor(rect);
    const view: PanelViewState = {
      phase: 'error',
      sourceLabel:
        settings.sourceLanguage === 'auto' ? '自动' : languageDisplayName(settings.sourceLanguage),
      targetLabel: languageDisplayName(settings.targetLanguage),
      engineLabel: pendingEngineLabel(settings),
      providerKind: providerKind(settings.engineMode),
      fallback: false,
      error,
      pinned: this.pinned,
      requestId,
    };
    this.view = view;
    this.mount?.render(view);
    this.mount?.show();
    this.visible = true;
  }

  private cancelRequest(requestId: string): void {
    void sendRuntimeMessage({ type: 'CANCEL', requestId }).catch(() => {});
  }

  private hide(): void {
    if (this.currentRequestId) {
      this.cancelRequest(this.currentRequestId);
      this.currentRequestId = null;
    }
    if (this.requestTimeout) {
      clearTimeout(this.requestTimeout);
      this.requestTimeout = null;
    }
    this.visible = false;
    this.pinned = false;
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = null;
    this.pendingSnapshot = null;
    this.mount?.unpin();
    this.mount?.hide();
  }

  private togglePin(): void {
    if (!this.mount) return;
    if (this.pinned) {
      this.pinned = false;
      this.mount.unpin();
    } else {
      this.pinned = true;
      this.mount.pinToCurrent();
    }
    if (this.view) {
      this.view = { ...this.view, pinned: this.pinned };
      this.mount.render(this.view);
    }
  }

  private retry(): void {
    const text = this.lastSourceText;
    const rect = this.lastRect;
    if (!text || !rect) return;
    void this.beginRequest({ text, rect });
  }

  private lastSourceText = '';
  private lastRect: AnchorRect | null = null;
}
