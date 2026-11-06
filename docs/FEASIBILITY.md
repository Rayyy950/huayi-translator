# 阶段 A 可行性报告（FEASIBILITY）

- 核查日期：2026-11-06（Asia/Shanghai）
- 执行环境：macOS 26.2 (build 25C56)、Google Chrome 156.0.8078.80（正式版，非 Chromium）、Node.js v22.22.2、npm 10.9.7
- 探针代码：`probe/`（仅用于验证，不进入发布包）
- 原始结果：`probe/plain-ai-result.json`、`probe/ext-result.json`、`probe/context-result.json`、`probe/context2-result.json`、`probe/context3-result.json`、`probe/quality-local.json`
- 本报告只记录实际观测。未能执行的项目在“未验证项”中明确列出，没有以推断代替测试。

## 0. 结论摘要

1. **Chrome 内置翻译在本机可用。** en→zh、ja→zh 的模型可下载、可翻译，热启动单句约 2～30ms。执行位置实测结论：
   - **MV3 Service Worker 可用（实测）**，尽管 Chrome 官方文档写明 Translator API 不在 Web Worker 中提供；这是 Chrome 156 的未文档化行为，可能在未来版本变化，代码需做能力检测与明确降级。
   - 扩展选项页可用（需要用户点击才能触发首次下载）。
   - 隔离世界 Content Script 在 HTTPS / localhost 可用；**在非安全上下文 HTTP 页面不可用**（`Translator` 未定义）。
   - Offscreen 文档在测试开关下可用，但 **没有与实际用途相符的 offscreen reason**，不作为产品方案。
2. **腾讯云旧“文本翻译（TextTranslate / TextTranslateBatch）”已进入退市流程，且文档接口已于 2026 年被删除**，不适合作为新用户的首版云端依赖。腾讯官方给出的迁移目标是 **TokenHub 的 `hy-mt2-*` 翻译模型**。
3. **首版云端 Provider 选择腾讯云 TokenHub `hy-mt2-plus`**（OpenAI Chat Completions 兼容、API Key 鉴权、广州/新加坡双区域）。**没有测试凭据，因此云端真实翻译请求未验证**；只验证了域名可达、路径存在、鉴权失败返回格式。
4. **默认引擎：本地优先（local-first）**。这是基于本地实测可用、延迟低、无需付费的决定，不代表已证明本地译文比云端更准确——本阶段没有云端质量数据可比较。
5. 本地模型首次准备需要用户手势；准备完成后，Service Worker 中无需手势即可创建实例。模型按 Chrome 用户配置持久化，重启后仍为 `available`，断网热启动仍可翻译。

## 1. 本地 AI 实测

### 1.1 测试方法

- 使用真实桌面 Chrome（`/Applications/Google Chrome.app`），独立临时用户配置目录，通过 CDP `--remote-debugging-port` 驱动。
- Chrome 156 已不支持 `--load-extension`（本机实测加载失败，扩展页返回 `chrome-error://chromewebdata/`）。改用 **CDP `Extensions.loadUnpacked` + `--enable-unsafe-extension-debugging`** 加载探针扩展，仅用于测试。
- 用户手势通过 CDP `Input.dispatchMouseEvent` 发送真实鼠标按下/释放，不是 `element.click()` 合成事件。
- 探针扩展：`probe/local-ai/`，包含选项页、Service Worker、离屏文档、Content Script 四个执行位置。
- 每个结论至少在两轮独立启动中复现（`probe3.mjs` 连续两次启动）。

### 1.2 各执行位置结果

