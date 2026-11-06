# 探针与证据（开发用，不进入扩展包）

本目录保存阶段 A 的执行环境验证脚本，以及真实 Chrome 的端到端/性能/真实网页证据。它们**不会**被打进 `dist/` 或发布 zip。

## 环境变量

| 变量 | 用途 | 默认 |
| --- | --- | --- |
| `CHROME_PATH` | 桌面版 Chrome 可执行文件 | macOS: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` |
| `INSECURE_FIXTURE_URL` | 非安全上下文 HTTP fixture 地址（必须是局域网 IP/非 localhost），用于验证 HTTP 页面 | 未设置时跳过该项 |
| `PROBE_PROFILE` | Chrome 临时配置目录 | `/tmp/...` |

探针会打开真实 Chrome 窗口，并创建 `/tmp/huayi-*` 或 `/tmp/fanyi-*` 配置目录。

## 脚本

| 脚本 | 内容 |
| --- | --- |
| `plain-ai.mjs` | 普通页面中的内置翻译/语言检测 |
| `drive.mjs`、`probe2.mjs`、`probe3.mjs`、`probe4.mjs`、`probe5.mjs`、`probe6.mjs` | 扩展各执行位置、HTTP/HTTPS、重启、离线、离屏文档 |
| `local-ai/` | 阶段 A 探针扩展（不是产品扩展） |
| `fixture/` | 探针网页 |
| `smoke.mjs` | 测试构建的浮层/竞态/固定/关闭冒烟 |
| `local-e2e.mjs` | 真实 Chrome 本地翻译端到端（需要先准备模型） |
| `perf-local.mjs` | pointerup→浮层可见与缓存命中计时 |
| `real-pages.mjs` | Wikipedia / MDN / react.dev 真实网页 |
| `cache-restart.mjs` | 会话缓存跨重启与设置持久化 |
| `prod-load.mjs` | 生产 zip 解压后的加载与权限状态 |
| `load-ext.mjs` | CDP 加载探针扩展 |

结果 JSON：

- `plain-ai-result.json`、`ext-result.json`、`context-result.json`、`context2-result.json`、`context3-result.json`：阶段 A 原始观测。
- `quality-local.json`：40 条英/日样本的本地译文与耗时。
- `local-e2e-result.json`、`perf-local.json`、`real-pages.json`：真实 Chrome 验证。

结果中的本机绝对路径与局域网 IP 已替换为 `<repo>` / `<LAN-IP>`。

## 运行

```bash
# fixture（端口 8787）
cd probe/fixture && python3 -m http.server 8787
```

```bash
node probe/plain-ai.mjs
```

```bash
node probe/local-e2e.mjs
```

产品构建先运行 `npm run build:test`；测试构建包含测试 Provider 并预授权所有网站。
