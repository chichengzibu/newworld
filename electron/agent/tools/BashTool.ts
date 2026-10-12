/**
 * PiPiClaw - BashTool (M1 v0.1 + #002-v3)
 *
 * 跑命令, 跟 ClaudeCode Bash tool 协议对齐:
 *   args: { command: string, args?: string[], cwd?: string, timeout_ms?: number }
 *   result: { ok, result: "exit=N\nstdout=...\nstderr=...", error? }
 *
 * 安全:
 *   - 三层决策 (AUTO/CONFIRM/其余拒) + 确认 + 审计 全收敛到 commandDecide.execCommand()
 *   - 本文件只保留: 元数据 + execute() 入口 → 调 execCommand (咽喉点单点强制)
 *   - contextKind 来自模块态 (getCommandContext), 脑链路默认 headless (裁决 #4)
 *   - 防御 shell metacharacter: 由 commandDecide 保留执行
 *   - 防安全反转 (v3 红线): 绝不读 LLM 生成的 contextKind —— 一律走模块态
 */
import { execCommand, getCommandContext } from './commandDecide'
import type { PiPiTool, ToolExecResult } from './Tool'

export const BashToolMetadata = {
  name: 'Bash',
  description: '跑命令 (走 execFile + 三层决策, 不走 shell). command 是 baseCmd (如 git/node/python), args 是参数数组. cwd 必须在 sandbox/workspace 内. timeout 默认 30s 上限 60s. 自动级命令直接执行, 确认级需人工审批.',
  parametersJson: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的可执行文件 (如 git, node, python), 自动/确认名单内' },
      args: { type: 'array', items: { type: 'string' }, description: '参数数组, 按字面量传给 execFile, 不走 shell 解析' },
      cwd: { type: 'string', description: '工作目录, 必须在 sandbox/workspace 内' },
      timeout_ms: { type: 'number', description: '超时毫秒, 默认 30000, 上限 60000' },
    },
    required: ['command'],
  },
  requiresPermission: true, // 跑命令需要权限
  domain: 'agent.tools',
}

export class BashTool implements PiPiTool {
  metadata = BashToolMetadata

  async execute(args: Record<string, unknown>): Promise<ToolExecResult> {
    const command = String(args.command ?? '').trim()
    const rawArgs = Array.isArray(args.args) ? (args.args as unknown[]) : []
    const cwd = args.cwd ? String(args.cwd) : undefined
    const timeoutMs = args.timeout_ms !== undefined ? Math.min(Math.max(Number(args.timeout_ms) || 30000, 1000), 60000) : undefined

    if (!command) return { ok: false, result: '', error: 'command 必填' }

    // v3 #3 咽喉点 + 裁决 #4: contextKind 来自模块态, 绝不从 LLM args 读 (防安全反转)
    const r = await execCommand({
      command,
      args: rawArgs.map((a, i) => typeof a === 'string' ? a : String((a as any)?.toString?.() ?? a)),
      cwd,
      timeoutMs,
      contextKind: getCommandContext(),
    })

    if (r.ok) {
      const out = r.stdout
      const err = r.stderr
      return {
        ok: true,
        result: `exit=${r.exitCode}\nstdout=${out.length > 4000 ? out.slice(0, 4000) + '\n...[truncated]' : out}${err ? `\nstderr=${err.slice(0, 1000)}` : ''}`,
      }
    }
    return {
      ok: false,
      result: '',
      error: r.denied ? (r.denialReason ?? 'denied') : (r.denialReason ?? `exit=${r.exitCode}${r.stderr ? `\nstderr=${r.stderr.slice(0, 1000)}` : ''}`),
    }
  }
}
