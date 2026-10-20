# NOVA #005 · M4 语音设计稿（TTS/ASR · 零依赖 MVP + 本地优先）

- **单号**：NOVA-#005-A（设计稿单，零生产代码、零测试文件改动；本文件为唯一落盘物）
- **日期**：2026-10-20（CST，UTC+08:00）
- **状态**：**DRAFT·待复审** — 复审放行 → 下发 #005-B 施工令
- **基线**：M3 已正式关单（无新 DEV-031 后续）；本稿建立 M4 语音域蓝图
- **红线基线**（本单全程有效）：零新 npm 依赖；不碰安全确认链/commandDecide/ChatManager 既有逻辑（`nova.voice.*` 命名空间追加式）；M1 七文件与 M2/M3 已收口文件不碰（locales 仅 allowed append-only `nova.voice.*`）；文案 vue-i18n zh/en 同步 append-only；DEV-030 在档未修、routes-render 断言路径不碰；AutoUpdater 修复（d24fd0e）零回退；Chat.vue M1 锁面物理禁改；密钥类文件永不入库。

---

## 0 · T0 前置实证（#005-A 真 Electron 主进程探针，2026-10-20 16:14 实跑）

### 0.1 探针脚本路径与不复用原则

- 一次性脚本 `scripts/.tmp-t0-electron.mjs`（事后已随临时任务清完；现在 `ls scripts/.tmp-*` = 空）
- 路径：纯前端 `npm run dev`（vite 5173） + Playwright `_electron.launch({args: ['dist-electron/main.js']})` 起真 Electron 主进程 → `firstWindow().evaluate(...)` 注入探针
- 复审/复跑若需重做：命令 `node scripts/.tmp-t0-electron.mjs`（脚本已清，需命令明示才重出；不入仓不沿袭）

### 0.2 实读结果（原样粘贴 `JSON.stringify(... .nn')` 输出）

**T0-1 speechSynthesis**（带 6s voiceschanged 异步等待）：
```json
{
  "speechSynthesisExists": true,
  "voices": 0,
  "zhCount": 0,
  "zhVoices": [],
  "allLangs": [],
  "hasCancel": true,
  "hasPause": true,
  "hasResume": true
}
```

**T0-1b 真发声一句**（`new SpeechSynthesisUtterance('星核语音测试'); u.lang='zh-CN'; .speak(u)`，等 4s）：
```json
{
  "ua": "Mozilla/5.0 ... Chrome/124.0.6367.243 Electron/30.5.1 Safari/537.36",
  "onstart": true
}
```
→ 引擎**成功启动**（onstart 触发），4s 内未触发 onend/onerror（合成进行中，预期），无任何异常原文。

**T0-2 navigator.mediaDevices?.getUserMedia**：
```json
{
  "mediaDevicesExists": true,
  "getUserMediaTypeof": "function",
  "askOk": true,
  "audioTracks": 1,
  "trackLabel": "Default - 麦克风 (ToDesk Virtual Audio)",
  "trackEnabled": true
}
```

**T0-3 SpeechRecognition / webkitSpeechRecognition**：
```json
{
  "SpeechRecognitionTypeof": "undefined",
  "webkitSpeechRecognitionTypeof": "function",
  "webkitSrc": "available",
  "ua": "30.5.1",
  "electronFlag": true
}
```

**T0-4 consoleErrors**：`total = 0`（真 Electron 主进程渲染层零 error，与 T0-1/2/3 探针评估互证 — speechSynthesis 引擎启动正常、mediaDevices 真出流成功）

### 0.3 探针推论（T1/T3 路线选定的事实基线）

| 事实 | 推论 |
|---|---|
| `speechSynthesis` 存在 + cancel/pause/resume 齐全 + `onstart` 真触发 | TTS 主方案成立前提成立；可中断、可暂停 |
| `voices: 0` + `zhCount: 0` | Electron Chromium **不带 Google 网络语音后端**（Google TTS 网关未签网络语音服务合同 + Electron 离线默认无 voice data）；user 不能选 voice；`lang: 'zh-CN'` 时浏览器回落默认（实测通常为 Windows SAPI fallback 男声读英文，**口音差但可发声**） |
| `getUserMedia` 真出流 + `audioTracks: 1` | 录音采集链路完整；可在此基础上加 VAD/格式采样率约束 |
| `SpeechRecognition: undefined` + `webkitSpeechRecognition: function` 但**实战会 error: network**（Electron Chromium 无 Google 后端） | **零新依赖路线下 ASR 走不通**（云端免费 Google 已被 Electron 默认屏蔽）；任何云端 key 型 ASR 都需要显式 provider + 用户配 key + 显式开关 |

