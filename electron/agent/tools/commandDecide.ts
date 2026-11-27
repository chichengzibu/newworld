/**
 * New World - 命令咽喉点 (v3 #3 单点强制 + 四颗审计钉子 + 两段式审计)
 *
 * 单点强制 (v3 #3):
 *   BashTool.execute() 与 OpenClawGateway.runCommand() 都调用 execCommand()。
 *   禁止任何调用点自行复制决策/确认/审计逻辑。入口层只负责派生 contextKind 后调用。
 *
 * contextKind (v3 #4 + 裁决 #4):
 *   必填字段, 由入口派生 (ui / im_inbound / scheduler / headless), 随调用传入 execCommand。
 *   安全红线: contextKind 绝不从 LLM 生成的 tool args 里读 —— LLM 可自我放行 = 安全反转。
 *   脑链路 contextKind 经显式参数贯穿 (think→run→execute(ctx), #005 Step 0), 缺省 headless (fail-safe, 见下)。
 *
 * 四颗审计钉子 (v3 #6 + GLM 预审 #1):
 *   [哨兵 pending]  exec 路径 start 行 exit='pending' 表"未终态"; 消费方禁当 exit=0。
 *   [phase 配对]    exec 记录 = start(phase:'start') + finish(phase:'finish') 同 opId;
 *                   或单行 deny(phase:'deny')。禁止两 start/两 finish/交错。
 *   [孤儿可检测]    有 start 无 finish = 孤儿 (start 写成功但进程崩 / finish 写失败), 可被扫描计数。
 *   [分段失败语义]  start 段写失败 = 命令拒 (硬 fail-closed, execFile 不跑, audit-unavailable);
 *                   finish 段写失败 = 命令结果照常返回 (命令已跑), 只记真 warn + 标孤儿。
 *
 * 升级 b (GLM 裁定): finish 段写失败的 warn 必须是真代码 (console.error), 不是注释。
 *
 * 残留风险 (v3 #8): 单行/两段式审计均可被删改 (文件在 userData, 同用户可写); 根治 = Windows 沙箱 P2。
 * 头注释 (v3 #6): audit 文件内 args 可能含敏感参数 (如 -e 代码 / 路径), 读取者当敏感处理。
 *
 * 注意: 本文件 import electron (BrowserWindow/ipcMain 用于默认确认弹窗)。
 *   纯决策逻辑在 constants.ts, 可独立测试; 本文件的 exec/audit/confirm 由测试文件 mock。
 */
import { runInSandbox } from '../../sandbox/ProcessSandbox'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { BrowserWindow, ipcMain } from 'electron'
import { getHost } from '../../platform/runtime'
import {
  decideCommand,
  contextAllowsConfirm,
  type ContextKind,
} from './constants'
import { ConfigStore } from '../../core/ConfigStore'
import { guardCommandNetwork, type NetworkVerdict } from './CommandNetworkGuard'
import { ProcessLimiter } from '../../sandbox/ProcessLimiter'
import { ApprovalGate } from '../../sandbox/ApprovalGate'
import { LogManager } from '../../core/LogManager'

const AUDIT_DIR = 'audit'
const AUDIT_FILE = 'openclaw.audit.jsonl'
const CONFIRM_TIMEOUT_MS = 30_000

// ── #005 Step 0 (DEV-014 机制切除): contextKind 模块态三件 (let _ctx / setCommandContext / getCommandContext) 已删除 ──
// 显式贯穿链: 入口 (ChatManager.dispatchToAgent 派生) → think(ctx.contextKind) → run(opts.contextKind) → tool.execute(ctx) → execCommand(contextKind)。
// 缺省面: BashTool 侧 `ctx?.contextKind ?? 'headless'` (fail-safe)。
// 零读者证实 (切除前 grep 实证): 生产面读者面唯一 = BashTool (已改显式); 测试面零读者。
// gateway 轨 (OpenClawGateway.runCommand/executeOperation) 本就参数制 (source 第二参), 不受影响。

// ── 审计路径 ──
function auditFile(): string {
  return path.join(getHost().getPath('userData'), AUDIT_DIR, AUDIT_FILE)
}

