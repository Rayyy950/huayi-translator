import { useEffect, useRef, useState, type JSX } from 'react';
import type { ErrorPayload, TranslateOutput } from '../../shared/types';

export interface PanelViewState {
  phase: 'loading' | 'done' | 'error';
  sourceLabel: string;
  targetLabel: string;
  engineLabel: string;
  providerKind: 'local' | 'cloud' | 'test' | 'unknown';
  fallback: boolean;
  pinned: boolean;
  result?: TranslateOutput;
  error?: ErrorPayload;
  cacheHit?: boolean;
  requestId?: string;
}

export interface PanelActions {
  onClose: () => void;
  onTogglePin: () => void;
  onCopy: (text: string) => Promise<boolean>;
  onRetry: () => void;
  onOpenOptions: () => void;
}

function Spinner(): JSX.Element {
  return <span className="spinner" aria-hidden="true" />;
}

function PinIcon({ pinned }: { pinned: boolean }): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path
        d="M9 3h6l-1 6 3 3v2H7v-2l3-3-1-6Zm3 11v7"
        fill={pinned ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function Panel({
  state,
  actions,
}: {
  state: PanelViewState;
  actions: PanelActions;
}): JSX.Element {
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    };
  }, []);

  const onCopy = async () => {
    if (!state.result) return;
    const ok = await actions.onCopy(state.result.translatedText);
    if (ok) {
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1500);
    }
  };

  const showSettings =
    state.error?.action === 'open-options' ||
    state.error?.action === 'prepare-model' ||
    state.error?.action === 'configure-cloud' ||
    state.error?.action === 'grant-access';
  const showRetry = state.phase === 'error' && state.error?.retryable === true;
  const retryDisabled = state.phase === 'loading';

  return (
    <div
      className="panel"
      role="dialog"
      aria-label="划译翻译结果"
      data-provider={state.providerKind}
      data-phase={state.phase}
    >
      <div className="header">
        <div className="meta">
          <span className="direction">
            {state.sourceLabel} → {state.targetLabel}
          </span>
          <span
            className="engine"
            title={state.fallback ? '本地失败后按授权回退到云端' : '实际使用的翻译引擎'}
          >
            {state.engineLabel}
            {state.fallback ? ' · 回退' : ''}
          </span>
        </div>
        <div className="header-actions">
          <button
            type="button"
            className="icon-button"
            aria-label={state.pinned ? '取消固定浮层' : '固定浮层'}
            aria-pressed={state.pinned}
            title={state.pinned ? '取消固定' : '固定浮层'}
            onClick={actions.onTogglePin}
          >
            <PinIcon pinned={state.pinned} />
          </button>
          <button
            type="button"
            className="icon-button close"
            aria-label="关闭浮层"
            title="关闭（Esc）"
            onClick={actions.onClose}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
              <path
                d="M6 6l12 12M18 6L6 18"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
      </div>

      <div className="body" aria-live="polite" aria-busy={state.phase === 'loading'}>
        {state.phase === 'loading' && (
          <p className="status">
            <Spinner /> 正在翻译…
          </p>
        )}
        {state.phase === 'error' && state.error && (
          <div className="error">
            <p>{state.error.message}</p>
            {state.error.diagnostic && <p className="diagnostic">诊断：{state.error.diagnostic}</p>}
          </div>
        )}
        {state.phase === 'done' && state.result && (
          <p className="translation">{state.result.translatedText}</p>
        )}
      </div>

      <div className="footer">
        <div className="footer-left">
          <button
            type="button"
            className="text-button"
            onClick={onCopy}
            disabled={!state.result}
            aria-label="复制译文"
          >
            {copied ? '已复制' : '复制'}
          </button>
          <button
            type="button"
            className="text-button"
            onClick={actions.onRetry}
            disabled={retryDisabled || (!showRetry && state.phase !== 'done')}
            aria-label="重新翻译"
          >
            重试
          </button>
        </div>
        <div className="footer-right">
          {state.cacheHit && <span className="cache-badge">缓存</span>}
          {showSettings && (
            <button type="button" className="text-button accent" onClick={actions.onOpenOptions}>
              打开设置
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