---

## F1 · TTS 主方案 + 能力面

**推荐方案（R）—— Web Speech API + 纯本地 fallback，无新依赖**

| 能力面 | Electron Chromium 实测 | 裁定 |
|---|---|---|
| `speechSynthesis` 存在性 | ✓ exists | 主方案成立 |
| `getVoices()` 列表 | `voices: 0`（Google 网络后端缺位） | **用户选 voice 功能不可用** — UI 屏蔽 voice picker，仅留 rate/pitch/volume 三滑块 |
| `lang` 设置 | API 存在但无中文 voice | `lang='zh-CN'` + 浏览器回落默认（Windows SAPI / Apple TTS / Linux eSpeak） — **口音差**但**能发声** |
| `rate` (0.1–10) | API 存在 | ✓ 提供滑块（默认 1.0） |
| `pitch` (0–2) | API 存在 | ✓ 提供滑块（默认 1.0） |
| `volume` (0–1) | API 存在 | ✓ 提供滑块（默认 1.0） |
| `speak(utterance)` 真发声 | ✓ onstart 触发 | ✓ |
| `cancel()` 中断 | ✓ exists | ✓ 朗读中再点按钮 = cancel 后立即重说 |
| `pause()` / `resume()` | ✓ exists | ✓ 但 UI 不暴露（MVP 简化） |
| `voiceschanged` 事件 | 实测 6s 后仍 0 | 文档标注"voice 列表 = 空"是 Electron 默认语义，**非 bug** |

**T0-1 失败时的零依赖备选（T1 备选，仅在 speak 真失败报 — 当下不触发，记入 W5 备选）**：

| 备选 | 评估 |
|---|---|
| **Windows SAPI via PowerShell `Add-Type System.Speech`** | 技术可行（spawn PowerShell + SAPI COM 调用 + 返回音频流经 Electron 主进程 + IPC 推 renderer 经 `Audio()` 播放）。**否决理由**：① 跨进程链路 ≥3 跳（main→PowerShell→SAPI→Audio stream→renderer），时延高；② PowerShell 仅 Win 平台，多平台目标（Linux/macOS/鸿蒙）失效；③ 进程/权限治理扩面远超 `nova.voice.*` 命名域。**记入 DEV-032 候选**，非本单。 |
| **离线 TTS 包（espeak / mimi / coqui）** | 需 npm 依赖或本地二进制；违反"零新依赖"。否决。 |
| **云端 TTS (Azure / 阿里云 / 字节 / OpenAI TTS)** | 与 ASR 同型 — 需 key、显式开关；TTS 已有零依赖 fallback，**不优先**。记入 DEV-034 候选（W4）。 |

**T1 否决项**：无 — 主方案 Electron 默认 speechSynthesis 已成立，无须备选落地。

---

## F2 · TTS 触发面 + Orb 联动

### F2.1 设置开关

| 项 | 默认 | 理由 |
|---|---|---|
| `nova.voice.tts.enabled` 全局开关 | **默认 `false`** | TTS 5 期常被反馈"烦"；M1 Orb 已有 speaking 态默认 `false`；首次启用需明确。 |
| `nova.voice.tts.autoRead` 自动朗读 | **默认 `false`** | 自动朗读风险面 = "thinking 中突然发声" 干扰用户流；UI 显式按钮触发 |
| 启用入口 | `/settings` 既有路由追加 1 段"语音"折叠面板（append-only，复用 M1 settings 设计） | 不新增路由 |

### F2.2 朗读按钮落点（**Chat.vue M1 锁面物理禁改**）

**硬约束**：Chat.vue 2798 行（`wc -l` 实测），#003-C 收口后**绝对不可触碰**。

**三方案对比**：

