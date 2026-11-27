# NOVA #009 — M3-C 进程沙箱（不再留孤儿进程）

> **状态**：已实现（2026-10-29）
> **对应台账**：DEV-076 ~ DEV-080
> **分支**：`feat/harness-wiring`
> **路线图**：`docs/plan/v5-10week.md` M3 ——「沙箱起步：ProcessSandbox 接口 + Windows 平台分支（cgroup/Job Object）」
> **前置**：[M3-A 真向量](NOVA-#009-m3a-real-vectors-design.md) · [M3-B 混合检索](NOVA-#009-m3b-hybrid-retrieval-design.md)

## 一、为什么做这件事

### 1.1 实测出来的孤儿进程

路线图 M3 的另一半是「沙箱起步」。动手前先量了一下现状，发现一个具体问题：

```powershell
# 父进程起一个长跑子进程，然后父进程被杀
$p = Start-Process node -ArgumentList '-e','setTimeout(()=>{},60000)' -PassThru
# ... 杀掉父进程 ...
```

**实测结果：孙进程 PID 44896 依然在跑。**

原因很直接：`execFile` 超时/中止时，Node 只杀**直接子进程**。
它起的孙进程变成孤儿，继续吃 CPU、占端口、握着一份文件句柄。

对一个能在用户机器上跑命令的桌面助手，这不是边角情况：

| 场景 | 孤儿后果 |
|---|---|
| `npm install` 超时 | npm 死了，它起的 postinstall 子进程还在跑 |
| 脚本里 `start-server &` | 父进程死了，后台服务**永久驻留** |
| 用户点「停止」 | 只停住了最外层，内层照跑 |

### 1.2 「用户点停止」更是只停了 LLM

更隐蔽的一条：`LlmAgentBrain.abortRun()` 调的是 `controller.abort()`，
但那个 controller **只用于中止 LLM 流**。正在跑的命令完全感知不到中止信号：
它继续跑完（最长 60s），它起的孙进程继续跑（永久）。

用户看到的是「停了」，机器上却是「还在跑」。

## 二、设计依据

### 2.1 平台原生能力对照

| 平台 | 隔离原语 | Node 能否直接用 |
|---|---|---|
| Linux | cgroup v2 | 否（需原生模块或 systemd 辅助） |
| macOS | 无（只有 rlimit） | 部分（`ulimit` 需 shell 包装） |
| Windows | **Job Object**（`KILL_ON_JOB_CLOSE` 等） | 否（需 N-API 原生模块） |

### 2.2 为什么不用 Job Object

Job Object 能额外限制内存/CPU/进程数，是最完整的方案。但：

- 需要原生模块（N-API）→ electron-builder 打包时要为 Electron ABI 重编译
- 跨平台构建链（win/mac/linux/ohos）各自都要编译
- **本项目 package.json 零原生依赖** —— 这是刻意的取向

故本批落地**「不产生孤儿进程」这一最高价值的部分**，用零依赖的方式实现，
Job Object 的资源限额能力留作接口扩展位。

### 2.3 零依赖的等价实现

| 平台 | 实现 | 等价于 |
|---|---|---|
| POSIX | `detached: true`（子进程成为新进程组组长）+ `kill(-pgid)` | 进程组隔离 = cgroup 的「一起死」语义 |
| Windows | `taskkill /pid <pid> /T /F` | Job Object 的 `KILL_ON_JOB_CLOSE`（最后一个句柄关闭时全杀） |

`/T` 就是「连同子进程」—— 系统自带，语义等价。

## 三、实现

### 3.1 `electron/sandbox/ProcessSandbox.ts`

```ts
export type IsolationMode = 'process-group' | 'tree-kill' | 'none'

export async function runInSandbox(
  command: string, args: string[], opts: ProcessSandboxOptions = {},
): Promise<ProcessSandboxResult>
```

与 `execFile` 的差别：

| | execFile | ProcessSandbox |
|---|---|---|
| 超时/中止时 | 只杀直接子进程 | **杀整棵树** |
| 异常 | 抛 | 返回结构化结果（调用方自己记账） |
| 输出超限 | 抛错，输出全丢 | **截断并标注** |
| 中止信号 | 不支持 | 支持 `AbortSignal` |

### 3.2 中止信号一路贯通

```
brain.run 的 AbortController
  → toolCtx.signal          (RuntimeToolContext 新增可选字段)
  → BashTool.execute(args, ctx)
  → execCommand({..., signal})
  → doExecFile(..., signal)
  → runInSandbox(..., { signal })
```

用户点「停止」→ `abortRun` → `controller.abort()` → 命令订阅到 → 整棵树被杀。

**口径**：`signal` 是可选字段，不传就是「不可中止」（旧行为）。brain 一定会传。

### 3.3 审计口径不变

换执行器不动审计语义：

- 数组传参、不走 shell（v3 #9）
- 最小环境，不继承 parent 敏感 env
- 两段式审计：start 行 exec **前**同步写，写失败即拒（硬 fail-closed）
- finish 行写失败**不改判命令结果**，只标孤儿 + 真 `console.error`
- 新增：被杀时 finish 行记 `execError: killed:<原因>`

### 3.4 改动的既有测试

`tests/unit/trusted-dirs.test.ts` mock 了 `node:child_process`，但**只提供了 `execFile`**。
生产路径换成 `spawn` 后 → `spawn is not a function` → 该文件全红。

已补 `spawn` 的假实现（记录探针 + 返回假 ChildProcess，next tick 以 code 0 触发 close）。
这属于「mock 面必须跟随生产调用形态」—— 不是绕过测试，是让 mock 反映真实接口。

## 四、验证

| 项 | 基线 | 现在 |
|---|---|---|
| vitest | 114 files / 1367 passed | **115 files / 1379 passed / 0 FAIL** |
| 后端 typecheck | 29 error | **29 error（零新增）** |
| 前端 vue-tsc | 0 | **0** |

新增测试 `tests/unit/process-sandbox-m3c.test.ts`（12 例）：

- 正常退出 → 退出码 0 + stdout 正确
- 非零退出 → ok=false 且退出码正确
- stderr 被捕获
- 超时 → `killed=true` + `killReason='timeout'`
- 中止 → `killed=true` + `killReason='aborted'`
- **【核心回归钉】超时 → 整棵树被杀（孙进程不残留）** ——
  被沙箱跑的命令自己起长跑孙进程并把 pid 打到 stdout，超时后验那个 pid 还在不在
- 输出超限 → 截断并标注
- 命令不存在 → 报失败而不是抛异常
- cwd 生效
- isolation=none 逃生口
- **接线：BashTool 收到中止信号 → 命令被中止**（验信号一路传到执行层）
- 平台默认隔离方式正确

**核心回归钉的测法说明**：不能另起一个进程树来测 —— 那样验的不是被沙箱命令的树。
必须由**被沙箱跑的命令自己**起孙进程并把 pid 打到 stdout。

## 五、遗留与后续

| # | 遗留 | 归属 | 说明 |
|---|---|---|---|
| 1 | **Job Object 未做**（内存/CPU/进程数限额） | 后续 | 需原生模块，与本项目零原生依赖取向冲突。若要做，建议作为可选增强（检测到原生模块才启用），而非硬依赖 |
| 2 | **cgroup 未做**（Linux 资源限额） | 后续 | 同上；零依赖下 Linux 只能用 `ulimit` 走 shell 包装（会改变命令形态，需权衡） |
| 3 | **resourceLimits.ts 与本地进程无关** | 遗留澄清 | 它是 **Docker** sandbox 的限额配置（SandboxBuilder 用），不是本地进程的限额 —— 名字容易误解，本批未改其语义 |
| 4 | **并发上限未落到本地命令** | 后续 | `maxConcurrent: 3` 目前只约束 Docker sandbox。本地命令无并发闸 |
| 5 | **中止信号未接到旧 TaskExecutor 管道** | 后续 | 本批接的是 agent loop 路径（BashTool → commandDecide）。旧管道的 `TaskExecutor` 走另一条执行路径 |

## 六、参考资料

- Windows Job Objects —— `KILL_ON_JOB_CLOSE` 保证最后一个句柄关闭时全杀
- `taskkill /T` —— 系统自带的树杀语义
- POSIX `setsid` / 进程组 —— `kill(-pgid)` 杀整组
- Node `child_process.spawn` 的 `detached` 选项 —— POSIX 下调用 `setsid()`