| 执行位置                             | 暴露 `Translator` / `LanguageDetector` | `availability('en','zh')`           | 创建（模型已就绪） | 实际译文                        | 备注                                                                            |
| ------------------------------------ | -------------------------------------- | ----------------------------------- | ------------------ | ------------------------------- | ------------------------------------------------------------------------------- |
| 扩展选项页（`chrome-extension://`）  | 是 / 是                                | `downloadable` → 下载后 `available` | 73ms（无手势）     | “没有使用手势。”                | 首次下载必须点击按钮                                                            |
| Service Worker                       | 是 / 是                                | `available`（准备后）               | 68～74ms           | “今天天气很好。” / “请关上门。” | 官方文档称 Worker 不可用，实测 Chrome 156 可用                                  |
| Content Script（HTTPS）              | 是 / 是                                | `available`                         | 83～93ms           | “最近的车站在哪里?”             | 隔离世界，正常                                                                  |
| Content Script（HTTP 非安全上下文）  | **否 / 否**                            | —                                   | —                  | —                               | `self.isSecureContext === false`，API 未暴露                                    |
| Content Script（`http://localhost`） | 是 / 是                                | `available`                         | 85ms               | “最近的车站在哪里?”             | localhost 属于安全上下文                                                        |
| Offscreen 文档（仅测试开关）         | 是 / 是                                | `available`                         | 65ms               | “你好，来自屏幕外的文档。”      | 需要 `--offscreen-document-testing` + `TESTING` reason；无生产可用的合法 reason |

补充观测：

- Service Worker 中 `typeof document === 'undefined'`，但 `Translator.create()` 与 `translate()` 正常。
- Service Worker 热启动第二次翻译耗时 2ms；首次创建 68～74ms。
- Service Worker 在 `Network.emulateNetworkConditions({offline:true})` 下仍能创建并翻译（70～73ms），说明模型完全本地。
- 关闭 Chrome、重新启动、重新加载扩展后，`availability` 仍为 `available`，创建 68ms，说明模型按用户配置持久化。
- Chrome 重启后扩展不会由 CDP 自动重新加载（CDP 加载不是持久安装）；重载扩展后模型状态保留。正常安装的扩展不受此影响。
- 英文/日文语言检测置信度约 0.998；模型可用后检测无需手势。

### 1.3 首次模型下载与用户手势

在全新 Chrome 用户配置中：

- `Translator.availability({sourceLanguage:'en', targetLanguage:'zh'})` 返回 `downloadable`。
- 无手势直接 `Translator.create()`：`NotAllowedError: Requires a user gesture when availability is "downloading" or "downloadable".`
- 在真实点击处理器内创建：开始下载，`downloadprogress` 事件从 0 到 1；en→zh 约 8.5 秒完成（本机网络），ja→zh 约 4.6 秒。
- 下载完成后再次创建无需手势；页面重新加载后仍为 `available`。
- 同一手势不能连续用于两个语言对的下载：先创建 en→zh 后立刻创建 ja→zh 会再次触发 `NotAllowedError`。因此准备页必须为每个语言对提供独立点击。
- `Translator.create()` 的 `monitor` 能收到真实下载进度，可用于 UI 展示；失败时 `ready` 拒绝。

### 1.4 边界与风险

- **官方文档与实测不一致**：Translator 文档写明“不在 Web Worker 中提供”，但 Chrome 156 的 MV3 Service Worker 实际可用。实现采用 Service Worker 作为本地执行位置，但必须：
  - 启动时做能力检测（`'Translator' in self` + `availability`）；
  - 失败时返回 `UNSUPPORTED` / `MODEL_NOT_READY`，UI 明确说明；
  - 不把该行为写成长期兼容承诺。
- **HTTP 页面**：Content Script 中不可用；Service Worker 可用且与页面安全上下文无关，因此本地模式可以覆盖 HTTP 页面。
- **模型下载依赖 Chrome 组件更新服务**：本机可下载，但未验证中国大陆受限网络、企业代理和海外网络。下载失败必须可恢复并提示。
- **模型列表不是无限**：只验证了 en→zh、ja→zh、en→zh-Hans、ja→zh-Hans；未验证其他语言对，不应在 UI 宣称。
- **串行**：翻译按顺序处理；长文本会阻塞后续请求。实现中需要“只保留最新待执行任务 + 丢弃旧结果”。

### 1.5 本地译文样本（未人工评分）

完整 40 条见 `probe/quality-local.json`（20 条英文、20 条日文，覆盖单词、句子、多段、术语、否定、数字单位、主语省略、同形汉字、长修饰）。以下为代表性结果：