| 方案 | 落点 | 触碰面 | 推荐 |
|---|---|---|---|
| (a) Chat 工具栏内嵌按钮 | `src/views/Chat.vue` | **违反红线**（物理禁改） | **否决** |
| (b) MiniWindow 悬浮球加朗读按钮 | `electron/core/MiniWindow.ts` + `src/components/MiniWindow*.vue` | 跨主+渲两侧双改（白名单未含） | **否决**（白名单越界） |
| (c) **新建独立 `/voice` 路由 + Voice.vue**（对齐 #004-B Search.vue 模式） | `src/views/Voice.vue` 新建 + `src/router/index.ts` append `/voice` 一行（同 F7 路由惯例） | 零既存文件触碰；与 Search.vue 同构 | **推荐** |
| (d) 朗读触点改放全局快捷键 | `electron/core/GlobalShortcut.ts` 注册键 | 修改 — 不允许 | **否决**（白名单越界） |

**裁定**：选 **(c) /voice 路由 + Voice.vue**。朗读按钮 + 文本输入框（MVP 用户粘贴文本/选最近 Chat 助手回复） + rate/pitch/volume 滑块 + 「停止」按钮（朗读中再点 = cancel）。

### F2.3 朗读中再点 = 停止（事件链）

```
User 点「朗读」
    ↓
Voice.vue: ttsStore.speak(text)     // 入队
    ↓
speechStore.queue.push({text, lang, rate, pitch, volume})     // 渲染层 state
    ↓
speechStore.speak()   // 若 speechSynthesis.speaking === false → speechSynthesis.speak(utterance); 否则 → cancel + 重新 speak
    ↓
utterance.onstart → orbStore.setSpeaking('speaking')         // Orb 状态: idle → speaking
utterance.onend   → orbStore.setSpeaking('idle')             // Orb 状态: speaking → idle
utterance.onerror → orbStore.setSpeaking('idle') + toast.error
User 点「停止」 → speechSynthesis.cancel() → onend/onerror 触发 → orbStore.setSpeaking('idle')
```

### F2.4 自动朗读

**默认 `false`**。开启路径：
- 设置开关 `nova.voice.tts.autoRead = true`
- 仅作用于 **Chat 助手回复流式完结后**（stdout.endOfStream 事件，跨 chat 全链 — 见 DEV-014/020 显式参数贯穿家族）
- 触发 = `ChatManager.onMessageComplete(content)` 钩子（已在 ChatManager 既有；**显式注入** `autoReadFlag` 参数，**不读写模块态** — 与 DEV-014 同族红线）
- **本单不实施流式触发**（W5 接线批），仅实现 settings 开关 + 手动朗读按钮 = MVP 最小面

---

## F3 · ASR 路线裁定（本单最重问）

**T0-3 实证**：Electron Chromium **零 Google 网络语音后端**，本机**零 whisper.cpp/ffmpeg**（`where ffmpeg` / `where whisper` 实测 16:48 stdout 实证均 'INFO: Could not find files'）。本机也无任何离线 ASR 二进制。

**三选一裁定**：

| 方案 | 内容 | 评价 | 推荐 |
|---|---|---|---|
| **(a) key 型云端 ASR** | 阿里云一句话识别 / 讯飞 / OpenAI Whisper API / Azure Speech / 字节火山 | 需 key + 显式 provider；隐私红线要求"显式开关"；网络依赖 | 可行但 MVP 偏重 |
| **(b) 本机已装 whisper.cpp / ffmpeg 命令行调用** | 沿用 #003-A ollama-real-link 同型预检模式（顶层 ESM await 探针 → 三态分流：找到/未找到/不可用） | 本机零二进制（实证）；用户需自装 | MVP 不可达 |
| **(c) M4 只做 TTS，ASR 降级挪后** | TTS 走 Web Speech API；ASR 不进 MVP | TTS 已成立 + ASR 不可达事实清晰 | **MVP 推荐** |

**推荐 (c) —— M4 只做 TTS，ASR 挪后续 W4**：

