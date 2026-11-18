# dsh-imessage（DSH 0.2.2 适配版）

[photon-hq/dsh-imessage](https://github.com/photon-hq/dsh-imessage) 的 **DSH 0.2.2 兼容适配**。

上游 `dsh-imessage@0.2.0` 的 peer 依赖锁定在 DeepSeek Harness **`0.1.0-rc.6`**，与 `0.2.2-rc.1` 之间存在多处 API 断层，直接安装无法激活、无法收发消息。本仓库保留了上游全部功能，并把四个兼容坑逐一修复，使其在 DSH 0.2.2 上**端到端可用**（Photon 授权 → 托管号码 → iMessage 收发）。

## 这是什么

`dsh-imessage` 是一个 DeepSeek Harness 插件，通过 [Photon](https://photon.codes) 托管一条 iMessage 线路，让你在 iPhone「信息」里直接跟 DSH 对话：

- 消息从你的 iPhone → Photon → Spectrum → DSH 插件 → 触发 DSH 会话
- DSH 的回复沿原路发回你的 iMessage
- **支持多模态**：图片进模型上下文（ImageBlock），视频/pdf/语音等存为文件块（FileBlock）
- 新建会话自动挂到 cwd 匹配的工作区，不掉进 Ungrouped

## 六个兼容坑（0.1.0-rc.6 → 0.2.2-rc.1）

| # | 断层 | 修复 |
|---|---|---|
| 1 | `settingsNamespace()` / `settings.register()` 被删；`SettingsForms` 只投影 **volatile** 字段 | 用户配置字段合并进 cordis `Config` schema 并标 `.volatile()`（schemastery 须 3.19.0） |
| 2 | `sessionPersistence.inspect()` 被删 | 改用 `open(id, 'read')` + `read()` + `close()` |
| 3 | 消息 source 的 `'plugin'` kind 被删（只剩 `user`/`model`/`tool`/`system-prompt`） | 改为 `source: { kind: 'user' }`，否则 agent 丢消息、turn 空转 |
| 4 | 重启后 Spectrum listener 不自动恢复 | init 改为 `scheduleRuntimeStart()` 延迟重试，等 settings 就绪再 `restart()` |
| 5 | 消息只认 `content.type === 'text'`，图片/文件被静默丢弃 | 放宽到 `attachment`；图片→`saveImage`/ImageBlock，其他→`saveFile`/FileBlock |
| 6 | 插件用 `agents.create()` 建的会话绕过工作区挂载，掉进 Ungrouped | 建完 `resolveByPath(cwd)` + `attachSession()` |

完整踩坑记录、重建步骤、依赖版本锁定、排查技巧见 **[ADAPTATION.md](ADAPTATION.md)**。

## 多模态支持（双向）

**收：iPhone → DSH**

| 附件类型 | 处理方式 |
|---|---|
| png / jpeg / webp / gif | `attachments.saveImage()` → **ImageBlock**，模型直接看到像素 |
| 视频 / pdf / 语音 / 文档 / 其他 | `attachments.saveFile()` → **FileBlock**，请求组装时投影成句柄（文件名+字节数+只读路径） |

单张被拒（格式/大小不合规）只回一句提示，不吞掉整个 turn。

**发：DSH → iPhone**

Agent 回答里带的图片和文件，按原生 iMessage 附件发出去：

| 回答里的块 | 出站处理 |
|---|---|
| `image`（ImageAttachmentRef） | `attachments.readImage()` 读回字节 → Spectrum `attachment(buffer, { mimeType })` |
| `file`（FileAttachmentRef） | `hostPath` 直读；非宿主后端回落到 `readFileStream()` 收齐再发 |

文本仍然先发（切块），附件按 turn 内产生顺序跟在后面；单个附件发失败只记日志，不影响其余部分。

能力边界：语音/视频不会「被理解」内容——FileBlock 在模型侧是句柄文本，模型知道文件存在与路径，图片才是真进上下文。

## 已验证

- DSH `0.2.2-rc.1`，生产 profile 冷启动激活
- Photon 设备授权 → 项目 `dsh` → 托管号分配 → Spectrum `Listening`
- iMessage 端到端收发（`turn/start → step/start → user/message → assistant/message` 完整链路）
- 图片消息：512×512 JPEG 原图落盘 `~/.dsh/attachments/`，以 ImageBlock 进上下文
- 新建会话自动归属 cwd 匹配的工作区

## 快速开始

**从预构建包安装（推荐）** —— 装的就是本适配版，无需自己构建：

```bash
dsh plugin --profile web add https://github.com/zhou200310/dsh-imessage/releases/download/v0.2.2/dsh-imessage-0.2.2.tgz
```

**从源码安装**（会跑一次 `npm run build`）：

```bash
dsh plugin --profile web add github:zhou200310/dsh-imessage
```

装完**冷启动** dsh（fnOS 应用中心停一下再启动；不要热重载 / kill）。重启后：

设置 → iMessage → Authorize → 完成 Photon 设备登录 → 填发送号码 → 拿到托管号 → Retry listener（如需）。

> 如果此前装过 npm 上的上游 `dsh-imessage@0.2.0`，先移除再装本包；两者包名相同，pnpm 会用后装的覆盖前者。
>
> 宿主版本低于 `0.2.2-rc.1` 时安装会被兼容性检查拦下——本包只针对 0.2.2 的 API 适配，请在 `0.2.2-rc.1` 上使用。

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
