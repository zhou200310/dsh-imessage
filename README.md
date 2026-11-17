# dsh-imessage（DSH 0.2.2 适配版）

[photon-hq/dsh-imessage](https://github.com/photon-hq/dsh-imessage) 的 **DSH 0.2.2 兼容适配**。

上游 `dsh-imessage@0.2.0` 的 peer 依赖锁定在 DeepSeek Harness **`0.1.0-rc.6`**，与 `0.2.2-rc.1` 之间存在多处 API 断层，直接安装无法激活、无法收发消息。本仓库保留了上游全部功能，并把四个兼容坑逐一修复，使其在 DSH 0.2.2 上**端到端可用**（Photon 授权 → 托管号码 → iMessage 收发）。

## 这是什么

`dsh-imessage` 是一个 DeepSeek Harness 插件，通过 [Photon](https://photon.codes) 托管一条 iMessage 线路，让你在 iPhone「信息」里直接跟 DSH 对话：

- 消息从你的 iPhone → Photon → Spectrum → DSH 插件 → 触发 DSH 会话
- DSH 的回复沿原路发回你的 iMessage

## 四个兼容坑（0.1.0-rc.6 → 0.2.2-rc.1）

| # | 断层 | 修复 |
|---|---|---|
| 1 | `settingsNamespace()` / `settings.register()` 被删；`SettingsForms` 只投影 **volatile** 字段 | 用户配置字段合并进 cordis `Config` schema 并标 `.volatile()`（schemastery 须 3.19.0） |
| 2 | `sessionPersistence.inspect()` 被删 | 改用 `open(id, 'read')` + `read()` + `close()` |
| 3 | 消息 source 的 `'plugin'` kind 被删（只剩 `user`/`model`/`tool`/`system-prompt`） | 改为 `source: { kind: 'user' }`，否则 agent 丢消息、turn 空转 |
| 4 | 重启后 Spectrum listener 不自动恢复 | 重启后手动 设置 → iMessage → Retry listener（详见 ADAPTATION.md） |

完整踩坑记录、重建步骤、依赖版本锁定、排查技巧见 **[ADAPTATION.md](ADAPTATION.md)**。

## 已验证

- DSH `0.2.2-rc.1`，生产 profile 冷启动激活
- Photon 设备授权 → 项目 `dsh` → 托管号分配 → Spectrum `Listening`
- iMessage 端到端收发（`turn/start → step/start → user/message → assistant/message` 完整链路）

## 快速开始

```bash
# 安装（注意：需在 0.2.2 下冷启动）
dsh plugin --profile web add dsh-imessage

# 冷启动 dsh（fnOS 应用中心停一下再启动；不要热重载 / kill）
# 重启后：设置 → iMessage → Authorize → 完成 Photon 设备登录
# → 填发送号码 → 拿到托管号 → Retry listener（如需）
```

> 若直接安装因版本不兼容被拒，先在 profile 的 `compatibility.json` 加 `"dsh-imessage@0.2.0": ["0.2.2-rc.1"]` 豁免。

## 从源码构建

```bash
npm install --legacy-peer-deps
npm run build
# 产物在 lib/；部署见 ADAPTATION.md 的「重建步骤」
```

## 网络提示

`app.photon.codes` / `spectrum.photon.codes` 挂在 Cloudflare，国内可直连。若 Harness 被注入了指向机场的 `HTTPS_PROXY`，建议给 photon 域名加直连规则（见 ADAPTATION.md），否则机场节点一挂，授权和监听会跟着失败。

## 许可

沿用上游 [MIT](LICENSE)。