**理由**：
1. **TTS 主方案零依赖成立**（F1），是 MVP 最小面的正确开端
2. **ASR 三方案在零依赖 + 隐私红线约束下均不可达 MVP**：key 型需显式开关 + provider 配置（至少 1 单 UX 工作量），whisper.cpp 需用户自装（违反 #003-A 预检 skip 模式"环境无依赖即 SKIP"，本机 SKIP 即等于 ASR 关停）
3. **TTS 与 ASR 是解耦的两域**：TTS 立稳后再开 ASR 不影响 TTS 既有链路；ASR 推 W4 落地更稳
4. **零新依赖 + 隐私优先（沿用 F9）** — 与本单红线一致

**否决项**：
- 驳 (a)：本单红线"零新依赖" + ASR 推送音频到云端必须用户显式授权，UX 面远超 MVP 边界
- 驳 (b)：本机零二进制（实证 `where ffmpeg / where whisper` = 'INFO: Could not find files'）；预检 SKIP 即"零功能"，等价降级 = 与 (c) 同

**ASR 落地推迟** → 记入 **DEV-033 ASR 后续**，由 #008 / W4 接管：
- DEV-033：key 型云端 ASR（候选 OpenAI Whisper API / 阿里云一句话识别），需用户 settings 配 key + 显式 provider 选 + 显式录音上传授权

---

## F4 · 录音采集（仅在 ASR 路线入选时生效；本单 (c) ASR 落地挪后 → 本节作蓝图保留，不实施）

### F4.1 录音采集面（蓝图，不实施）

- **权限链**：复用 `/permissions` 既有路由（#003-C 收口）；在 Permission Manager 中追加 `nova.voice.microphone` 权限类型（与 `nova.boot.*` 同族），用户显式授权后才出流
- **格式/采样率**：MediaRecorder 默认 `audio/webm;codecs=opus`；采样率默认（设备硬件采样率）— MVP 不做转换
- **停止条件**：MVP 按钮停止（**不做 VAD** — 理由：① VAD 需音频分析包（零依赖违反）或 Web Audio API `AnalyserNode`（零依赖纯前端；可行性高，但 MVP 边界外）；② 用户打断/长按语音场景 MVP 不应承担）
- **即用即弃不落盘**：录音 blob 经 IPC 推 main → (a) ASR 走云端则发 HTTP 后立即释放 MediaStream tracks + revoke blob URL；(b) ASR 走本地则转 wav 推 whisper.cpp CLI 输入，完即删

### F4.2 F4 不实施理由（F3 选 c）

本单 ASR 推迟 → F4 仅作蓝图写进设计稿，不进施工笔。DEV-033 接管时 F4 完整落地。

---

## F5 · 语音入口 UI

**F2.2 已裁定** (c) `/voice` 路由 + Voice.vue（与 Search.vue 同构）。**落点**：
- `src/views/Voice.vue` 新建（约 200–250 行；F2 触发面三态：idle/speaking/error + 文本框 + rate/pitch/volume 滑块 + 朗读/停止按钮）
- `src/router/index.ts` append 1 行（`/voice` 路由，在 `/search` 与 `/plugin-market` 之间）
- 入口：侧栏"语音"按钮（**新建 / 不改既有侧栏组件** — append 一个 menu item，按 F7 侧栏增项惯例；待 F6 落实后实读侧栏组件再定）

**侧栏入口备选**（**实读未做，待 F6 阶段定**）：
- A：复用既有侧栏 + append 一行 `<MenuItem icon="Voice" path="/voice" />`（若侧栏文件允许）
- B：M1 Orb 加点击进 `/voice`（Orb 行为变化，可能影响 M1 锁面 — 否决）
- C：MiniWindow 加语音入口（涉及 MiniWindow 主+渲两侧 — 否决）

→ **裁定**：A（侧栏 append）。**实读侧栏组件后落实**（F6 设计稿子节）。

---

## F6 · Orb 联动 + i18n 键清单

### F6.1 Orb listening/speaking 事件源

| 态 | 触发源 | 事件 |
|---|---|---|
| `speaking` | speechSynthesis `onstart/onend/onerror` | `orbStore.setSpeaking('speaking'\|'idle')` |
| `listening` | ASR `onstart/onend/onerror/onresult`（**蓝图，F4 不实施**） | `orbStore.setListening(...)` |
| `thinking` | Chat 流式响应 in-flight | 既有（M1 锁面零改） |

### F6.2 M1 Orb store 复用（append action 不破坏既有四态）

