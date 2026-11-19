# dsh-imessage

**在 iPhone 的「信息」里直接跟 DeepSeek Harness 对话。** 发一条 iMessage，Harness 在服务器上跑，回答沿原路回到你的收件箱——图片、语音、文件都能双向走。

[![Release](https://img.shields.io/github/v/release/zhou200310/dsh-imessage?label=release)](https://github.com/zhou200310/dsh-imessage/releases)
[![DSH](https://img.shields.io/badge/DeepSeek%20Harness-0.2.2--rc.1-4D6BFE)](https://github.com/deepseek-ai)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-339933)](package.json)

> 本仓库是 [photon-hq/dsh-imessage](https://github.com/photon-hq/dsh-imessage) 的 **DeepSeek Harness 0.2.2 兼容适配版**：上游 peer 依赖锁死在 `0.1.0-rc.6`，在 `0.2.2-rc.1` 上装了也不激活、收到消息也不回。这里保留了上游全部功能，把断掉的 API 逐个接回来，并补上多模态与语音，现在是端到端可用的。

```
iPhone「信息」 → Photon → Spectrum → DSH 插件 → DSH 会话
                                              ↓
iPhone「信息」 ← Photon ← Spectrum ← DSH 插件 ← agent 回复
```

## 为什么用这个而不是上游

| | 上游 `dsh-imessage@0.2.0` | 本仓库 |
|---|---|---|
| DSH `0.1.0-rc.6` | ✅ 可用 | ✅ 可用 |
| DSH `0.2.2-rc.1` | ❌ 装了不激活 | ✅ 端到端验证 |
| 图片进上下文 | ❌ 静默丢弃 | ✅ ImageBlock，模型直接看像素 |
| 图片/文件发出 | ❌ | ✅ 原生 iMessage 附件 |
| 语音进出 | ❌ | ✅ 转写 / TTS 语音条 |
| 会话归属 | ❌ 掉进 Ungrouped | ✅ 按 cwd 挂到对应工作区 |

## 功能

**文字**
手机发文字 → DSH 会话；长回答按 `maxOutboundChars`（默认 3500）切块发送，不截断 Unicode。

**图片与文件（双向）**

| 方向 | 类型 | 处理 |
|---|---|---|
| 收 | png / jpeg / webp / gif | `attachments.saveImage()` → **ImageBlock**，模型看到的是像素 |
| 收 | 语音 `audio/*` | `faster-whisper` 转写 → 文字进上下文 |
| 收 | 视频 / pdf / 文档 | `attachments.saveFile()` → **FileBlock**（句柄：文件名 + 字节数 + 只读路径） |
| 发 | 回答里的 image 块 | `readImage()` 读回字节 → Spectrum 附件 |
| 发 | 回答里的 file 块 | `hostPath` 直读，非宿主后端回落 `readFileStream()` |

单个附件失败只回一句提示或记日志，不会吞掉整个 turn。

**语音**

| 方向 | 触发 | 处理 |
|---|---|---|
| 收 | iPhone 语音 | 落临时文件 → `faster-whisper` tiny 转写 → 文字 |
| 发 | 回答里写 `[语音: 文本]` | Edge-TTS（`zh-CN-XiaoyiNeural`）合成 mp3 → 音频附件 |

语音工具链跑在共享 venv（`tools/tts-venv`），Node 侧零依赖、只 shell 调用；可用 `DSH_VOICE_TOOLS` / `DSH_VOICE_PYTHON` / `DSH_VOICE_NAME` 覆盖。入站识别纯本地，出站合成要能连微软，需要代理可达。

> 能力边界：视频和文档在模型侧只呈现为句柄文本（知道文件存在与路径），不会被"看懂"；图片是真进上下文；语音会被转写，所以内容听得懂，语气听不出来。

**会话**
新建会话自动 `resolveByPath(cwd)` 挂到匹配的工作区，不会掉进 Ungrouped；`/sessions` 可以翻页切换历史会话直接续聊。

## 安装

**预构建包（推荐）**

```bash
dsh plugin --profile web add https://github.com/zhou200310/dsh-imessage/releases/latest/download/dsh-imessage-0.3.0.tgz
```

**从源码**

```bash
dsh plugin --profile web add github:zhou200310/dsh-imessage
```

装完 **冷启动** dsh（应用中心停一下再启动，不要热重载、不要 kill 主进程）。重启后到 设置 → iMessage：

1. **Authorize** → 完成 Photon 设备登录
2. 填**发送号码**（哪个号发消息给 Harness）
3. 拿到**托管号码**（Harness 的号，加到通讯录）
4. 若状态不是 Listening，点一次 **Retry listener**

> 装过 npm 上同名 `dsh-imessage@0.2.0` 的，先移除再装——包名相同，pnpm 会用后装的覆盖。
> 宿主低于 `0.2.2-rc.1` 时会被兼容性检查拦下，本包只针对 0.2.2 的 API 适配。

## 配置项

| 字段 | 默认 | 说明 |
|---|---|---|
| `photonApiOrigin` | `https://api.photon.codes` | Photon API 源，必须 HTTPS（loopback 测试可 HTTP） |
| `phoneNumber` | — | 你自己的发送号码（volatile，只存在本地） |
| `assignedPhoneNumber` | — | Photon 分配的托管号码 |
| `photonUserId` | — | 授权后的 Photon 用户 id |
| `maxOutboundChars` | `3500` | 单条 iMessage 最大字符，超出切块 |
| `interactionTimeoutMs` | `600000` | 反问/确认等人工交互等待上限 |
| `sessionsPerPage` | `5` | `/sessions` 每页会话数 |
| `dedupeEntries` | `1024` | 入站消息去重窗口 |
| `reconnectMinMs` / `reconnectMaxMs` | `1000` / `60000` | Spectrum 重连退避区间 |

## 兼容性

- **DSH**：`0.2.2-rc.1`（peer 依赖全部锁定这个版本）
- **Node**：`^22.19.0 || >=24.0.0`
- **平台**：Photon 托管线路，需要一个美国 iMessage 号作为出口（Photon 提供）

## 六个兼容坑（0.1.0-rc.6 → 0.2.2-rc.1）

| # | 断层 | 修复 |
|---|---|---|
| 1 | `settingsNamespace()` / `settings.register()` 被删；`SettingsForms` 只投影 **volatile** 字段 | 用户配置合并进 cordis `Config` schema 并标 `.volatile()`（schemastery 须 3.19.0） |
| 2 | `sessionPersistence.inspect()` 被删 | 改用 `open(id, 'read')` + `read()` + `close()` |
| 3 | 消息 source 的 `'plugin'` kind 被删（只剩 `user`/`model`/`tool`/`system-prompt`） | 改 `source: { kind: 'user' }`，否则 agent 丢消息、turn 空转 |
| 4 | 重启后 Spectrum listener 不自动恢复 | init 改 `scheduleRuntimeStart()` 延迟重试，等 settings 就绪再 `restart()` |
| 5 | 只认 `content.type === 'text'`，附件被静默丢弃 | 放宽到 `attachment`，分流图片/文件 |
| 6 | `agents.create()` 建的会话绕过工作区挂载 | 建完 `resolveByPath(cwd)` + `attachSession()` |

逐条复现过程、重建步骤、依赖锁定、排查技巧都在 **[ADAPTATION.md](ADAPTATION.md)**。

## 常见问题

**装完设置页看不到 iMessage 入口？**
插件没激活。确认 DSH 版本是 `0.2.2-rc.1`，并**冷启动**过一次（热重载不会重新加载 bundle 的 cordis patch）。

**收不到消息 / 状态一直 Disconnected？**
多半是网络：`app.photon.codes`、`spectrum.photon.codes` 在 Cloudflare 上，国内可直连。如果 Harness 被注入了指向机场的 `HTTPS_PROXY`，给 photon 域名加直连规则，否则节点一挂授权和监听一起失败。另外确认后台/熄屏时连接没被系统切断——0.2.2 起加了生命周期感知。

**发了图但模型说没收到？**
iPhone 默认发 HEIC，Spectrum 读附件常抛 `Connection dropped`。本适配版做了重试 + 占位 + HEIC→JPEG 转换（依赖系统 ImageMagick），仍失败会给你一句提示而不是静默丢弃。

**重启后要手动点 Retry listener？**
已知问题（init 时 settings 未就绪导致自动 restart 被跳过）。已经在 init 里加延迟重试，若仍遇到点一次即可。

**长回答被切成一堆气泡？**
按 `maxOutboundChars` 切块是预期行为，调大即可（iMessage 单条上限约 4000 字符）。

## 开发

```bash
npm install --legacy-peer-deps
npm run build       # 产物在 lib/
npm run test
npm run check       # test + build + audit + pack
```

## 许可

[Apache-2.0](LICENSE)。上游 photon-hq/dsh-imessage 同步遵守其原始许可。
