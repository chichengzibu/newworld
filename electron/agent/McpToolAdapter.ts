/**
 * PiPiClaw - MCP 工具适配器 (M3-A)
 *
 * 【要解决的缺口】
 * McpManager 是完整可用的子系统(stdio transport / JSON-RPC 2.0 / tools/list
 * 缓存 / invoke / 重名检测,1105 行),但它只挂在 IPC 层 —— 渲染进程能调,
 * **LLM 调不到任何 MCP 工具**。
 *
 * 后果: 用户装了 GitHub MCP server,PiPiClaw 的 agent 依然不知道有这个
 * 能力存在。生态扩展性为零 —— 装了也白装。
 *
 * 【做法】
 * 把 MCP tool 适配成标准的 PiPiTool,注册进 LlmAgentBrain 的工具表。
 * 这样:
 *   - LLM 通过同一套 function calling 感知 MCP 能力
 *   - ToolGate 的权限门对 MCP 工具同样生效(不因来源不同而豁免)
 *   - 工具调用轨迹同样出现在 UI 上
 *
 * 【命名】
 * MCP 的 tool 名在不同 server 间可能重名(McpManager 已有 ambiguous 检测)。
 * 适配时统一加 `server__tool` 前缀 —— 用双下划线而非冒号,因为冒号在
 * 部分 provider 的 function name 校验里不合法。
 */
import { LogManager } from '../core/LogManager'
import { McpManager } from '../mcp/McpManager'
import type { McpTool } from '../mcp/types'
import type { PiPiTool, ToolExecResult, RuntimeToolContext } from './tools/Tool'

const log = LogManager.getInstance()

/** MCP 工具名前缀分隔符 —— 双下划线,避开冒号在 function name 里的兼容问题 */
export const MCP_NAME_SEPARATOR = '__'

/** 生成适配后的工具名:`server__tool` */
export function mcpToolName(server: string, tool: string): string {
  return `${server}${MCP_NAME_SEPARATOR}${tool}`
}

/** 从适配名还原 server / tool */
export function parseMcpToolName(qualified: string): { server: string; tool: string } | null {
  const idx = qualified.indexOf(MCP_NAME_SEPARATOR)
  if (idx <= 0 || idx + MCP_NAME_SEPARATOR.length >= qualified.length) return null
  return {
    server: qualified.slice(0, idx),
    tool: qualified.slice(idx + MCP_NAME_SEPARATOR.length),
  }
}

/**
 * MCP 的 inputSchema → 我们的 parametersJson。
 * MCP 用 JSON Schema,与 LLM function calling 的 parameters 兼容,直接透传。
 */
function toParametersJson(schema: McpTool['inputSchema']): Record<string, unknown> {
  return {
    type: schema?.type ?? 'object',
    ...(schema?.properties ? { properties: schema.properties } : {}),
    ...(schema?.required ? { required: schema.required } : {}),
    ...(schema?.additionalProperties !== undefined
      ? { additionalProperties: schema.additionalProperties }
      : {}),
  }
}

/**
 * 把一个 MCP tool 包装成 PiPiTool。
 *
 * 权限语义:MCP 工具一律 'confirm' —— 来源不可控(第三方 server 可能做
 * 任何事),不能因为"是 MCP 的"就默认信任。但 ToolGate 的层级判定会
 * 先看 metadata.requiresPermission,再落到 ToolGate 的默认档位表。
 */
export function adaptMcpTool(mcpTool: McpTool & { server: string }): PiPiTool {
  const qualified = mcpToolName(mcpTool.server, mcpTool.name)
  return {
    metadata: {
      name: qualified,
      description: mcpTool.description || `MCP 工具 ${mcpTool.name}(来自 ${mcpTool.server})`,
      parametersJson: toParametersJson(mcpTool.inputSchema),
      // MCP 工具来源不可控 → 需要确认
      requiresPermission: true,
    } as never,
    async execute(
      args: Record<string, unknown>,
      _ctx?: RuntimeToolContext,
    ): Promise<ToolExecResult> {
      try {
        const res = await McpManager.getInstance().invokeByName(qualified, args)
        if (!res?.success) {
          return { ok: false, result: '', error: res?.error ?? `MCP 调用失败:${qualified}` }
        }
        // 把 MCP 的 content 数组转成 LLM 能读的文本
        const text = (res.result?.content ?? [])
          .map((c: { type?: string; text?: string }) => {
            if (c?.type === 'text') return c.text ?? ''
            return JSON.stringify(c)
          })
          .join('\n')
        return { ok: true, result: text || '(空结果)' }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        log.warn(`McpToolAdapter: ${qualified} 执行异常 — ${msg}`)
        return { ok: false, result: '', error: msg }
      }
    },
  }
}

/**
 * 把当前所有 ready 的 MCP server 的工具适配成 PiPiTool 列表。
 *
 * 每次调用都重新拉取 —— MCP server 可以在运行期启停/换工具,
 * 缓存会过期。列表通常很小(几十个),开销可忽略。
 */
export async function listMcpTools(): Promise<PiPiTool[]> {
  try {
    const tools = await McpManager.getInstance().listAllTools()
    return tools.map(adaptMcpTool)
  } catch (e) {
    log.warn(`McpToolAdapter: 列举 MCP 工具失败 — ${e instanceof Error ? e.message : e}`)
    return []
  }
}

/**
 * 把 MCP 工具同步进 agent 的工具表。
 *
 * 幂等:同名工具会被替换(MCP 工具优先,盖掉同名内置工具 ——
 * 内置工具是本项目核心能力,不该被第三方 server 意外覆盖;
 * 故实际策略是【内置优先】,MCP 同名工具跳过并记日志)。
 */
export function syncMcpTools(agentTools: Map<string, PiPiTool>, mcpTools: PiPiTool[]): {
  added: string[]
  skipped: string[]
} {
  const added: string[] = []
  const skipped: string[] = []
  for (const t of mcpTools) {
    if (agentTools.has(t.metadata.name)) {
      skipped.push(t.metadata.name)
      continue
    }
    agentTools.set(t.metadata.name, t)
    added.push(t.metadata.name)
  }
  if (skipped.length > 0) {
    log.info(`McpToolAdapter: ${skipped.length} 个 MCP 工具与内置工具同名,已跳过(内置优先)`)
  }
  return { added, skipped }
}