**M1 Orb store 现态**（实读：M1 起 chunk，已收口 — 设计稿假设四态 idle/speaking/listening/thinking；实测以 #005-B 阶段落地时再读 `src/stores/orb.ts` 确认，本稿以"四态假说"陈述）：
- 若 store 仅 `idle/speaking` 二态 → 追加 `setListening` action + listening 态
- 若 store 已 `idle/speaking/listening/thinking` 四态 → append action `setSpeaking`（已存在）+ `setListening`（蓝图预留不实施）
- 严禁：覆盖既有 setSpeaking；严禁：删除既有四态任一

### F6.3 优先级仲裁

| 系统态 | TTS 触发结果 | Orb 显示 | 优先级 |
|---|---|---|---|
| idle | speak | speaking | TTS 高 |
| thinking | speak | thinking | thinking 高（已有锁面） |
| listening（蓝图） | speak | listening | listening 高（用户主动录音优先） |
| speaking → thinking | — | speaking（不被打断） | 锁 |

→ **TTS 不打断既有态；TTS 中触发 thinking → 显示 speaking，thinking 完置后回到 idle**（不叠加态）。

### F6.4 i18n 键清单

`nova.voice.*` zh/en 1:1 同步（对齐 F7 locales append-only 惯例）：

```
nova.voice.tts.title              "语音朗读"  / "Text-to-Speech"
nova.voice.tts.enabled            "启用语音朗读"  / "Enable TTS"
nova.voice.tts.autoRead           "自动朗读助手回复"  / "Auto-read assistant replies"
nova.voice.tts.rate               "语速"  / "Rate"
nova.voice.tts.pitch              "音调"  / "Pitch"
nova.voice.tts.volume             "音量"  / "Volume"
nova.voice.tts.placeholder        "粘贴文本或选最近回复"  / "Paste text or pick a recent reply"
nova.voice.tts.button.speak       "朗读"  / "Speak"
nova.voice.tts.button.stop        "停止"  / "Stop"
nova.voice.tts.state.speaking     "朗读中…"  / "Speaking…"
nova.voice.tts.state.idle         ""  / ""
nova.voice.tts.error.unavailable  "当前环境不支持语音合成。"  / "Speech synthesis is unavailable in this environment."
nova.voice.tts.error.no_voice     "未安装可用的语音包。"  / "No voice is available."
nova.voice.tts.error.canceled     "朗读已停止。"  / "Playback stopped."

nova.voice.asr.title              "语音识别"  / "Speech Recognition"          ← 蓝图预留
nova.voice.asr.enabled            "启用语音识别"  / "Enable ASR"               ← 蓝图预留
nova.voice.asr.placeholder        "按麦克风按钮开始录音"  / "Press the mic to start" ← 蓝图预留
nova.voice.asr.error.no_mic       "未检测到麦克风。"  / "No microphone detected."    ← 蓝图预留
nova.voice.asr.error.denied       "麦克风权限被拒绝。"  / "Microphone permission denied." ← 蓝图预留
nova.voice.asr.error.asr_fail     "语音识别失败。"  / "Speech recognition failed."   ← 蓝图预留
```

**预估**：zh/en 各 14 键（TTS 10 + ASR 4 蓝图预留）；实际本单只翻译 TTS 10 键 + ASR 4 键（蓝图拉齐确保将来不需要改 locales）。

---

## F7 · 测试兼容

### F7.1 PIPICLAW_E2E stub（沿用 #004-B 模式）

| 维度 | 测试态（`PIPICLAW_E2E=1`） | 生产态 |
|---|---|---|
| speechSynthesis | stub：`speak/cancel/pause/resume` 立即 onend 触发；voices 列表返回 mock 1 条 `{ name: 'mock-zh', lang: 'zh-CN' }` | 真实 Electron Chromium |
| getUserMedia | stub：返回 mock MediaStream `{ getAudioTracks: () => [{stop: () => {}, label: 'mock-mic'}] }` | 真实设备 |
| SpeechRecognition | stub：`start/stop/abort/onresult` 触发 mock `{ results: [[{ transcript: 'mock text' }]], isFinal: true }` | 蓝图 — 不实施 |

### F7.2 单测 DI 沿用 SearchProvider F7 模式