// ── 审计 sink (依赖注入, 测试可替换为 fail-closed 探针) ──
export type AuditSink = (entry: Record<string, unknown>) => void
let _sink: AuditSink = (entry) => {
  const file = auditFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', 'utf8')
}
/** 测试用: 注入自定义审计 sink (null = 恢复默认) */
export function setAuditSink(sink: AuditSink | null): void {
  _sink = sink ?? ((entry) => {
    const file = auditFile()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', 'utf8')
  })
}

/** 同步追加一行审计; 写失败则 throw (供 fail-closed 使用)。 */
function auditAppendSync(entry: Record<string, unknown>): void {
  _sink(entry)
}

/** deny/拒绝路径落一行 (fire-and-forget; 写失败不阻塞拒绝, 只记真 warn)。 */
function writeDenyRow(opId: string, baseCmd: string, args: string[], cwd: string, reason: string, kind: ContextKind, humanConfirm: 'true' | 'false' | 'not-required', confirmChannel: string = '-'): void {
  try {
    auditAppendSync({
      opId, baseCmd, args, cwd,
      exit: null, denied: true, denialReason: reason,
      humanConfirm, confirmChannel, contextKind: kind, phase: 'deny',
    })
  } catch (e: any) {
    // 升级 b: 真 warn (不是注释) — 但拒绝已是安全结果, 不改判
    console.error(`[audit] deny-row write failed for opId=${opId} (baseCmd=${baseCmd}): ${e?.message ?? e}`)
  }
}

