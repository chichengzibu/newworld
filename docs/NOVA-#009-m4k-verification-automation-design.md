# NOVA #009 — M4-K 真机验证清单自动化（顺便挖出一个藏了一个月的 P0）

> **状态**：已实现（2026-11-09）
> **对应台账**：DEV-140 ~ DEV-143
> **分支**：`feat/harness-wiring`
> **前置**：[M4-G 实跑验证](NOVA-#009-m4g-runtime-verification-design.md) · [M4-H 面板渲染测试](NOVA-#009-m4h-panel-render-tests-design.md)

## 一、为什么做这件事

### 1.1 上一轮排的序，本轮接着走

M4-J（裁判校准）做完后的排序结论是：**人工/真机验证清单 > M4-E 接线 > 裁判校准**。
裁判层本来就关着、用户看不见；而"声称已支持"的东西有没有被验证，直接决定敢不敢发版。

### 1.2 `docs/VERIFICATION.md` 已经过期近三个月

它标注"最近更新: 2026-08-12"，D/E 段 10 项全是**人工肉眼确认**。
人工确认有两个硬伤：

- **不可回归** —— M4-H 的原话：「人工实跑确实抓到了问题(i18n 缺 key、flaky 断言)，
  但**人工截图不可回归**」
- **只覆盖看得见的** —— M4-G 自己的遗留 #4 写着「实跑只覆盖了首屏」

于是本批把 D/E 段逐条变成**自动化断言**，让"勾上"这件事有可复跑的证据。

---

## 二、做法

### 2.1 不新造轮子：复用仓库已有的 Playwright + Electron 设施

仓库本来就有 `tests/e2e/`（34 个 spec）与 `tests/e2e/helpers/electron-app.ts`。
本批只新增 3 个 spec，**不改既有 spec 的断言**：

| spec | 覆盖清单项 |
|---|---|
| `verification-checklist.spec.ts` | D1 D2 D3 D4 D6 E2（6 例） |
| `verification-chat-virtual.spec.ts` | D5（1 例，55 条消息 + 虚拟滚动） |
| `verification-proxy.spec.ts` | E1（1 例） |

### 2.2 每条断言都对着**用户能看到的东西**，不是内部实现

- **D1** 断的是「每个图标都有非空 aria-label/title」—— 这正是 M4-G 实跑抓到的真实缺陷
  （侧栏「搜索」「语音」没文案）。断言必须钉住它，而不是钉住"图标数 = 7"。
- **D2** 断的是「三枚窗口控制都可见**且有尺寸**」—— 只断"存在"会漏掉"被父容器裁掉"。
- **D3** 断的是「端口号是数字」+「running 时圆点的绿色分量显著大于红蓝」——
  状态类名写着 `is-running` 不等于它真的绿。
- **E2** 断的是「红屏兜底出现**且带着原始错误信息**」，不是"页面没白"。

### 2.3 D5 用仓库自带的 mock LLM

50+ 条消息若走真模型要几分钟；`scripts/mock-llm-server.mjs`（OpenAI 协议、瞬时返回）
让"消息条数"不再成为瓶颈。断言的关键是**虚拟滚动真的生效**：

```
DOM 里的 .message-outer 行数  <  store 里的总消息数
```

### 2.4 E1 不去改用户系统代理

改系统代理是**影响用户机器全局状态**的动作，忘了还原会连别的应用一起断网。
本批用**等效且更狠**的手段：给 Electron 传一个指向**死端口**的 `--proxy-server=http://127.0.0.1:9`
—— 等价于"系统代理开着且不可用"，而这正是最容易白屏的情形。

---

## 三、挖出来的东西

### 3.1 P0：Chat 虚拟列表（DEV-140）

**现象**：新用户点侧栏「新建」→ 整屏红框：

```
[PiPiClaw render error]
Me.getVirtualItems is not a function
```

红框是 `paintFatalError` 追加的 `position:fixed; inset:0; z-index:99999` 盒子 ——
应用还在下面，但被完全盖住。**用户看到的是"应用打不开"。**

**根因**：`useVirtualizer` 返回 `Ref<Virtualizer>`，不是实例。

| 访问位置 | 结果 |
|---|---|
| 模板 `virtualizer.getTotalSize()` | **没事** —— Vue 模板自动解包顶层 ref |
| 脚本 `virtualizer.getVirtualItems()` | **必炸** —— 脚本不解包 |

而 `virtualRows` 是个 `computed`，只在脚本里访问 → 一旦渲染消息列表就炸。

**为什么 typecheck 一直绿**：`300ddfa`（类型清零）加了 `as unknown as Virtualizer<...>`
—— 断言把类型错误一并吞了，而那次提交的注释还写着「运行期不劣于原实现」，
**这句话是错的**。教训：**断言能骗过 tsc，骗不过运行期**。

**为什么一个月没人发现**：缺陷自 `91a9093`（2026-10-09）引入，一直带在 master 上。
触发条件是「打开有消息的会话」—— 而所有实跑都只停在**首屏空状态**
（M4-G 遗留 #4 原文：「实跑只覆盖了首屏」）。

**修法**（三处一起）：

1. 脚本内改用 `virtualizer.value.getVirtualItems()` / `.measureElement()` / `.scrollToIndex()`
2. **删掉 `as unknown as Virtualizer` 断言** —— 让类型系统继续守这条线（vue-tsc 通过）
3. 顺手修掉原注释里的已知限制：`count` 之前是**初始长度快照**
   （options 是普通对象 → vue-virtual 只监听 options 的**对象引用**）→ 消息增减时
   count 不重算 → 新消息可能不渲染。正解是把整个 options 作为响应式源：
   `useVirtualizer(computed(() => ({...})))`

### 3.2 e2e 的 userData 隔离从未生效（DEV-141）

fixture 传了 `userDataDir` 给 `electron.launch()`，但 **Playwright 的 `_electron.launch()`
不支持这个选项**（只有 `launchPersistentContext` 有）→ 被**静默忽略** → 应用一直写真实
`%APPDATA%/pipiclaw`。后果：

- e2e 污染开发者真实数据（P0-T0.4「每次测试用全新 userData」从未生效）
- 测试互相污染：实测侧栏累积到 **192 个会话** → 一次渲染 192 项 → DOM 持续重渲染 →
  Playwright 动作性检查超时 → 「…」下拉菜单等交互点不动（popper 数恒为 0）

修法：显式传 `--user-data-dir=<临时目录>`。修好后 fresh profile 里 `conversations()` 返回空 —— 隔离真的生效了。

### 3.3 首次启动引导挡住整个界面（DEV-142）

4 步 el-dialog，`close-on-click-modal` / `close-on-press-escape` / `show-close` **全关** →
只能一步步走完；走完之前整个界面被遮罩挡住，任何点击都超时。
走完后弹的「欢迎使用 PiPiClaw!」toast **正好盖在侧栏「新建」按钮上**（见实跑截图）→
之后的点击被 toast 吃掉，表现为**随机失败**。

修法：共享 fixture 增加 `completeFirstLaunchGuide()`（走完 4 步 + 等 toast 消失）——
**34 个既有 e2e 全部受益**（它们此前得依赖被污染的 profile 才能跑通）。

### 3.4 已知边界：侧栏不响应外部会话变更（DEV-143）

通过 IPC `chat.createConversation` 建的会话，侧栏**不刷新**（store 只在挂载时拉一次 +
响应自己的 action）。本批让验证用例改走 UI「新建」按钮（与真实用户同一条路径），
产品侧这个行为**留作已知边界**，不在本批扩。

---

## 四、验证

| 项 | 结果 |
|---|---|
| e2e（D1 D2 D3 D4 D6 E2 + D5 + E1） | **8 passed** |
| F1 产物体积在预算内 | `node scripts/build-report.mjs --ci` → **EXIT=0** |
| F2 CSS 跌破 250KB 应 EXIT=1 | 人为砍到 200KB → **EXIT=1**，报错明确（`element-plus CSS = 195.3 KB < 250KB 下限`）→ 还原后复验 EXIT=0 |
| vue-tsc | **0**（且是**删掉断言之后**的 0） |
| 后端 tsc | 0 error |
| vitest | 130 files / 1516 passed / 0 FAIL |
| **既有 e2e 套件** | **79 passed / 51 failed** —— **与本批改动无关**（见下） |

### 4.1 既有 e2e 套件：如实说

全量跑既有 34 个 spec：**79 passed / 51 failed**（39.5 分钟）。

**基线对照**（这一步不能省）：把 fixture 改动 `git stash` 回退，用**同一批 5 个 spec**
再跑 → **14 failed / 26 passed**；恢复修复版 fixture 跑**同一批** → **14 failed / 26 passed**。
**数字完全一致 → 本批的 fixture 改动零回归。**

那 51 个失败是**既有问题**，两类：

1. **选择器过期** —— UI 改版后没跟上（`a.nav-item` × 14 → 现为 `nav-icon` × 7）
2. **老 spec 依赖"脏 profile"** —— 假设侧栏已有会话、首启引导已关过，
   在**真·干净 profile** 下自然不成立

本批不动它们（改动它们要逐个对齐新 UI 语义，不在本批范围）。
但**修复隔离后，这些失败从"被脏数据掩盖"变成"显式暴露"** ——
这本身就是本批的一个产出：**问题清单从隐性变成显性**。

---

## 五、遗留与后续

| # | 遗留 | 归属 | 说明 |
|---|---|---|---|
| 1 | **B 段 Sentry 真实上报（3 项）仍未验** | 需账号 | 需要真实 DSN —— 只能由用户提供。本机无 DSN 时 `scripts/sentry-verify.mjs` 只能验到 import 层 |
| 2 | **C 段 4 端出包（macOS/Linux/鸿蒙）仍未验** | 需对应机器 | 本机是 Windows，electron-builder 不支持交叉打 Linux 包；鸿蒙需独立工具链 + 真机签名 |
| 3 | **首屏之外仍有未实跑的界面** | 后续 | 本批覆盖了 Chat 视图（有消息的会话）+ 侧栏 + 标题栏。其余页面（Skills/Models/IM/Schedule/Settings/DevPanel 展开态）仍只过 typecheck + 组件测试 |
| 4 | 侧栏不响应外部会话变更 | 已知边界 | 见 DEV-143 |
| 5 | **既有 e2e 套件 51 个用例仍红**（涉 13 个 spec 文件） | 后续 | 选择器过期（UI 改版后没跟上）+ 老 spec 依赖脏 profile。**基线对照已证明与本批改动无关**；本批只做清单自动化，未动既有 spec。逐个对齐新 UI 语义是一整批工作量，建议单独开批 |

---

## 六、复跑命令

```bash
# 1) 构建(e2e 跑的是产物)
npm run build

# 2) 清单自动化
E2E_ELECTRON=1 npx playwright test \
  tests/e2e/verification-checklist.spec.ts \
  tests/e2e/verification-chat-virtual.spec.ts \
  tests/e2e/verification-proxy.spec.ts

# 3) 性能预算门禁(F1/F2)
node scripts/build-report.mjs --ci
```