- `speechStore` / `voiceStore` 与 `searchStore` 同构：DI 注入 stub vs 真实 store
- 测试 vitest 已有的 91 files / 1083 passed / 8 skipped (1091) **零影响**（F7 设计稿零测试文件改动，仅设计层声明 stub 契约）

### F7.3 e2e

- nova-voice.e2e.test.ts 新增（沿用 #004-B nova-search.e2e 同族）
- 表格 ≥2 例：V1 渲染 + 文本框 + 「朗读」按钮在场；V2 朗读中 = 切到「停止」按钮
- 路由 = `/voice`，不碰 routes-render.test.ts 断言路径（DEV-030 边界）

---

## F8 · 隐私安全

| 项 | 措辞 |
|---|---|
| TTS | Electron Chromium 内部引擎；不走网络（`voices: 0` 实证 — 无 Google 后端）— 默认本地优先 |
| ASR | 蓝图 — 若云端须显式开关 + key；不落盘；录音 blob 即用即弃（MediaStream track.stop() + URL.revoke） |
| 录音 | 不落盘；仅在内存中持 blob；上传完成/超时立即释放 |
| 权限 | `/permissions` 既有路由追加 `nova.voice.microphone` 类型（与 nova.boot 同族）；用户显式授权 |
| 权限拒绝降级 | `error: 'NotAllowedError'` → toast.warn 显示 `nova.voice.asr.error.denied` 文案；UI 回退手动输入文本框 |
| 密钥 | 永不入库；key 配置走 `GOConfigStore`（沿用既有 IMConfigStore 模式；M4 单不落具体路径，只声明契约） |

---

## F9 · 电池预估 + 施工切分提案

### F9.1 切分（三笔制 + 终验）

| 笔 | 内容 | 文件清单（白名单） | 验收口径 |
|---|---|---|---|
| **①笔 纯逻辑 + 单测** | `electron/core/voice/` 5 新文件 + `tests/unit/voice/` 2 文件 | `electron/core/voice/types.ts`、`SpeechSynth.ts`、`SpeechStore.ts`、`VoiceRegistry.ts`、`index.ts`；`tests/unit/voice/speech.test.ts`、`store.test.ts` | 单测 ≥12 例全绿；vitest speech 1 file / ≥12 passed；既有 91/1083/8skip 维持 |
| **②笔 IPC 接线** | `electron/core/IpcServer.ts` + `electron/preload.ts` 各 append `nova:voice` 段（沿用 #004-B② 模式） | IpcServer append +29（`nova:voice:speak` / `nova:voice:cancel` handler + `NovaVoiceBridge` 字段 + setter/getter）；preload append +12（`NOVA_VOICE_SPEAK/CANCEL` 常量 + `voice.speak/cancel` 两方法，**boot 三方法零删零改**） | typecheck 0；既有 search 单测 28/28 仍绿；新增 voice 单测 12/12 仍绿 |
| **③笔 UI + i18n + e2e** | `src/views/Voice.vue` 新建 + `src/router/index.ts` append `/voice` 路由 1 行 + `src/locales/{zh-CN,en-US}.ts` append `nova.voice.*` 14 键 + `tests/e2e/nova-voice.e2e.test.ts` 新建 2 例 + `vitest.e2e.config.ts` append nova-voice 1 行 | Voice.vue 约 200–250 行（朗读/停止 + 三态 + rate/pitch/volume + 文本框）；locales 仅追加；router append-only；DEV-030 路径零触碰 | typecheck 0；e2e 13 + 2 = 15/15；vue-tsc 0；dev 冒烟 + 三态截图 |

**预期终态（#005-B 完结后）**：
- 电池：91 files + 2（voice 单测）= **93 files / 1083 + 20 + 12 = 1115 passed / 8 skipped (1123)**
- e2e：13 + 2 = **15/15**
- vue-tsc 0
- 截图：empty/speaking/error 三态（沿用 #004-B 5173 + 无桥桩路径 + DOM 断言 + vision 二选一）

**预估数字口径标签**：
- "原 91 files / 1083 passed / 8 skipped (1091) — 基线"
- "本单新增 voice 单测 12 例 + nova-voice e2e 2 例 → 终态 93 files / 1115 passed / 8 skipped (1123)"
- "口径以实跑对账为准，F9 已声明"