/** MCP 调用审计窄项 (裁决 #1-MCP-窄项): 复用同一 sink, fail-closed (写失败则 throw, 调用方据此失败)。 */
export function mcpCallAudit(server: string, tool: string, argKeys: string[]): void {
  const opId = `mcp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  // 权限矩阵仍归 W4, 本条仅审计, 不加权限判断
  auditAppendSync({
    opId,
    baseCmd: 'mcp:call',
    args: `${server}/${tool}`,
    cwd: null,
    mcpServer: server, mcpTool: tool, mcpArgKeys: argKeys,
    exit: null, denied: false, denialReason: null,
    humanConfirm: 'not-required', confirmChannel: 'mcp', contextKind: 'headless', phase: 'record',
  })
}

// ── 确认弹窗 (升级 a: 可注入测试 stub) ──
export interface ConfirmRequest {
  opId: string
  command: string
  args: string[]
  cwd?: string
  /**
   * 【M4.9】网络越界提示 —— 命令本身在 AUTO 档，但它要访问白名单外的域名。
   * 渲染层应把这条信息显著展示给用户（不是普通确认，是"数据可能外传"的提醒）。
   */
  networkWarning?: string
}
export type ConfirmTransport = (req: ConfirmRequest) => Promise<boolean>
let _transport: ConfirmTransport | null = null
/** 测试用: 注入自定义确认传输 (null = 恢复默认浏览器弹窗)。 */
export function setConfirmTransport(t: ConfirmTransport | null): void { _transport = t }

const pending = new Map<string, (ok: boolean) => void>()
let replyHandlerInstalled = false
function ensureReplyHandler(): void {
  if (replyHandlerInstalled) return
  replyHandlerInstalled = true
  ;(ipcMain as any).on('command:confirm-reply', (_e: unknown, payload: { opId: string; ok: boolean }) => {
    const cb = pending.get(payload.opId)
    if (cb) { cb(payload.ok); pending.delete(payload.opId) }
  })
}

function defaultBrowserConfirm(req: ConfirmRequest): Promise<boolean> {
  const BW = BrowserWindow as any
  // 无窗 / 无 getAllWindows (如测试 mock) → 无人在场 → 拒
  if (typeof BW?.getAllWindows !== 'function') return Promise.resolve(false)
  const win = BW.getAllWindows().find((w: any) => !w.isDestroyed?.() && w.isVisible?.() && !w.isMinimized?.())
  if (!win) return Promise.resolve(false)
  ensureReplyHandler()
  return new Promise((resolve) => {
    const timer = setTimeout(() => { pending.delete(req.opId); resolve(false) }, CONFIRM_TIMEOUT_MS)
    pending.set(req.opId, (ok: boolean) => { clearTimeout(timer); resolve(ok) })
    try { win.webContents.send('command:confirm-request', req) } catch { resolve(false) }
  })
}

// ── sandbox (v3 #9 保留; 原 BashTool/Gateway 共享逻辑) ──
/**
 * 判断 cwd 是否落在允许执行的目录内。
 *
 * 【M4.9 修两处真实缺陷】
 *
 * ① **目录不同源**：旧实现只认 `userData/sandbox` 与 `userData/workspace`（单数），
 *    但 `WorkspaceManager` 实际把工作区建在 `userData/sandboxes`（**复数**）。
 *    后果：D2-Prime 脚手架生成的项目、以及沙箱模板落盘的文件，
 *    在它们自己的目录里**一条命令都执行不了** —— 前缀匹配不上，直接 deny。
 *    修法：两个单复数目录都认。
 *
 * ② **realpath 失败即拒绝，过严**：旧实现整个函数包在 try/catch 里，
 *    `realpathSync` 对不存在的目录会抛错 → 直接 false。
 *    但调用方常在命令执行前才 mkdir，cwd 可能刚被创建还没同步到磁盘视图，
 *    或落在网络盘/挂载点上。结果是**合法目录被误拒**。
 *    修法：realpath 失败时降级为 path.resolve 的词法路径比较，
 *    同时保留「父目录 realpath」的二级校验以防 symlink 逃逸。
 */
function isCwdInSandbox(resolvedCwd: string): boolean {
  const userData = getHost().getPath('userData')
  const roots = ['sandbox', 'sandboxes', 'workspace', 'workspaces'].map((d) => path.join(userData, d))

  // 优先用 realpath 比较（防 symlink 逃逸）；realpath 不可用时降级词法比较
  const resolveSafe = (p: string): string => {
    try {
      return fs.realpathSync(p)
    } catch {
      try {
        // 目录还不存在：realpath 父目录再拼回尾段，仍能挡住 symlink 逃逸
        const parent = path.dirname(p)
        if (parent !== p) return path.join(fs.realpathSync(parent), path.basename(p))
      } catch {
        /* 父目录也取不到，走词法 */
      }
      return path.resolve(p)
    }
  }

  const real = resolveSafe(resolvedCwd)
  const normReal = real.replace(/[\\/]+$/, '').toLowerCase()

  for (const root of roots) {
    const normRoot = resolveSafe(root).replace(/[\\/]+$/, '').toLowerCase()
    if (normReal === normRoot) return true
    if (normReal.startsWith(normRoot + path.sep.toLowerCase())) return true
    if (normReal.startsWith(normRoot + '/')) return true
  }
  return false
}

// ── #005 D6 (可信目录联动, 触达面×授权级别解耦) ───────────────────────────
//
// 诚实条款 (裁决 #2 / DEV-022 同款):
//   ① 可信目录即「信任授予」—— 配置方须谨慎, **勿添加主目录/祖先目录** (如 C:\Users\, ~/)
//   ② symlink 逃逸: 本函数**不做 realpath 解析** (词法归一 + 前缀匹配); 若 trusted 目录
//      内被建 symlink 指向外部, 仍可能触达外部文件 —— 预留 DEV-025, 本单不实施。
//   ③ args 路径穿越: 不解析 args 里的 ../ ; trusted 扩的是 **cwd 触达面**, args 行为
//      由具体命令自行处理 (e.g. `cat ../.ssh/id_rsa` 由 cat 处理, 仍会被 secrets guard 拦)。
//
// 解耦钉子 (本设计核心):
//   可信目录只扩 **cwd 可触达面** (触达面层); **不**改授权级别 (AUTO/CONFIRM/其余 名单逻辑零改)。
//   D6-4 硬断言: trusted 内确认级命令 (e.g. git) + headless ctx → denial 含 "仅 ui 放行"
//   (授权级别拒), **不是** "cwd 必须在..." (触达面拒)。
//
// 实现: 与 sandbox 同文件 (commandDecide.ts), 同词法归一 (path.resolve + win32 大小写折叠);
// 与 isCwdInSandbox 的唯一区别是 "trusted 列表" 来源 (ConfigStore 键, 测试探针可替换)。
/** ConfigStore 键 (裁决 #4: 复用 ConfigStore, 不新加文件) */
const TRUSTED_DIRS_KEY = 'agent.trusted-dirs'

/** #005 D6 (裁决 #2 + #4): 读可信目录名单 (ConfigStore 键 → string[]; 缺键=[]) */
export function configGetTrustedDirs(): string[] {
  try {
    const v = ConfigStore.getInstance().get(TRUSTED_DIRS_KEY)
    return Array.isArray(v) ? (v as string[]).map(s => (typeof s === 'string' ? s : String(s))) : []
  } catch {
    return []
  }
}

/** #005 D6 测试探针 (同 setAuditSink / setConfirmTransport 模式): 替换 trusted 目录列表 */
let _testTrustedDirs: string[] | null = null
export function setTrustedDirsForTest(dirs: string[] | null): void { _testTrustedDirs = dirs }

/** 供测试断言的当前 trusted 目录 (测试探针优先; 否则 ConfigStore) */
export function getTrustedDirsForTest(): string[] {
  return _testTrustedDirs !== null ? _testTrustedDirs : configGetTrustedDirs()
}

/**
 * #005 D6: 判断 resolvedCwd 是否落在可信目录内 (或可信目录自身)。
 * - 词法归一: path.resolve + lowercase (win32 大小写折叠); 前缀 = 可信目录 + path.sep
 * - 不做 realpath (DEV-025 预留); 不做 symlink 解析
 * - 非绝对路径的可信目录条目: 归一后 (相对当前 CWD) 不参与比较 (path.resolve 会基于进程 CWD)
 * - 默认 [] / 全空 → 恒 false (与 sandbox 行为对齐, D6-1 零回归)
 */
export function isCwdInTrustedDir(resolvedCwd: string): boolean {
  if (!resolvedCwd) return false
  const dirs = getTrustedDirsForTest()
  if (dirs.length === 0) return false
  const norm = (p: string) => {
    const r = path.resolve(p).toLowerCase()
    return r.endsWith(path.sep.toLowerCase()) ? r : r + path.sep.toLowerCase()
  }
  const target = path.resolve(resolvedCwd).toLowerCase()
  for (const d of dirs) {
    if (typeof d !== 'string' || d.length === 0) continue
    const dNorm = norm(d)
    if (target === dNorm.slice(0, -1) || target.startsWith(dNorm)) return true
  }
  return false
}

export interface CommandExecArgs {
  command: string
  args?: string[]
  cwd?: string
  timeoutMs?: number
  /** contextKind (v3 #4 + 裁决 #4): 必填, 由入口派生, 绝不从 LLM args 读 */
  contextKind: ContextKind
  /** 【M3-C】中止信号 —— 用户点「停止」时整棵进程树被杀 */
  signal?: AbortSignal
}

export interface CommandExecResult {
  ok: boolean
  opId: string
  stdout: string
  stderr: string
  exitCode: number | null
  denied: boolean
  denialReason?: string
  humanConfirm: 'true' | 'false' | 'not-required'
}

function newOpId(): string {
  return `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 咽喉点 (v3 #3 + 四钉子): 决策 → 确认(仅 ui) → 审计(两段式) → execFile。
 * 顺序: decideCommand → [deny:deny行+拒] → [confirm:非ui拒/ui弹窗] → sandbox/metachar/nullbyte → [start fail-closed] → execFile → [finish warn]
 */
export async function execCommand(args: CommandExecArgs): Promise<CommandExecResult> {
  const opId = newOpId()
  const baseCmdRaw = String(args.command ?? '').trim()
  const cmdArgs = (Array.isArray(args.args) ? args.args : []).map(String)
  const ctx = args.contextKind
  const timeoutMs = Math.min(Math.max(Number(args.timeoutMs ?? 30000) || 30000, 1000), 60000)

  if (!baseCmdRaw) {
    writeDenyRow(opId, '', cmdArgs, '', 'command 必填', ctx, 'not-required')
    return { ok: false, opId, stdout: '', stderr: '', exitCode: null, denied: true, denialReason: 'command 必填', humanConfirm: 'not-required' }
  }

  // v3 #9: metachar 防护保留 (baseCmd 必须干净)
  if (/[\s;&|`$<>(){}\\]/.test(baseCmdRaw.toLowerCase())) {
    writeDenyRow(opId, baseCmdRaw, cmdArgs, args.cwd ?? '', 'command 含非法字符 (metachar)', ctx, 'not-required')
    return { ok: false, opId, stdout: '', stderr: '', exitCode: null, denied: true, denialReason: 'command 含非法字符 (metachar)', humanConfirm: 'not-required' }
  }

  const d = decideCommand(baseCmdRaw, cmdArgs)
  const norm = d.normalizedCmd

  // 【M4.9 Codex 式第一道闸门：沙箱档位预判】
  // read-only 档位下，写操作与命令执行直接拒绝（不需要问人，因为用户明确选了只读）
  const tierVerdict = ApprovalGate.getInstance().precheckByTier(baseCmdRaw, cmdArgs)
  if (tierVerdict?.kind === 'block') {
    writeDenyRow(opId, norm, cmdArgs, args.cwd ?? '', tierVerdict.reason, ctx, 'not-required', 'sandbox-tier')
    return { ok: false, opId, stdout: '', stderr: '', exitCode: null, denied: true, denialReason: tierVerdict.reason, humanConfirm: 'not-required' }
  }

  // DENY
  if (d.kind === 'deny') {
    writeDenyRow(opId, norm, cmdArgs, args.cwd ?? '', d.reason ?? 'denied', ctx, 'not-required')
    return { ok: false, opId, stdout: '', stderr: '', exitCode: null, denied: true, denialReason: d.reason ?? 'denied', humanConfirm: 'not-required' }
  }

  // CONFIRM (仅 ui 放行; 其余上下文拒)
  if (d.kind === 'confirm') {
    if (!contextAllowsConfirm(ctx)) {
      const reason = `context=${ctx} 不允许 confirm 级命令 (仅 ui 放行)`
      writeDenyRow(opId, norm, cmdArgs, args.cwd ?? '', reason, ctx, 'false', 'rejected-by-context')
      return { ok: false, opId, stdout: '', stderr: '', exitCode: null, denied: true, denialReason: reason, humanConfirm: 'false' }
    }

    /**
     * 【M4.9 Codex 式第二道闸门：自动审查子代理】
     *
     * 直接弹窗会带来「审批疲劳」—— 用户点几次同意后就无脑点，
     * 审批反而变成走过场。这里先用轻量模型判一次：
     *   · 低风险 → 自动放行，不打断
     *   · 高风险 / 判断不了 → 照常弹窗
     * 硬禁区（删库/格式化/提权/外传）在模型之前就被拦掉，永不自动放行。
     */
    const reviewed = await ApprovalGate.getInstance().autoReview(baseCmdRaw, cmdArgs, args.cwd)
    if (reviewed.kind === 'block') {
      writeDenyRow(opId, norm, cmdArgs, args.cwd ?? '', reviewed.reason, ctx, 'not-required', 'auto-review-deny')
      return { ok: false, opId, stdout: '', stderr: '', exitCode: null, denied: true, denialReason: reviewed.reason, humanConfirm: 'not-required' }
    }
    if (reviewed.kind === 'auto-allow') {
      // 注意：不在这里写审计行 —— doExecFile 内部会写 start 行，
      // 这里再写会产生同一 opId 两条 start，违反「phase 配对」不变量。
      // 自动放行的可回溯性由日志承载（用户可在应用日志里查到）。
      LogManager.getInstance().info(
        `[ApprovalGate] 自动放行 opId=${opId} cmd=${norm}: ${reviewed.reason}`,
      )
      return doExecFile(opId, baseCmdRaw, norm, cmdArgs, args.cwd, timeoutMs, ctx, 'not-required', args.signal)
    }

    const approved = await (_transport ?? defaultBrowserConfirm)({ opId, command: baseCmdRaw, args: cmdArgs, cwd: args.cwd })
    if (!approved) {
      const reason = '用户拒绝或 30s 超时 (confirm 未通过)'
      writeDenyRow(opId, norm, cmdArgs, args.cwd ?? '', reason, ctx, 'false', 'ui-reject/timeout')
      return { ok: false, opId, stdout: '', stderr: '', exitCode: null, denied: true, denialReason: reason, humanConfirm: 'false' }
    }
    return doExecFile(opId, baseCmdRaw, norm, cmdArgs, args.cwd, timeoutMs, ctx, 'true', args.signal)
  }

  // AUTO
  // 【M4.9 第二层·网络出口管控】
  // 即使命令本身被判为 AUTO，也要看它要访问哪些域名。
  // 白名单外 → 不直接拒绝，而是**升级为需确认**（Codex 式「越界就问你」）：
  // 用户点一下就能用，不点就拦。这样既挡住数据外传，又不把正常命令一刀切。
  const netVerdict = guardCommandNetwork(baseCmdRaw, cmdArgs)
  if (netVerdict.kind === 'blocked') {
    const ok = await handleNetworkEscalation(opId, norm, cmdArgs, args.cwd, ctx, netVerdict, args.signal)
    return ok
  }

  return doExecFile(opId, baseCmdRaw, norm, cmdArgs, args.cwd, timeoutMs, ctx, 'not-required', args.signal)
}

/**
 * 网络白名单外的命令 → 升级为确认。
 *
 * 三种结局：
 *   · ui 上下文 + 用户批准 → 照常执行
 *   · ui 上下文 + 用户拒绝/超时 → 拒绝，审计写明「网络越界未批准」
 *   · 非 ui 上下文（IM / 定时任务 / headless）→ 直接拒绝（无人在场，不能替用户拍板）
 */
async function handleNetworkEscalation(
  opId: string,
  norm: string,
  cmdArgs: string[],
  cwdIn: string | undefined,
  ctx: ContextKind,
  verdict: Extract<NetworkVerdict, { kind: 'blocked' }>,
  signal?: AbortSignal,
): Promise<CommandExecResult> {
  const reason = verdict.reason
  const targetList = verdict.targets.map((t) => t.host).join(', ') || '(未识别到具体域名)'

  if (!contextAllowsConfirm(ctx)) {
    const full = `网络访问被拦截（context=${ctx} 无人在场，不能批准）：${reason}`
    writeDenyRow(opId, norm, cmdArgs, cwdIn ?? '', full, ctx, 'false', 'network-blocked-no-ui')
    return { ok: false, opId, stdout: '', stderr: '', exitCode: null, denied: true, denialReason: full, humanConfirm: 'false' }
  }

  const approved = await (_transport ?? defaultBrowserConfirm)({
    opId,
    command: norm,
    args: cmdArgs,
    cwd: cwdIn,
    networkWarning: `该命令将访问白名单外的网络目标：${targetList}`,
  })

  if (!approved) {
    const full = `用户拒绝或超时（网络越界未获批准）：${reason}`
    writeDenyRow(opId, norm, cmdArgs, cwdIn ?? '', full, ctx, 'false', 'network-escalation-rejected')
    return { ok: false, opId, stdout: '', stderr: '', exitCode: null, denied: true, denialReason: full, humanConfirm: 'false' }
  }

  return doExecFile(opId, norm, norm, cmdArgs, cwdIn, 30000, ctx, 'true', signal)
}

/** exec 路径 (auto 通过 / confirm ui 批准): v3 #9 防护 → 两段式审计 (fail-closed) → execFile */
async function doExecFile(
  opId: string, baseCmdRaw: string, norm: string, cmdArgs: string[],
  cwdIn: string | undefined, timeoutMs: number, ctx: ContextKind, humanConfirm: 'true' | 'false' | 'not-required',
  signal?: AbortSignal,
): Promise<CommandExecResult> {
  const confirmChannel = humanConfirm === 'true' ? 'ui' : '-'

  // v3 #9: args null-byte 防护保留
  for (let i = 0; i < cmdArgs.length; i++) {
    if (typeof cmdArgs[i] !== 'string' || cmdArgs[i].includes('\0')) {
      const reason = `args[${i}] 非法 (null byte / 非字符串)`
      writeDenyRow(opId, norm, cmdArgs, cwdIn ?? '', reason, ctx, humanConfirm)
      return { ok: false, opId, stdout: '', stderr: '', exitCode: null, denied: true, denialReason: reason, humanConfirm }
    }
  }

  // v3 #9: sandbox cwd 防护保留 + #005 D6 扩: sandbox ∪ trusted dirs (触达面只扩, 授权级别零改)
  let resolvedCwd: string
  if (cwdIn) {
    resolvedCwd = path.resolve(cwdIn)
    if (!isCwdInSandbox(resolvedCwd) && !isCwdInTrustedDir(resolvedCwd)) {
      const reason = `cwd 必须在 sandbox/workspace/可信目录内, 实际: ${resolvedCwd}`
      writeDenyRow(opId, norm, cmdArgs, resolvedCwd, reason, ctx, humanConfirm)
      return { ok: false, opId, stdout: '', stderr: '', exitCode: null, denied: true, denialReason: reason, humanConfirm }
    }
  } else {
    const sandboxRoot = path.join(getHost().getPath('userData'), 'sandbox')
    fs.mkdirSync(sandboxRoot, { recursive: true })
    resolvedCwd = sandboxRoot
  }

  // 钉子[分段失败① + 哨兵 + phase 配对]: start 行 execFile 前同步写, 写失败即拒 (硬 fail-closed)
  try {
    auditAppendSync({
      opId, baseCmd: norm, args: cmdArgs, cwd: resolvedCwd,
      exit: 'pending', denied: false, denialReason: null,
      humanConfirm, confirmChannel, contextKind: ctx, phase: 'start',
    })
  } catch (e: any) {
    return { ok: false, opId, stdout: '', stderr: '', exitCode: null, denied: true, denialReason: `audit-unavailable: ${e?.message ?? e}`, humanConfirm }
  }

  /**
   * 【M4.9 第三层·并发闸】
   * 同时执行的命令数上限（默认 3）。超限直接拒绝而不是排队 ——
   * 排队会让用户看到"点了没反应"，比明确拒绝更糟。
   */
  const limiter = ProcessLimiter.getInstance()
  const lease = limiter.acquire()
  if (!lease.ok) {
    const reason = lease.reason
    writeDenyRow(opId, norm, cmdArgs, resolvedCwd, reason, ctx, humanConfirm)
    return { ok: false, opId, stdout: '', stderr: '', exitCode: null, denied: true, denialReason: reason, humanConfirm }
  }

  /**
   * 【M3-C】执行走 ProcessSandbox(进程隔离),不再用 execFile。
   *
   * 【为什么换】execFile 超时/中止时只杀**直接子进程** —— 它起的孙进程
   * 会变成孤儿继续跑(实测:父进程被杀后 `node -e setTimeout(...)` 仍在运行)。
   * 对一个能在用户机器上跑命令的助手,这是实打实的资源泄漏。
   * ProcessSandbox 按平台分支杀整棵树:
   *   POSIX → 进程组(负 pid);Windows → taskkill /T /F
   *
   * 【口径不变】
   *   - 数组传参、不走 shell(v3 #9)
   *   - 最小环境,不继承 parent 敏感 env
   *   - 两段式审计:start 行 exec 前同步写,写失败即拒(硬 fail-closed)
   *   - finish 写失败**不改判命令结果**,只标孤儿 + 真 console.error
   */
  const result = await runInSandbox(baseCmdRaw, cmdArgs, {
    cwd: resolvedCwd,
    timeoutMs,
    env: { PATH: process.env.PATH ?? '', SYSTEMROOT: process.env.SYSTEMROOT ?? '', USERPROFILE: process.env.USERPROFILE ?? '' },
    maxBuffer: 1024 * 1024,
    // 【M3-C】中止信号 —— 用户点「停止」时整棵进程树被杀
    ...(signal ? { signal } : {}),
  }).finally(() => {
    // 【M4.9】无论成功失败都释放并发配额，否则配额会被泄漏吃光
    lease.release()
  })

  // 钉子[phase 配对 + 分段失败② + 升级 b 真 warn]: finish 写失败不改判命令结果
  try {
    auditAppendSync({
      opId, baseCmd: norm,
      exit: result.exitCode ?? (result.killed ? -1 : -1),
      phase: 'finish', contextKind: ctx,
      ...(result.killed ? { execError: `killed:${result.killReason}` } : {}),
    })
  } catch (finErr: any) {
    console.error(`[audit] finish-row write failed for opId=${opId} (baseCmd=${norm}): ${finErr?.message ?? finErr}. This opId is now ORPHAN (start has no finish). Command result NOT affected.`)
  }

  if (result.ok) {
    return { ok: true, opId, stdout: result.stdout, stderr: result.stderr, exitCode: 0, denied: false, humanConfirm }
  }
  return {
    ok: false, opId,
    stdout: result.stdout, stderr: result.stderr,
    exitCode: result.exitCode ?? (result.killed ? -1 : -1), denied: false,
    denialReason: result.killed ? `killed:${result.killReason}` : `exit=${result.exitCode}`,
    humanConfirm,
  }
}
