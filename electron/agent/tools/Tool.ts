/**
 * PiPiClaw - Agent 工具基础接口 (M1 v0.1)
 *
 * 跟 ClaudeCode 协议对齐: 每个 tool = { name, description, input_schema, execute() }.
 * 这是 In-process 的实现 (v0.1), 后续 M2 会拆到 MCP server 形式.
 */
import type { ToolMetadata } from '../AgentTypes'
import type { ContextKind } from './constants'

/** 工具执行结果 (与 ToolResult 不同: 这里只覆盖 {ok, result, error}, ToolResult 在 contracts/types 是 ok/data/error 命名) */
export interface ToolExecResult {
  ok: boolean
  /** 人类可读的结果内容,LLM 会读这个 */
  result: string
  /** 错误时填这个,LLM 也会读 */
  error?: string
}

/**
 * #005 Step 0 (DEV-014 机制切除): 工具执行上下文 — 显式贯穿, 禁模块态。
 * 链深: ChatManager → brain.think → brain.run → tool.execute, 逐跳携带, 无共享可变量;
 * 缺 ctx = 默认 headless (fail-safe 显式, 可 grep 审计)。
 * 预留 (本单不填值): runScope 字段供 DEV-023 审计关联接线批 (W5), 本单传 null。
 */
export interface RuntimeToolContext {
  /** 上下文类型 — 由已验证入口派生, 工具【绝不】从 LLM args 读 (v3 #4 红线保留) */
  contextKind: ContextKind
  /** 预留: run 溯源 (#006/#007 / DEV-023 接线批填值, 本单不读不写) */
  runScope?: { runId: string; parentRunId?: string } | null
}

/** 工具接口 */
export interface PiPiTool {
  /** ToolMetadata 用于注册到 ToolRegistry / 透传给 LLM */
  metadata: ToolMetadata
  /**
   * 真实执行, args 由 LLM tool_calls.function.arguments 解码得到.
   * @param ctx #005 Step 0: 可选执行上下文 (contextKind 显式贯穿); 缺省 = headless (fail-safe)
   */
  execute(args: Record<string, unknown>, ctx?: RuntimeToolContext): Promise<ToolExecResult>
}
