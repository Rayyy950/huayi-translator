# 安全策略（SECURITY）

## 支持范围

当前维护 0.1.x。安全问题会在合理时间内评估；不承诺固定 SLA。

## 报告方式

请优先使用 GitHub 仓库的 **Security → Report a vulnerability**（私有安全公告），不要在公开 issue 中粘贴：

- API Key、Token 或账号信息；
- 完整网页内容或可识别个人的文本；
- 可直接利用的复现步骤与凭据组合。

如果私有报告不可用，请开一个不含敏感细节的 issue，说明希望私下沟通。

## 设计中的安全边界

- 云端使用用户自带 Key（BYOK）；仓库不包含共享生产密钥。
- API Key 只存于扩展可信存储（`storage.local` / `storage.session`），页面脚本与 Content Script 不能读取。
- 云端请求只由 Service Worker 发往固定 Provider 端点；不接受任意 URL 或任意请求头。
- 消息按发送方类型校验；Content Script 只能翻译/取消与读取脱敏设置。
- 翻译文本按纯文本渲染；不执行 HTML/脚本。
- 扩展存储不是操作系统保险箱；能访问本机 Chrome 用户目录的人可能读取本地数据。

## 不在范围内

- Chrome 平台自身的漏洞；
- 用户自行安装的第三方扩展；
- 腾讯云 TokenHub 服务端的安全与数据保留策略；
- 用户把 Key 写进公开代码、截图或聊天记录。