| 源文                                                               | 本地译文                                                   | 观察                                     |
| ------------------------------------------------------------------ | ---------------------------------------------------------- | ---------------------------------------- |
| The bank approved the loan after reviewing the documents.          | 银行在审核文件后批准了贷款。                               | 准确                                     |
| A bank of clouds gathered over the river bank before the storm.    | 暴风雨来临前，一堆云层聚集在河岸上。                       | 词义正确，措辞稍生硬                     |
| She did not agree that the report was complete.                    | 她不同意该报告是完整的。                                   | 否定正确                                 |
| The device measures 12.5 centimeters and weighs 380 grams.         | 该设备尺寸为 12.5 厘米，重量为 380 克。                    | 数字单位正确                             |
| No later than 5 p.m. on March 3, 2027, submit the signed contract. | 不迟于下午 5 点。 2027 年 3 月 3 日，提交签署的合同。      | 日期标点被拆句，需改写                   |
| Bitcoin fell 8% on Tuesday, while gold rose slightly.              | 比特币周二下跌 8%，而黄金小幅上涨。                        | 准确                                     |
| 東京と大阪を結ぶ新幹線は、1時間に最大12本運行されている。          | 连接东京和大阪的子弹头列车每小时最多运行 12 列子弹头列车。 | 重复表达，术语未用“新干线”               |
| 人生には、どうしても避けられない別れがある。                       | 生活中有一个不可避免的告别。                               | 意义基本正确，语气损失                   |
| 木漏れ日                                                           | 阳光透过树木                                               | 词义接近，未译为固定说法“树影斑驳的阳光” |

**未做人工 1～5 分评分**：PRD 要求参考译文经人工核对，本阶段没有人工评分人，故不把以上结果写成质量达标结论。云端质量对比因无凭据无法进行。

## 2. 云端引擎验证

### 2.1 原定腾讯云机器翻译（TextTranslate）不可作为首版新用户方案

官方证据：

- 腾讯云公告《【机器翻译】文本翻译退市下线通知》：TextTranslate / TextTranslateBatch 停止销售（EOM）2027-01-31，停止全面支持（EOSS）2027-07-31，停止所有服务（EOMS）2030-12-31；迁移目标为 TokenHub 的 `hy-mt2-plus` / `hy-mt2-pro` / `hy-mt2-lite`。
- 腾讯云机器翻译更新历史：2026-03-12 第 15 次发布删除 `TextTranslateBatch`；2026-07-08 第 17 次发布删除 `TextTranslate`。
- 官方 npm 包 `tencentcloud-sdk-nodejs-tmt@4.1.265` 与完整包 `tencentcloud-sdk-nodejs@4.1.340` 中，`tmt` 服务只剩 `ImageTranslateLLM`，不存在 `TextTranslate` 客户端方法。

因此不把 TextTranslate 作为首版云端依赖，避免交付一个无法新开通的通道。PRD 的“优先腾讯云”意图由腾讯官方指定的迁移产品 TokenHub 承接。

### 2.2 采用的官方云端：腾讯云 TokenHub `hy-mt2-plus`

官方文档已核实的事实：

| 项目             | 内容                                                                                           |
| ---------------- | ---------------------------------------------------------------------------------------------- |
| 协议             | OpenAI Chat Completions 兼容                                                                   |
| 路径             | `POST /v1/chat/completions`                                                                    |
| 广州（中国大陆） | `https://tokenhub.tencentmaas.com/v1`，备用域名 `https://tokenhub.tencentmaas.cn/v1`           |
| 新加坡（全球）   | `https://tokenhub-intl.tencentmaas.com/v1`，备用域名 `https://tokenhub-intl.tencentmaas.cn/v1` |
| 鉴权             | `Authorization: Bearer <API KEY>`                                                              |
| API Key 管理     | `https://console.cloud.tencent.com/tokenhub/apikey`                                            |
| 翻译模型         | `hy-mt2-pro` / `hy-mt2-plus` / `hy-mt2-lite`，三者仅支持 Chat Completions                      |
| 区域限制         | 不支持跨地域、跨站点调用；Key 与开通区域匹配                                                   |
| 开通             | 需在控制台开通模型，否则返回 402                                                               |

本机网络实测（2026-11-06）：