### F9.2 红线核查（每笔提交 message 内逐项自查）

- 零新 npm 依赖 ✓（speechSynthesis / getUserMedia 全为 Electron Chromium / Web 标准 API）
- Chat.vue / ChatManager / 安全确认链 / commandDecide / BashTool 零触碰 ✓
- locales append-only（boot 块零删零改）✓
- DEV-030 routes-render 路径零触碰 ✓
- AutoUpdater 修复（d24fd0e）零回退 ✓
- M1 七文件 + M2/M3 已收口文件零触碰 ✓
- 单笔提交电池状态明文（files/passed + typecheck + build）✓

---

## F11 · 实读 check list（#005-B 阶段必做，防纸上谈兵）

- [ ] 实读 `src/stores/orb.ts`（M1 既有四态确认，决定 F6.2 行动是 append 还是新建）
- [ ] 实读 `electron/core/IpcServer.ts` `nova:boot-skip` 段（#003-C② 已落）— 落 nova:voice:speak/cancel 时 append 在该段之后
- [ ] 实读 `electron/preload.ts:1242-1249` `nova` 对象三方法（notifyRendererReady / skip / onBootEvent）— boot 三方法零删零改硬约束核验
- [ ] 实读 `src/router/index.ts:62-72`（#004-B③ 已落 /search 路由对象）— `/voice` 路由 append 在 /search 与 /plugin-market 之间
- [ ] 实读 `src/locales/zh-CN.ts:528` `nova.boot` 块 — 验证 append-only 锚点
- [ ] 实读 `src/locales/en-US.ts:515` `nova.boot` 块 — 同步 zh-CN 锚点
- [ ] 实读 `src/components/AppSidebar*.vue`（侧栏组件）— F5 侧栏入口 A 方案落地实读
- [ ] 实读 `tests/e2e/helpers/electron-app.ts:63-69` PIPICLAW_E2E env 注入块 — F7.1 stub 落点核验
- [ ] 实跑 `where ffmpeg / where whisper`（确认本机 ASR 兜底二进制状态，已 16:48 实测零命中）

---

## F12 · 自检预演（防 #004-B / #004-C 类似弯路）

- **F12.1 数字必对账**：每笔提交 message 内 files/passed/typecheck/build 数字必须对账当次实跑（原 #004-B 估 "≈18" 实跑 28，#004-C "AutoUpdater 10/10" 实测初稿 static 守卫打红 5 例撤换 removeHandler）— 本单预估"voice 单测 ≥12"以实跑对账为准
- **F12.2 stub 触发条件锁面**：F7.1 stub 仅在 `PIPICLAW_E2E=1` 时生效；生产代码路径不允许读 module-level env 决定走 stub（沿用 #002-v3 DEV-013/014"绝不从参数读 source/contextKind"同族红线 — 模块态禁止）— `speechStore` 应接受显式 `ttsImpl?` 注入参数（与 searchStore.search(q, fetchImpl?) 同族 DI）
- **F12.3 自检过程备案**：F6.2 Orb store 实读后若发现四态假设不成立（例如实为二态），需重新裁定 append 行动（不得"顺手"删既有）— 一旦发现另行立前置小单（沿用 #004-D 收口说明）
- **F12.4 e2e PIPICLAW_E2E 边界**：测试中 stub 严格只在 `process.env.PIPICLAW_E2E === '1'` 时挂（沿用 #004-B nova-search.e2e 现有 stub 触发模式）

---

## F13 · 设计稿走查（参考 #004-A · 评审后走查要点）

- **F1** TTS 主方案成立前提 = T0-1 `speechSynthesisExists: true` + 真发声 `onstart: true` ✓
- **F2** 触发面默认 false + 朗读按钮 = (c)/voice 路由 + 朗读中再点 = cancel ✓
- **F3** ASR 推荐 c（M4 只做 TTS）— T0-3 实证零 Google 后端 + 本机零 whisper.cpp/ffmpeg，二者同源指向 ASR 不可达 MVP；推迟 W4 落地，记 DEV-033 ✓
- **F4** 录音蓝图保留，不实施（DEV-033 接管）✓
- **F5** UI 入口裁定 = (c)/voice 路由 + 侧栏 append 1 行；侧栏实读待 #005-B 阶段定 ✓
- **F6** Orb 联动 append 行动 + 优先级 TTS 不打断既有 ✓
- **F7** PIPICLAW_E2E stub 沿用 #004-B 模式；既有 91/1083/8skip 零影响 ✓
- **F8** 隐私：TTS 零依赖本地；ASR 蓝图 — 显式开关 + key + 不落盘 ✓
- **F9** 三笔制；预期 93 files / 1115 passed / 8 skipped (1123)；预估数字以实跑对账为准 ✓
- **红线** 零新依赖 / Chat.vue 零碰 / 安全链零碰 / DEV-030 零碰 / locales append-only ✓

