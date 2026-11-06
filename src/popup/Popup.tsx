import { useCallback, useEffect, useState, type JSX } from 'react';
import { errorMessage, send } from '../ui/api';
import type { RuntimeState } from '../shared/state';

interface PageState {
  host: string;
  href: string;
  enabled: boolean;
  visible: boolean;
  pinned: boolean;
}

function engineModeLabel(mode: RuntimeState['settings']['engineMode']): string {
  if (mode === 'cloud-only') return '固定云端';
  if (mode === 'local-only') return '本地仅用';
  return '本地优先';
}

function localSummary(state: RuntimeState): string {
  if (!state.local.supported) return '不可用';
  const ready = state.local.pairs.filter((pair) => pair.state === 'available').length;
  if (ready === state.local.pairs.length) return '已准备（英/日）';
  if (ready > 0) return `部分准备（${ready}/${state.local.pairs.length}）`;
  return '未准备模型';
}

export function Popup(): JSX.Element {
  const [state, setState] = useState<RuntimeState | null>(null);
  const [page, setPage] = useState<PageState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const response = await send<RuntimeState>({ type: 'GET_STATE' });
      if (response.ok) setState(response.data);
      else setError(response.error.message);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  const refreshPage = useCallback(async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return;
      const response = (await chrome.tabs.sendMessage(tab.id, { type: 'GET_PAGE_STATE' })) as
        PageState | undefined;
      if (response) setPage(response);
      else setPage(null);
    } catch {
      setPage(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
    void refreshPage();
  }, [refresh, refreshPage]);

  const setGlobal = async (enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const response = await send({ type: 'UPDATE_SETTINGS', patch: { enabled } });
      if (!response.ok) throw new Error(response.error.message);
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const setSite = async (enabled: boolean) => {
    if (!page) return;
    setBusy(true);
    setError(null);
    try {
      const response = await send({ type: 'SET_SITE_ENABLED', host: page.host, enabled });
      if (!response.ok) throw new Error(response.error.message);
      setPage({ ...page, enabled });
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="popup">
      <header>
        <div className="brand">划译</div>
        <div className="brand-sub">划选即译 · 英 / 日 → 简体中文</div>
      </header>

      {error && <p className="error">{error}</p>}

      {state && (
        <>
          <div className="row">
            <div>
              <div className="row-title">启用划译</div>
              <div className="row-sub">全局开关</div>
            </div>
            <label className="switch">
              <input
                type="checkbox"
                checked={state.settings.enabled}
                disabled={busy}
                onChange={(event) => void setGlobal(event.target.checked)}
                aria-label="全局启用划译"
              />
              <span />
            </label>
          </div>

          <div className="row">
            <div>
              <div className="row-title">当前网站</div>
              <div className="row-sub">
                {page ? (
                  <>
                    {page.host}
                    {!page.enabled && ' · 已禁用'}
                  </>
                ) : (
                  '未授权或受限页面'
                )}
              </div>
            </div>
            <label className="switch">
              <input
                type="checkbox"
                checked={page?.enabled ?? false}
                disabled={!page || busy || !state.settings.enabled}
                onChange={(event) => void setSite(event.target.checked)}
                aria-label="在当前网站启用划译"
              />
              <span />
            </label>
          </div>

          <dl className="stats">
            <div>
              <dt>引擎模式</dt>
              <dd>{engineModeLabel(state.settings.engineMode)}</dd>
            </div>
            <div>
              <dt>本地模型</dt>
              <dd>{localSummary(state)}</dd>
            </div>
            <div>
              <dt>云端 Key</dt>
              <dd>{state.cloud.hasKey ? '已配置' : '未配置'}</dd>
            </div>
          </dl>

          {!state.settings.enabled && <p className="hint">划译已全局关闭，划选不会触发翻译。</p>}
          {!page && (
            <p className="hint">
              此页面没有运行划译。首次使用需要在设置页授权网站访问；Chrome
              内部页面和扩展商店无法划译。
            </p>
          )}
        </>
      )}

      <div className="footer">
        <button type="button" className="primary" onClick={() => chrome.runtime.openOptionsPage()}>
          打开设置
        </button>
      </div>
    </div>
  );
}