| 请求                                                            | 结果                                                        |
| --------------------------------------------------------------- | ----------------------------------------------------------- |
| `GET https://tokenhub.tencentmaas.com/v1/models`（无凭据）      | HTTP 401，`401001` 认证信息缺失                             |
| 同上，伪造 Key                                                  | HTTP 401，`401002` Key 不存在或签名校验失败                 |
| `GET https://tokenhub-intl.tencentmaas.com/v1/models`（无凭据） | HTTP 401 `401001`                                           |
| `POST /v1/chat/completions`（无凭据，合法 JSON）                | HTTP 401，路径存在                                          |
| `POST` 新加坡 `/v1/chat/completions`（伪造 Key）                | HTTP 401                                                    |
| `POST https://tmt.tencentcloudapi.com/`（无签名）               | HTTP 200 + `InvalidParameter`，旧接口仍在线但按退市计划收缩 |

**未验证：**

- 没有任何真实 API Key，因此**没有完成一次真实云端翻译**，不能声称云端请求成功。
- 未验证 `hy-mt2-plus` 的实际译文质量、延迟、SSE 行为、错误码全集、429/402 的具体响应体。
- 未验证广州/新加坡区域 Key 的开通资格、免费额度、计费与后付费开关。
- 未验证中国大陆家庭/公司网络与海外网络的可达性；本报告只有本机网络的结果。

### 2.3 云端实现约束（据此设计）

- Key 只保存在 `chrome.storage.local`（`TRUSTED_CONTEXTS`）或 `chrome.storage.session`（仅本次会话），由 Service Worker 读取；Content Script 不接触 Key。
- 请求由 Service Worker 发出；Provider endpoint 固定，不接受调用方传入 URL 或任意请求头。
- 目标语言映射为提示词中的语言名称（`Simplified Chinese (简体中文)`、`English`、`Japanese`）；源语言为 `auto` 时不强行指定。
- 模型是对话模型，请求体包含 system 指令“只输出译文”，`temperature: 0`；该提示词 **未经真实模型验证**，设置页的“测试连接”是用户首次验证手段。
- 区域由用户选择（广州/新加坡），切换区域时要求重新测试凭据。

## 3. 引擎决策

| 决策         | 结论                    | 依据                                                          |
| ------------ | ----------------------- | ------------------------------------------------------------- |
| 默认引擎     | 本地优先（local-first） | 本地实测可用、热启动 2～30ms、离线可用；云端无质量/可用性实测 |
| 本地不可用时 | 默认**不**自动转云端    | PRD 要求回退默认关闭；用户明确开启且凭据有效才回退一次        |
| 云端默认     | TokenHub `hy-mt2-plus`  | 腾讯官方迁移目标；新用户可开通；双区域                        |
| 本地执行位置 | Service Worker          | 覆盖 HTTP/HTTPS；无需离屏文档或常驻可见页；实测可用           |
| 已知风险     | Chrome 未文档化行为     | 本地 Provider 必须能力检测并明确降级                          |

**不宣称本地更准确，也不宣称云端更快。** 本阶段没有可比的云端质量数据。

## 4. 未验证项清单

1. 真实 TokenHub API Key 下的翻译请求、质量、延迟、限流和错误码。
2. 国内家庭/企业网络与海外网络对 TokenHub 广州/新加坡的实际可达性。
3. Chrome 内置 AI 在中国大陆受限网络下的模型下载成功率；企业代理/弱网表现。
4. Chrome 157+ 是否继续在 Service Worker 中暴露 Translator（当前为未文档化行为）。
5. 人工 1～5 分质量评分与云端对照；本报告只有本地原始输出。
6. Windows 平台。
7. 跨域 iframe、PDF、Canvas、封闭 Shadow DOM（P0 范围外）。
8. 真实网页（文章页、技术文档、动态加载页）上的端到端表现；阶段 B～D 再测。

## 5. 复现方法

```bash
# 启动 fixture 服务器（端口 8787）
cd probe/fixture && python3 -m http.server 8787
```

```bash
# 普通页面内置 AI 探针（会打开一个 Chrome 窗口）
node probe/plain-ai.mjs
```