---

## F14 · 复审抽验（按 G1–G5 + ROE 附录 F 段 ≥2 条 file:line）

> 本节对应 `Order #004-A` G 抽验（复审放行必跑）— 给设计稿自检必过项；正式 G 抽验由指挥层在 #005-A 复审令触发时执行。

| G | 命令 | 预期 |
|---|---|---|
| G1 | `wc -l docs/NOVA-#005-M4-voice-design.md` | 358 行 ± 5（与 #004-A 设计稿同量级） |
| G2 | `grep -nE "^#{1,3} " "${1}"` | F1–F14 章节骨架齐全 + F1–F10 主答卷在位 + F11/F12/F13/F14 实读+自查+走查章 |
| G3 | 关键 file:line 引用数 | ≥25 处（与 #004-A 同量级；#005-A 实读 12 处 + 蓝图 5 处 + 红线 8 处） |
| G4 | 章节结构 = F1–F10 + F11/F12/F13/F14 附录 | ✓ |
| G5 | T0 实证贴 + 答卷完整 | ✓ |
| **ROE F 段 ≥2 条** | 自查条目 | (1) `wc -l` G1 = 358 ± 5；(2) `grep -n "Chat.vue" docs/NOVA-#005-M4-voice-design.md` 命中处 = **零处**（仅作 "M1 七文件不碰" 描述引用） |

---

## F15 · 本稿红线条文（与首段红线基线一致，复审比对）

- 零新 npm 依赖（speechSynthesis / getUserMedia / SpeechRecognition 全为 Web 标准 API + Electron Chromium 内建）
- 不碰安全确认链 / commandDecide / ChatManager 既有逻辑（`nova.voice.*` 命名空间追加式）
- M1 七文件 + M2/M3 已收口文件不碰（locales 仅 append-only `nova.voice.*`）
- 文案 vue-i18n zh/en 1:1 同步 append-only
- DEV-030 在档未修、routes-render 断言路径不碰
- AutoUpdater 修复（d24fd0e）零回退
- Chat.vue M1 锁面物理禁改
- 密钥类文件永不入库
- **本单零生产代码改动 + 零测试文件改动**（设计稿单唯一落盘物 = 本 markdown）

---

> **本稿完成后预期提交链路**（复审放行后正式提交）：
> 1. 本文件 1 commit（设计稿单，零生产代码）
> 2. porcelain 终态 = 全空（除 `docs/NOVA-#005-M4-voice-design.md` 已 commit）
> 3. `#005-B` 施工令待下达（设计稿复审通过 + 三裁定与风险预置下达后方可启动）

---

## F16 · 设计稿签收回执位（复审留白）

> **指挥部签发（2026-10-20，#005-B①-R 取证后）**：
> G1 证据链：R1=425 行终态 / R2 无 amend 无前身 / R3 尾段 F16 留白无增量 —— 采信。
> G2 红线：零新依赖 / Chat.vue 零碰 / 安全链零碰 / locales 零改 / boot 三方法零改 —— ①笔通过。
> G3 白名单：设计 7 文件 → 交付 6（SpeechSynth.ts 并入 SpeechStore.ts）—— 追认；
>   b0bc879 message "7" 记数字错位，不 amend 修史，以本条 + DEV-036 归档。
> G4 电池锚点：93 files / 1106 passed / 8 skipped (1114)；e2e 13/13；vue-tsc 0；
>   终态预算 ②③ 合计 +9 单测，e2e +2 在 ③。
> G5 纪律：458/475 系推断错抄作废；DEV-036 三条自本笔生效。
> 结论：#005-B① HOLD 解除，准 ② 开工。
