/**
 * PiPiClaw - 命令咽喉点 (v3 #3 单点强制 + 四颗审计钉子 + 两段式审计)
 *
 * 单点强制 (v3 #3):
 *   BashTool.execute() 与 OpenClawGateway.runCommand() 都调用 execCommand()。
 *   禁止任何调用点自行复制决策/确认/审计逻辑。入口层只负责派生 contextKind 后调用。
 *
 * contextKind (v3 #4 + 裁决 #4):
 *   必填字段, 由入口派生 (ui / im_inbound / scheduler / headless), 随调用传入 execCommand。
 *   安全红线: contextKind 绝不从 LLM 生成的 tool args 里读 —— LLM 可自我放行 = 安全反转。
 *   脑链路经模块态 setCommandContext('headless') 贯穿 (fail-safe 默认, 见下)。
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
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { BrowserWindow, ipcMain } from 'electron'
import { getHost } from '../../platform/runtime'
import {
  decideCommand,
  contextAllowsConfirm,
  type ContextKind,
} from './constants'

const execFileAsync = promisify(execFile)
const AUDIT_DIR = 'audit'
const AUDIT_FILE = 'openclaw.audit.jsonl'
const CONFIRM_TIMEOUT_MS = 30_000

// ── contextKind 模块态贯穿 (裁决 #4; 脑链路默认 headless, 入口可覆盖) ──
let _ctx: ContextKind = 'headless'
export function setCommandContext(kind: ContextKind): void { _ctx = kind }
export function getCommandContext(): ContextKind { return _ctx }

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
export interface ConfirmRequest { opId: string; command: string; args: string[]; cwd?: string }
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
function isCwdInSandbox(resolvedCwd: string): boolean {
  try {
    const userDataReal = fs.realpathSync(getHost().getPath('userData'))
    const sandboxRoot = path.join(userDataReal, 'sandbox')
    const workspaceRoot = path.join(userDataReal, 'workspace')
    const real = fs.realpathSync(resolvedCwd)
    const norm = (p: string) => path.normalize(p).toLowerCase() + path.sep
    return real.toLowerCase().startsWith(norm(sandboxRoot)) ||
           real.toLowerCase().startsWith(norm(workspaceRoot)) ||
           real.toLowerCase() === sandboxRoot.toLowerCase() ||
           real.toLowerCase() === workspaceRoot.toLowerCase()
  } catch {
    return false
  }
}

export interface CommandExecArgs {
  command: string
  args?: string[]
  cwd?: string
  timeoutMs?: number
  /** contextKind (v3 #4 + 裁决 #4): 必填, 由入口派生, 绝不从 LLM args 读 */
  contextKind: ContextKind
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
    const approved = await (_transport ?? defaultBrowserConfirm)({ opId, command: baseCmdRaw, args: cmdArgs, cwd: args.cwd })
    if (!approved) {
      const reason = '用户拒绝或 30s 超时 (confirm 未通过)'
      writeDenyRow(opId, norm, cmdArgs, args.cwd ?? '', reason, ctx, 'false', 'ui-reject/timeout')
      return { ok: false, opId, stdout: '', stderr: '', exitCode: null, denied: true, denialReason: reason, humanConfirm: 'false' }
    }
    return doExecFile(opId, baseCmdRaw, norm, cmdArgs, args.cwd, timeoutMs, ctx, 'true')
  }

  // AUTO
  return doExecFile(opId, baseCmdRaw, norm, cmdArgs, args.cwd, timeoutMs, ctx, 'not-required')
}

/** exec 路径 (auto 通过 / confirm ui 批准): v3 #9 防护 → 两段式审计 (fail-closed) → execFile */
async function doExecFile(
  opId: string, baseCmdRaw: string, norm: string, cmdArgs: string[],
  cwdIn: string | undefined, timeoutMs: number, ctx: ContextKind, humanConfirm: 'true' | 'false' | 'not-required',
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

  // v3 #9: sandbox cwd 防护保留
  let resolvedCwd: string
  if (cwdIn) {
    resolvedCwd = path.resolve(cwdIn)
    if (!isCwdInSandbox(resolvedCwd)) {
      const reason = `cwd 必须在 sandbox/workspace 内, 实际: ${resolvedCwd}`
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

  // execFile (v3 #9: 数组传参, 不走 shell)
  try {
    const { stdout, stderr } = await execFileAsync(baseCmdRaw, cmdArgs, {
      cwd: resolvedCwd,
      timeout: timeoutMs,
      windowsHide: true,
      // 最小环境, 不继承 parent 敏感 env (原 BashTool 安全姿态保留)
      env: { PATH: process.env.PATH ?? '', SYSTEMROOT: process.env.SYSTEMROOT ?? '', USERPROFILE: process.env.USERPROFILE ?? '' },
      maxBuffer: 1024 * 1024,
    })
    // 钉子[phase 配对 + 分段失败② + 升级 b 真 warn]: 真实 exit; finish 写失败不改判命令, 记真 console.error + 标孤儿
    try {
      auditAppendSync({ opId, baseCmd: norm, exit: 0, phase: 'finish', contextKind: ctx })
    } catch (finErr: any) {
      console.error(`[audit] finish-row write failed for opId=${opId} (baseCmd=${norm}): ${finErr?.message ?? finErr}. This opId is now ORPHAN (start has no finish). Command result NOT affected.`)
    }
    return { ok: true, opId, stdout: (stdout ?? '').toString(), stderr: (stderr ?? '').toString(), exitCode: 0, denied: false, humanConfirm }
  } catch (e: any) {
    const exitCode: number = typeof e.status === 'number' ? e.status : (e.killed ? -1 : -1)
    try {
      auditAppendSync({ opId, baseCmd: norm, exit: exitCode, phase: 'finish', contextKind: ctx, execError: e.message })
    } catch (finErr: any) {
      console.error(`[audit] finish-row write failed for opId=${opId} (baseCmd=${norm}): ${finErr?.message ?? finErr}. This opId is now ORPHAN (start has no finish). Command result NOT affected.`)
    }
    return {
      ok: false, opId,
      stdout: (e.stdout ?? '').toString(), stderr: (e.stderr ?? '').toString(),
      exitCode, denied: false,
      denialReason: `exit=${exitCode}`, humanConfirm,
    }
  }
}