```bash
# 扩展上下文探针（CDP 加载探针扩展）
node probe/drive.mjs
node probe/probe2.mjs
node probe/probe3.mjs
```

注意：

- Chrome 156 正式版不再支持 `--load-extension`；探针使用 CDP `Extensions.loadUnpacked`，需要 `--enable-unsafe-extension-debugging`。
- 探针与产品代码分开，`probe/` 不进入发布 zip。
- 探针会创建临时 Chrome 用户目录（`/tmp/fanyi-*`），不影响日常 Chrome 配置。

## 6. 引用

- [Chrome Translator API](https://developer.chrome.com/docs/ai/translator-api)
- [Chrome Language Detector API](https://developer.chrome.com/docs/ai/language-detection)
- [Chrome Offscreen API](https://developer.chrome.com/docs/extensions/reference/api/offscreen)
- [腾讯云机器翻译文本翻译退市下线通知](https://cloud.tencent.com/announce/detail/2482)
- [腾讯云机器翻译更新历史](https://cloud.tencent.com/document/product/551/17231)
- [腾讯云 TokenHub API 使用说明](https://cloud.tencent.com/document/product/1823/130078)
- [腾讯云 TokenHub 语言模型调用概览](https://cloud.tencent.com/document/product/1823/130079)
- [TokenHub API Key 控制台](https://console.cloud.tencent.com/tokenhub/apikey)

## 7. 实施后的补充事实（阶段 B–E）

日期：2026-11-06。以下为在实现与交付验证中新增、可复现的观测。

### 7.1 本地执行位置最终选择

- 采用 **MV3 Service Worker** 执行本地翻译。它可以覆盖非安全 HTTP 页面（Content Script 在 HTTP 页面没有 `Translator`），且不需要离屏文档或常驻可见页。
- 实测：Service Worker 中热启动创建 68～74ms，翻译 14～22ms；模型准备后重启 Chrome 仍为 `available`；离线模拟下可翻译。
- 这是 Chrome 156 的未文档化行为；代码已做能力检测与明确降级。详见 [ARCHITECTURE.md](ARCHITECTURE.md)。

### 7.2 权限与注入

- 正式版 Chrome 156 接受 `--load-extension` 的情况不稳定；本机正式版忽略该开关，探针改用 CDP `Extensions.loadUnpacked`（测试专用）。
- Playwright 自带的 Chromium 156 仍可用 `--load-extension` 加载扩展，端到端测试使用该方式。
- 产品构建使用 `optional_host_permissions` + 运行时 `registerContentScripts`；测试构建预授予所有 HTTP/HTTPS 权限以避开原生授权弹窗。生产授权流程需人工验证。

### 7.3 缓存与重启

- 正常关闭浏览器后，`chrome.storage.session` 中的翻译缓存清空（实测 1 条 → 0 条），`storage.local` 设置保留。
- 测试中若强制结束 Chrome 进程而非正常退出，session 存储可能暂时保留；这属于异常退出行为，正常使用不依赖它。

### 7.4 真实网页结果

| 页面                    | 源文长度 | 本地译文可见耗时（含 250ms 防抖） | 结果         |
| ----------------------- | -------- | --------------------------------- | ------------ |
| Wikipedia 文章页        | 347 码点 | 379.6ms                           | 正确中文译文 |
| MDN 技术文档            | 95 码点  | 358.9ms                           | 正确中文译文 |
| react.dev（客户端渲染） | 140 码点 | 280.9ms                           | 正确中文译文 |

### 7.5 性能

- 本地 20 次 UI 计时：p50 277.4ms、p95 281.5ms、max 352.5ms（含 250ms 防抖）。
- 缓存命中 20 次：p50 259.3ms、p95 263ms（含防抖；扣除防抖约 9–13ms 处理）。
- 引擎层短句（20–150 码点，30 条）：p50 6ms、p95 11ms。
- 云端性能：无凭据，未验证。

### 7.6 仍未完成

- 真实 TokenHub 翻译、质量与额度。
- 国内/海外网络的分别实测。
- 人工质量评分。
- 浏览器缩放、原生权限弹窗、弹窗站点开关的人工验证。
