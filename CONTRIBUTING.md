# 贡献指南（CONTRIBUTING）

## 开发环境

- Node.js 22（或 20.19+）
- 桌面版 Chrome 138+
- npm（提交 `package-lock.json`，不要删除）

```bash
npm ci
npm run typecheck
npm run lint
npm test
npm run build
```

加载 `dist/` 到 `chrome://extensions` 进行手动验证。

## 测试

- 单元测试：`npm test`（Vitest）
- 浏览器端到端：`npm run test:e2e`（会先生成 `dist-test/`，使用测试 Provider，不访问真实云端）
- 真实 Chrome 本地引擎：`probe/local-e2e.mjs`（需要先准备模型；不是 CI 必需）

提交前请至少运行 `typecheck`、`lint`、`test`、`build`。CI 不运行 Playwright（需要扩展和浏览器环境），请本地执行。

## 提交内容

- 不要提交 API Key、`.env`、个人网页内容或 `dist/`、`dist-test/`、`release/` 产物。
- 测试使用 `dist-test` 的假 Provider；不要把假翻译接入生产路径。
- 改动云端 Provider 时，同步更新 `docs/PROVIDERS.md`、缓存 key 中的 `model/region/promptVersion` 和测试。
- 修改权限、存储或消息协议时，同步更新 `docs/ARCHITECTURE.md` 与 `docs/PRIVACY.md`。

## Pull Request

请说明：

1. 改动目的与用户可见行为；
2. 执行过的命令和结果；
3. 是否涉及权限、凭据、网络请求或缓存；
4. 未验证的部分。

## 安全

请不要在公开 issue 中粘贴密钥、完整网页内容或可识别个人的信息。安全相关问题见 [SECURITY.md](SECURITY.md)。
