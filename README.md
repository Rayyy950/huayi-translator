# 划译（huayi）

[![CI](https://github.com/Rayyy950/huayi-translator/actions/workflows/ci.yml/badge.svg)](https://github.com/Rayyy950/huayi-translator/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

划选网页文字，松开鼠标后在选区附近自动显示简体中文译文。首版面向个人自用，未上架 Chrome 商店。

- 目标语言：简体中文
- 已验证源语言：英语、日语
- 引擎：Chrome 内置翻译（本地，免费/离线）或腾讯云 TokenHub `hy-mt2-plus`（用户自带 API Key）
- 平台：Chrome Manifest V3，TypeScript + React + Vite，无自建服务器

## 状态

| 项目                   | 状态                                                      |
| ---------------------- | --------------------------------------------------------- |
| 构建 / 类型检查 / Lint | 通过                                                      |
| 单元测试               | 66/66 通过                                                |
| Playwright 端到端      | 20/20 通过                                                |
| 真实 Chrome 本地翻译   | 通过（含 Wikipedia、MDN、react.dev 与 HTTP 页面）         |
| 真实云端翻译           | **未验证**（无 TokenHub Key；只验证了域名与鉴权失败响应） |
| 人工质量评分           | 未完成                                                    |
| 国内/海外网络          | 仅本机网络；未分别实测                                    |

详见 [测试报告](docs/TEST-REPORT.md) 与 [可行性报告](docs/FEASIBILITY.md)。

## 快速开始

```bash
npm ci
npm run build
```

1. 打开 `chrome://extensions` → 开发者模式 → 加载已解压的扩展程序 → 选择 `dist/`。
2. 设置页：授权网站访问。
3. 本地使用：依次点击“准备英→中模型”“准备日→中模型”“准备语言检测”。
4. 云端使用：配置腾讯云 TokenHub 区域、API Key，测试连接。
5. 在网页中划选英文/日文，松开鼠标查看浮层。

完整步骤、权限与故障排查见 [INSTALL.md](docs/INSTALL.md)。

## 功能

- 划选后 250ms 防抖自动翻译，浮层加载/结果/错误状态
- 本地/云端引擎模式：本地优先、固定云端、本地仅用
- 云端回退默认关闭，开启后仅在本地失败时回退一次
- 同页最新请求优先；旧结果不覆盖新结果；双标签隔离
- 内存 + 会话缓存（200 条 / 2MB / 30 分钟），命中显示“缓存”
- 固定、复制、重试、关闭、Esc；Shadow DOM 隔离与深浅色
- 网站禁用列表、全局/当前站点开关、每日软限额、缓存清理
- API Key 隔离在扩展可信存储；Content Script 不接触 Key
- 测试构建提供确定性假 Provider；生产构建中移除

## 脚本

| 命令                 | 说明                                                          |
| -------------------- | ------------------------------------------------------------- |
| `npm run dev`        | 监听构建到 `dist/`（需在 `chrome://extensions` 手动重新加载） |
| `npm run build`      | 生产构建到 `dist/`                                            |
| `npm run build:test` | 测试构建到 `dist-test/`（假 Provider + 预授权）               |
| `npm run typecheck`  | `tsc --noEmit`                                                |
| `npm run lint`       | ESLint                                                        |
| `npm test`           | Vitest 单元测试                                               |
| `npm run test:e2e`   | 构建测试包并运行 Playwright                                   |
| `npm run package`    | 将 `dist/` 打包为 `release/huayi-v<version>.zip`              |
| `npm run icons`      | 重新生成图标                                                  |

## 目录

```text
src/background/   消息路由、本地/云端编排、缓存、内容脚本注册
src/content/      选区、浮层（React + Shadow DOM）、状态机
src/options/      设置、凭据、模型准备、权限、限额、缓存
src/popup/        工具栏弹窗
src/providers/    chrome-local、tokenhub、fake（仅测试）
src/shared/       类型、消息 schema、错误、语言、设置、存储、缓存、限流
tests/unit        Vitest
tests/e2e         Playwright
tests/fixtures    测试网页
probe/            阶段 A 与真实 Chrome 验证脚本（不进入发布包）
docs/             需求、可行性、架构、安装、引擎、测试、隐私
```

## 文档

- [PRD](docs/PRD.md)
- [可行性报告](docs/FEASIBILITY.md)
- [架构](docs/ARCHITECTURE.md)
- [安装与使用](docs/INSTALL.md)
- [翻译引擎](docs/PROVIDERS.md)
- [测试与性能](docs/TEST-REPORT.md)
- [隐私](docs/PRIVACY.md)

## 已知限制

- 只验证了 en/ja → 简体中文；目标语言首版固定。
- Chrome 内置翻译在 Service Worker 中可用属于 Chrome 156 的未文档化行为；不可用时会有明确提示，不影响云端路径。
- 云端 Provider 使用腾讯云 TokenHub，因为旧版机器翻译 `TextTranslate` 已退市（见 [FEASIBILITY.md](docs/FEASIBILITY.md)）。
- 仅顶层 frame；PDF、Canvas、封闭 Shadow DOM、Chrome 内部页面不支持。
- 真实云端质量与网络表现需要用户自己的 Key 与网络验证；仓库不含成功调用记录。
- 未购买服务、未公开发布、未创建账号。

## 贡献与安全

- [贡献指南](CONTRIBUTING.md)
- [安全策略](SECURITY.md)

## 许可

本项目使用 [Apache License 2.0](LICENSE)。Copyright 2026 The huayi-translator Authors。

你可以自由使用、修改和再发布，但需保留许可证与版权声明；Apache-2.0 同时包含专利授权与商标条款。
