import { useCallback, useEffect, useState } from 'react';
import { errorMessage, send } from '../ui/api';
import type { RuntimeState } from '../shared/state';
import type { JSX } from 'react';
import type { AvailabilityState } from '../shared/types';

type Banner = { kind: 'ok' | 'error' | 'info'; text: string };
type PrepKey = 'en' | 'ja' | 'detector';
type PrepState = {
  status: 'idle' | 'running' | 'done' | 'error';
  progress?: number;
  message?: string;
};

const PROVIDER_HOSTS = {
  guangzhou: {
    primary: 'tokenhub.tencentmaas.com',
    backup: 'tokenhub.tencentmaas.cn',
    label: '广州（中国大陆）',
  },
  singapore: {
    primary: 'tokenhub-intl.tencentmaas.com',
    backup: 'tokenhub-intl.tencentmaas.cn',
    label: '新加坡（全球）',
  },
} as const;

const AVAILABILITY_LABEL: Record<AvailabilityState | 'unsupported', string> = {
  available: '已准备',
  downloadable: '需要下载',
  downloading: '下载中',
  unavailable: '不可用',
  unsupported: '不支持',
};

function hostFromInput(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(/^[a-z]+:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`);
    return url.hostname || null;
  } catch {
    return null;
  }
}

export function Options(): JSX.Element {
  const [state, setState] = useState<RuntimeState | null>(null);
  const [banner, setBanner] = useState<Banner | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [keyInput, setKeyInput] = useState('');
  const [persistKey, setPersistKey] = useState(false);
  const [siteInput, setSiteInput] = useState('');
  const [disabledInput, setDisabledInput] = useState('');
  const [limitEnabled, setLimitEnabled] = useState(true);
  const [limitValue, setLimitValue] = useState(20000);
  const [prep, setPrep] = useState<Record<PrepKey, PrepState>>({
    en: { status: 'idle' },
    ja: { status: 'idle' },
    detector: { status: 'idle' },
  });
  const [cacheStats, setCacheStats] = useState<{ entries: number; bytes: number } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await send<RuntimeState>({ type: 'GET_STATE' });
      if (response.ok) {
        setState(response.data);
        const limit = response.data.settings.dailySoftLimit;
        setLimitEnabled(limit !== null && limit > 0);
        setLimitValue(limit ?? 0);
      } else {
        setBanner({ kind: 'error', text: response.error.message });
      }
    } catch (error) {
      setBanner({ kind: 'error', text: errorMessage(error) });
    }
  }, []);

  const refreshCache = useCallback(async () => {
    try {
      const response = await send<{ entries: number; bytes: number }>({ type: 'GET_CACHE_STATS' });
      if (response.ok) setCacheStats(response.data);
    } catch {
      // stats are informational
    }
  }, []);

  useEffect(() => {
    void refresh();
    void refreshCache();
  }, [refresh, refreshCache]);

  const update = async (patch: Record<string, unknown>, success?: string) => {
    setBusy('settings');
    try {
      const response = await send<RuntimeState['settings']>({ type: 'UPDATE_SETTINGS', patch });
      if (!response.ok) throw new Error(response.error.message);
      if (success) setBanner({ kind: 'ok', text: success });
      await refresh();
    } catch (error) {
      setBanner({ kind: 'error', text: errorMessage(error) });
    } finally {
      setBusy(null);
    }
  };

  const setPrepState = (key: PrepKey, patch: Partial<PrepState>) => {
    setPrep((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));
  };

  const prepare = async (key: PrepKey) => {
    if (!('Translator' in globalThis)) {
      setPrepState(key, { status: 'error', message: '此 Chrome 未提供内置翻译 API。' });
      return;
    }
    setPrepState(key, { status: 'running', progress: 0, message: undefined });
    try {
      if (key === 'detector') {
        if (!('LanguageDetector' in globalThis)) {
          throw new Error('此 Chrome 未提供语言检测 API。');
        }
        const detector = await LanguageDetector.create({
          monitor(monitor) {
            monitor.addEventListener('downloadprogress', (event) =>
              setPrepState('detector', { progress: event.loaded }),
            );
          },
        });
        detector.destroy?.();
      } else {
        const translator = await Translator.create({
          sourceLanguage: key,
          targetLanguage: 'zh-Hans',
          monitor(monitor) {
            monitor.addEventListener('downloadprogress', (event) =>
              setPrepState(key, { progress: event.loaded }),
            );
          },
        });
        translator.destroy?.();
      }
      setPrepState(key, { status: 'done', progress: 1 });
      setBanner({ kind: 'ok', text: '本地模型准备完成。' });
      await send({ type: 'MODEL_PREPARED' }).catch(() => {});
      await refresh();
    } catch (error) {
      const name = error instanceof Error ? error.name : 'Error';
      const message = error instanceof Error ? error.message : String(error);
      setPrepState(key, {
        status: 'error',
        message:
          name === 'NotAllowedError'
            ? '浏览器要求由按钮点击直接触发下载，请再点击一次按钮。'
            : `${name}: ${message}`,
      });
    }
  };

  const changeRegion = async (next: 'guangzhou' | 'singapore') => {
    const info = PROVIDER_HOSTS[next];
    let granted: boolean;
    try {
      granted = await chrome.permissions.request({
        origins: [`https://${info.primary}/*`, `https://${info.backup}/*`],
      });
    } catch {
      granted = false;
    }
    await update(
      { tokenhub: { region: next } },
      granted
        ? '区域已切换，请重新测试连接。'
        : '区域已切换，但未授予该区域域名访问权限，云端请求会失败。',
    );
  };

  const saveKey = async () => {
    if (!state) return;
    const key = keyInput.trim();
    if (!key) {
      setBanner({ kind: 'error', text: '请填写 API Key。' });
      return;
    }
    const region = state.settings.tokenhub.region;
    const hosts = PROVIDER_HOSTS[region];
    let granted: boolean;
    try {
      granted = await chrome.permissions.request({
        origins: [`https://${hosts.primary}/*`, `https://${hosts.backup}/*`],
      });
    } catch {
      granted = false;
    }
    setBusy('key');
    try {
      const response = await send({ type: 'SET_API_KEY', apiKey: key, persist: persistKey });
      if (!response.ok) throw new Error(response.error.message);
      setKeyInput('');
      setBanner({
        kind: granted ? 'ok' : 'info',
        text: granted
          ? 'API Key 已保存到本机扩展存储。请点击“测试连接”验证（可能消耗额度）。'
          : 'API Key 已保存，但未授予 TokenHub 域名访问权限，云端请求会失败。可在“网站访问”中检查。',
      });
      await refresh();
    } catch (error) {
      setBanner({ kind: 'error', text: errorMessage(error) });
    } finally {
      setBusy(null);
    }
  };

  const testConnection = async () => {
    setBusy('test');
    setBanner({ kind: 'info', text: '正在发送测试请求…' });
    try {
      const response = await send<{ text: string; elapsedMs: number }>({ type: 'TEST_PROVIDER' });
      if (!response.ok) throw new Error(response.error.message);
      setBanner({
        kind: 'ok',
        text: `连接成功（${response.data.elapsedMs}ms）：${response.data.text}`,
      });
      await refresh();
    } catch (error) {
      setBanner({ kind: 'error', text: errorMessage(error) });
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  const clearKey = async () => {
    setBusy('key');
    try {
      await send({ type: 'CLEAR_API_KEY' });
      setBanner({ kind: 'ok', text: '已删除本机保存的 API Key。' });
      await refresh();
    } catch (error) {
      setBanner({ kind: 'error', text: errorMessage(error) });
    } finally {
      setBusy(null);
    }
  };

  const grantAllSites = async () => {
    try {
      const granted = await chrome.permissions.request({
        origins: ['http://*/*', 'https://*/*'],
      });
      if (!granted) {
        setBanner({ kind: 'info', text: '未授予网站访问权限。' });
        return;
      }
      const response = await send<{ injected: number }>({ type: 'SYNC_CONTENT_SCRIPTS' });
      setBanner({
        kind: 'ok',
        text: response.ok
          ? `已授权所有普通网站，并向 ${response.data.injected} 个已打开页面注入。`
          : '已授权，但同步内容脚本失败。',
      });
      await refresh();
    } catch (error) {
      setBanner({ kind: 'error', text: errorMessage(error) });
    }
  };

  const grantSpecificSite = async () => {
    const host = hostFromInput(siteInput);
    if (!host) {
      setBanner({ kind: 'error', text: '网站格式无效，请输入域名，例如 example.com。' });
      return;
    }
    try {
      const granted = await chrome.permissions.request({
        origins: [`https://${host}/*`, `http://${host}/*`],
      });
      if (!granted) {
        setBanner({ kind: 'info', text: '未授予该网站访问权限。' });
        return;
      }
      await send({ type: 'SYNC_CONTENT_SCRIPTS' });
      setSiteInput('');
      setBanner({ kind: 'ok', text: `已授权 ${host}。刷新已打开的页面后生效。` });
      await refresh();
    } catch (error) {
      setBanner({ kind: 'error', text: errorMessage(error) });
    }
  };

  const revokeOrigin = async (origin: string) => {
    try {
      const removed = await chrome.permissions.remove({ origins: [origin] });
      if (!removed) {
        setBanner({
          kind: 'info',
          text: 'Chrome 未撤销该权限。若已授权“所有网站”，请先撤销全部授权。',
        });
        return;
      }
      await send({ type: 'SYNC_CONTENT_SCRIPTS' });
      setBanner({ kind: 'ok', text: `已撤销 ${origin}` });
      await refresh();
    } catch (error) {
      setBanner({ kind: 'error', text: errorMessage(error) });
    }
  };

  const addDisabledHost = async () => {
    const host = hostFromInput(disabledInput);
    if (!host) {
      setBanner({ kind: 'error', text: '网站格式无效。' });
      return;
    }
    try {
      const response = await send({ type: 'ADD_DISABLED_HOST', host });
      if (!response.ok) throw new Error(response.error.message);
      setDisabledInput('');
      setBanner({ kind: 'ok', text: `${host} 已加入禁用列表。` });
      await refresh();
    } catch (error) {
      setBanner({ kind: 'error', text: errorMessage(error) });
    }
  };

  const removeDisabledHost = async (host: string) => {
    try {
      await send({ type: 'REMOVE_DISABLED_HOST', host });
      await refresh();
    } catch (error) {
      setBanner({ kind: 'error', text: errorMessage(error) });
    }
  };

  const saveLimit = async () => {
    const limit = limitEnabled ? Math.max(1000, Math.floor(limitValue)) : null;
    await update(
      { dailySoftLimit: limit },
      limit === null ? '已关闭每日软限额。' : `每日软限额已设为 ${limit} 字符。`,
    );
  };

  const clearCache = async () => {
    try {
      await send({ type: 'CLEAR_CACHE' });
      setBanner({ kind: 'ok', text: '会话缓存已清理。' });
      await refreshCache();
    } catch (error) {
      setBanner({ kind: 'error', text: errorMessage(error) });
    }
  };

  if (!state) {
    return (
      <main className="page">
        <p className="muted">正在读取设置…</p>
        {banner && <div className={`banner ${banner.kind}`}>{banner.text}</div>}
      </main>
    );
  }

  const { settings, local, cloud, permission, usage } = state;
  const region = settings.tokenhub.region;
  const regionInfo = PROVIDER_HOSTS[region];
  const localReady = local.pairs.every((pair) => pair.state === 'available');

  return (
    <main className="page">
      <header className="page-header">
        <div>
          <h1>划译设置</h1>
          <p className="muted">划选网页文字，松开鼠标后自动在附近显示简体中文译文。</p>
        </div>
        <button type="button" className="ghost" onClick={() => void refresh()}>
          刷新状态
        </button>
      </header>

      {banner && (
        <div className={`banner ${banner.kind}`} role="status">
          {banner.text}
        </div>
      )}

      <section className="card">
        <h2>基本设置</h2>
        <div className="grid two">
          <label className="field">
            <span>启用划译</span>
            <input
              type="checkbox"
              checked={settings.enabled}
              onChange={(event) => void update({ enabled: event.target.checked })}
            />
          </label>
          <label className="field">
            <span>源语言</span>
            <select
              value={settings.sourceLanguage}
              onChange={(event) =>
                void update({ sourceLanguage: event.target.value as 'auto' | 'en' | 'ja' })
              }
            >
              <option value="auto">自动检测</option>
              <option value="en">英语</option>
              <option value="ja">日语</option>
            </select>
          </label>
          <label className="field">
            <span>目标语言</span>
            <select value={settings.targetLanguage} disabled>
              <option value="zh-Hans">简体中文（已验证）</option>
            </select>
          </label>
          <label className="field">
            <span>划选后等待</span>
            <select
              value={settings.debounceMs}
              onChange={(event) => void update({ debounceMs: Number(event.target.value) })}
            >
              <option value={180}>180ms</option>
              <option value={250}>250ms（默认）</option>
              <option value={400}>400ms</option>
            </select>
          </label>
        </div>
        <p className="muted small">
          首版只验证了“英语/日语 → 简体中文”这一语言方向，因此目标语言暂不可切换。
        </p>
      </section>

      <section className="card">
        <h2>翻译引擎</h2>
        <div className="radio-list" role="radiogroup" aria-label="引擎模式">
          {(
            [
              [
                'local-first',
                '本地优先',
                '优先使用 Chrome 内置翻译；本地不可用时按下方授权决定是否回退云端。',
              ],
              ['cloud-only', '固定云端', '始终使用腾讯云 TokenHub。文本会发送到所选区域的服务。'],
              ['local-only', '本地仅用', '绝不向云端发送文本。本地模型未准备时不会翻译。'],
            ] as const
          ).map(([value, label, description]) => (
            <label
              key={value}
              className={`radio ${settings.engineMode === value ? 'selected' : ''}`}
            >
              <input
                type="radio"
                name="engine-mode"
                value={value}
                checked={settings.engineMode === value}
                onChange={() =>
                  void update(
                    value === 'local-only'
                      ? { engineMode: value, cloudFallback: false }
                      : { engineMode: value },
                  )
                }
              />
              <span>
                <strong>{label}</strong>
                <small>{description}</small>
              </span>
            </label>
          ))}
        </div>

        <label className={`field inline ${settings.engineMode === 'local-only' ? 'disabled' : ''}`}>
          <input
            type="checkbox"
            checked={settings.cloudFallback}
            disabled={settings.engineMode === 'local-only'}
            onChange={(event) => void update({ cloudFallback: event.target.checked })}
          />
          <span>
            允许本地失败时回退到云端（默认关闭）
            <small>
              开启后，仅在本地不可用或失败时，把本次选中文本发送到腾讯云 TokenHub
              一次；不会自动切换到其他云端服务。
            </small>
          </span>
        </label>
      </section>

      <section className="card">
        <h2>本地翻译（Chrome 内置）</h2>
        <p className="muted small">
          本地翻译在扩展后台运行，不需要让设置页保持打开。模型由 Chrome
          下载并保存在当前浏览器配置中；每个语言对需要一次单独点击。 首次下载可能需要较长时间。
        </p>
        <div className="status-grid">
          <div>
            <span>Translator API</span>
            <strong>{local.supported ? '支持' : '不支持'}</strong>
          </div>
          <div>
            <span>语言检测</span>
            <strong>{AVAILABILITY_LABEL[local.detector]}</strong>
          </div>
          {local.pairs.map((pair) => (
            <div key={pair.source}>
              <span>{pair.source === 'en' ? '英语 → 简体中文' : '日语 → 简体中文'}</span>
              <strong>{AVAILABILITY_LABEL[pair.state]}</strong>
            </div>
          ))}
        </div>
        {!local.supported && (
          <p className="banner info">
            此 Chrome 未提供内置翻译 API。请使用桌面版 Chrome 138 或更高版本，或改用云端引擎。
          </p>
        )}
        <div className="buttons">
          {(['en', 'ja', 'detector'] as PrepKey[]).map((key) => {
            const item = prep[key];
            const label =
              key === 'en' ? '准备英→中模型' : key === 'ja' ? '准备日→中模型' : '准备语言检测';
            return (
              <div key={key} className="prep">
                <button
                  type="button"
                  data-testid={`prepare-${key}`}
                  disabled={item.status === 'running' || (key !== 'detector' && !local.supported)}
                  onClick={() => void prepare(key)}
                >
                  {item.status === 'running' ? '准备中…' : label}
                </button>
                {item.status === 'running' && (
                  <progress max={1} value={item.progress ?? 0}>
                    {(item.progress ?? 0) * 100}%
                  </progress>
                )}
                {item.status === 'done' && <span className="ok-text">已完成</span>}
                {item.status === 'error' && <span className="error-text">{item.message}</span>}
              </div>
            );
          })}
        </div>
        <p className="muted small">
          {localReady
            ? '两个语言方向的模型都已就绪，自动检测源语言也需要语言检测模型。'
            : '提示：“自动检测”需要语言检测模型；也可以在上方手动指定源语言。'}
        </p>
      </section>

      <section className="card" data-testid="cloud-card">
        <h2>云端翻译（腾讯云 TokenHub）</h2>
        <p className="muted small">
          使用官方 OpenAI 兼容接口，模型 <code>hy-mt2-plus</code>
          。文本会发送到所选区域的腾讯云服务；API Key 只保存在本机扩展存储中，页面脚本无法读取。
        </p>
        <div className="grid two">
          <label className="field">
            <span>区域</span>
            <select
              value={region}
              onChange={(event) =>
                void changeRegion(event.target.value as 'guangzhou' | 'singapore')
              }
            >
              {Object.entries(PROVIDER_HOSTS).map(([value, info]) => (
                <option key={value} value={value}>
                  {info.label}
                </option>
              ))}
            </select>
          </label>
          <div className="field">
            <span>端点</span>
            <code className="endpoint">https://{regionInfo.primary}/v1</code>
          </div>
        </div>

        <label className="field">
          <span>API Key</span>
          <input
            type="password"
            value={keyInput}
            autoComplete="off"
            spellCheck={false}
            placeholder={cloud.hasKey ? '已保存（输入新 Key 可替换）' : '粘贴 TokenHub API Key'}
            onChange={(event) => setKeyInput(event.target.value)}
          />
        </label>
        <label className="field inline">
          <input
            type="checkbox"
            checked={persistKey}
            onChange={(event) => setPersistKey(event.target.checked)}
          />
          <span>
            在本机长期保存
            <small>
              默认只保存在本次浏览器会话中；勾选后写入本机扩展存储，Chrome 重启后仍可用。
            </small>
          </span>
        </label>
        <div className="buttons">
          <button
            type="button"
            data-testid="save-key"
            onClick={() => void saveKey()}
            disabled={busy === 'key'}
          >
            保存 Key
          </button>
          <button
            type="button"
            data-testid="test-provider"
            onClick={() => void testConnection()}
            disabled={busy === 'test' || !cloud.hasKey}
          >
            {busy === 'test' ? '测试中…' : '测试连接'}
          </button>
          <button
            type="button"
            className="danger"
            onClick={() => void clearKey()}
            disabled={!cloud.hasKey || busy === 'key'}
          >
            删除 Key
          </button>
        </div>
        <p className="muted small">
          连接测试会发送一条很短的英文示例，可能消耗额度。费用、免费额度和模型开通状态以腾讯云控制台为准，本项目未做购买或额度保证。
        </p>
        <div className="status-grid">
          <div>
            <span>Key 状态</span>
            <strong>
              {cloud.hasKey ? (cloud.persist ? '已保存（长期）' : '已保存（本次会话）') : '未配置'}
            </strong>
          </div>
          <div>
            <span>最近测试</span>
            <strong>
              {cloud.lastTest
                ? `${cloud.lastTest.ok ? '成功' : '失败'} · ${new Date(cloud.lastTest.at).toLocaleString()}`
                : '未测试'}
            </strong>
          </div>
        </div>
        {cloud.lastTest?.message && (
          <p className={cloud.lastTest.ok ? 'muted small' : 'error-text small'}>
            最近测试：{cloud.lastTest.message}
          </p>
        )}
      </section>

      <section className="card">
        <h2>网站访问</h2>
        <p className="muted small">
          划译需要网站访问权限才能读取选区。授权后对已打开的页面注入一次脚本；未授权的站点不会运行。
          授予“所有网站”也会覆盖云端域名权限，这是 Chrome 权限模型的实际重叠，无法完全隔离。
        </p>
        <div className="buttons">
          <button type="button" data-testid="grant-all" onClick={() => void grantAllSites()}>
            授权所有 HTTP/HTTPS 网站
          </button>
        </div>
        <div className="inline-form">
          <input
            type="text"
            value={siteInput}
            placeholder="指定网站，例如 example.com"
            onChange={(event) => setSiteInput(event.target.value)}
          />
          <button type="button" onClick={() => void grantSpecificSite()}>
            授权指定网站
          </button>
        </div>
        <div className="status-grid">
          <div>
            <span>授权范围</span>
            <strong>
              {permission.allSites ? '所有网站' : `${permission.origins.length} 个具体来源`}
            </strong>
          </div>
        </div>
        {permission.origins.length > 0 && (
          <ul className="list">
            {permission.origins.map((origin) => (
              <li key={origin}>
                <code>{origin}</code>
                <button
                  type="button"
                  className="ghost small"
                  onClick={() => void revokeOrigin(origin)}
                >
                  撤销
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="muted small">
          Chrome 内部页面、扩展商店、内置 PDF 阅读器、Canvas 文本和封闭 Shadow DOM
          不保证支持，这是平台限制。
        </p>
      </section>

      <section className="card">
        <h2>禁用网站</h2>
        <p className="muted small">
          禁用列表中的网站不会读取选区，也不会发起翻译。支持具体域名与 <code>*.example.com</code>{' '}
          通配。 也可以在工具栏弹窗中切换当前网站。
        </p>
        <div className="inline-form">
          <input
            type="text"
            value={disabledInput}
            placeholder="example.com 或 *.example.com"
            onChange={(event) => setDisabledInput(event.target.value)}
          />
          <button type="button" onClick={() => void addDisabledHost()}>
            添加
          </button>
        </div>
        {settings.disabledHosts.length === 0 ? (
          <p className="muted small">暂无禁用网站。</p>
        ) : (
          <ul className="list">
            {settings.disabledHosts.map((host) => (
              <li key={host}>
                <code>{host}</code>
                <button
                  type="button"
                  className="ghost small"
                  onClick={() => void removeDisabledHost(host)}
                >
                  移除
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h2>用量与成本控制</h2>
        <p className="muted small">
          仅统计实际发往云端的字符（含分块与重试），缓存命中不计入。扩展统计只用于提示，不一定等于供应商账单。
        </p>
        <div className="status-grid">
          <div>
            <span>今日云端字符</span>
            <strong>{usage.chars.toLocaleString()}</strong>
          </div>
          <div>
            <span>今日请求 / 测试</span>
            <strong>
              {usage.requests} / {usage.tests}
            </strong>
          </div>
        </div>
        <label className="field inline">
          <input
            type="checkbox"
            checked={limitEnabled}
            onChange={(event) => setLimitEnabled(event.target.checked)}
          />
          <span>启用每日软限额（仅本地提示，不能替代供应商账单控制）</span>
        </label>
        <div className="inline-form">
          <input
            type="number"
            min={1000}
            step={1000}
            value={limitValue}
            disabled={!limitEnabled}
            onChange={(event) => setLimitValue(Number(event.target.value))}
          />
          <span className="muted">字符 / 日</span>
          <button type="button" onClick={() => void saveLimit()}>
            保存限额
          </button>
        </div>
      </section>

      <section className="card">
        <h2>缓存</h2>
        <p className="muted small">
          译文只保存在本次浏览器会话中（上限 200 条 / 2MB / 30
          分钟，按最近使用淘汰），关闭浏览器后不保留。
        </p>
        <div className="status-grid">
          <div>
            <span>缓存条数</span>
            <strong>{cacheStats?.entries ?? 0}</strong>
          </div>
          <div>
            <span>占用</span>
            <strong>{Math.round((cacheStats?.bytes ?? 0) / 1024)} KB</strong>
          </div>
        </div>
        <div className="buttons">
          <button
            type="button"
            data-testid="clear-cache"
            className="danger"
            onClick={() => void clearCache()}
          >
            清理缓存
          </button>
        </div>
      </section>

      <section className="card">
        <h2>隐私说明</h2>
        <ul className="bullets">
          <li>本地模式不发送网络翻译请求；模型由 Chrome 在首次准备时下载。</li>
          <li>云端模式仅发送当前选中的文本；不会抓取整页，也不会记录翻译历史。</li>
          <li>API Key 保存在扩展可信存储中，页面脚本和内容脚本无法读取；不记录到日志或导出。</li>
          <li>扩展不上传分析数据，不包含远程脚本或 eval，所有运行时代码随扩展打包。</li>
        </ul>
      </section>

      <footer className="page-footer muted small">
        划译 {chrome.runtime.getManifest().version} · 本地引擎与云端引擎的实际状态以上方检测为准。
      </footer>
    </main>
  );
}
