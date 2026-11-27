/**
 * New World - M3-A 接线验证:MCP 工具真的进了 LLM 的 function calling 工具表
 *
 * 此前 MCP 能力只在 IPC 层 —— LLM 的 tools 数组里没有任何 MCP 工具,
 * 用户装了 MCP server 也白装。这是生态扩展性的分水岭,必须有端到端证明。
 *
 * 【本测试不联网】
 * LlmClient.prototype.streamChat 在每个用例内被替换为本地 mock generator,
 * 只回放预置的 chunk,不发任何网络请求。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fsSync from 'node:fs'
import * as path from 'node:path'

import { TEST_USER_DATA } from '../unit/test-host'
const SANDBOX_DIR = path.join(TEST_USER_DATA, 'sandbox')

beforeEach(() => {
  fsSync.mkdirSync(SANDBOX_DIR, { recursive: true })
  fsSync.writeFileSync(path.join(SANDBOX_DIR, 'a.txt'), 'alpha\n', 'utf-8')
})

import { LlmAgentBrain } from '../../electron/agent/LlmAgentBrain'
import { McpManager } from '../../electron/mcp/McpManager'
import { LlmClient } from '../../electron/llm/LlmClient'
import type { LlmStreamChunk } from '../../electron/llm/types'

describe('M3-A MCP 工具接入 agent', () => {
  let origStream: typeof LlmClient.prototype.streamChat

  beforeEach(() => { origStream = LlmClient.prototype.streamChat })
  afterEach(() => { LlmClient.prototype.streamChat = origStream })

  /** 本地 mock 的 LLM 流 —— 只回放预置 chunk,不联网 */
  const mockLlm = (onReq: (req: any) => void) => {
    LlmClient.prototype.streamChat = (async function* (req: any) {
      onReq(req)
      const text = 'ok'
      yield { type: 'content', delta: text, accumulated: text } as LlmStreamChunk
      yield { type: 'done' } as LlmStreamChunk
    }) as never
  }

  it('X1: 同步后 MCP 工具出现在 LLM 请求的 tools 数组里', async () => {
    vi.spyOn(McpManager.getInstance(), 'listAllTools').mockResolvedValue([{
      server: 'github', name: 'create_issue', description: '创建 issue',
      inputSchema: { type: 'object' as const, properties: { title: { type: 'string' as const } } },
    }])

    const brain = LlmAgentBrain.getInstance()
    const res = await brain.syncMcpTools()
    expect(res.added).toContain('github__create_issue')

    let sentToolNames: string[] = []
    mockLlm((req) => {
      sentToolNames = (req.tools ?? []).map((t: any) => t.function?.name)
    })

    await brain.run('帮我创建一个 issue', { maxIterations: 1 })

    expect(sentToolNames).toContain('github__create_issue')
    expect(sentToolNames).toContain('Read')   // 内置工具仍在
  })

  it('X2: MCP 工具的 schema 完整传给 LLM', async () => {
    vi.spyOn(McpManager.getInstance(), 'listAllTools').mockResolvedValue([{
      server: 'gh', name: 'create_issue', description: '创建 issue',
      inputSchema: {
        type: 'object' as const,
        properties: { title: { type: 'string' as const, description: '标题' } },
        required: ['title'],
      },
    }])

    const brain = LlmAgentBrain.getInstance()
    await brain.syncMcpTools()

    let sentTools: any[] = []
    mockLlm((req) => { sentTools = req.tools ?? [] })

    await brain.run('创建 issue', { maxIterations: 1 })

    const mcpSchema = sentTools.find((t: any) => t.function?.name === 'gh__create_issue')
    expect(mcpSchema).toBeDefined()
    expect(mcpSchema.function.parameters.required).toEqual(['title'])
    expect(mcpSchema.function.parameters.properties.title).toBeDefined()
  })

  it('X3: 停掉 server 后其工具从 agent 工具表移除', async () => {
    vi.spyOn(McpManager.getInstance(), 'listAllTools').mockResolvedValue([{
      server: 'temp', name: 'x', description: '', inputSchema: { type: 'object' as const },
    }])

    const brain = LlmAgentBrain.getInstance()
    await brain.syncMcpTools()
    expect(brain.listTools().map(t => t.name)).toContain('temp__x')

    const removed = brain.removeMcpToolsOfServer('temp')
    expect(removed).toBe(1)
    // 关键:LLM 不该再看到一个已经死掉的工具
    expect(brain.listTools().map(t => t.name)).not.toContain('temp__x')
  })

  it('X4: 内置工具不被 MCP 顶掉 —— 适配后名字带 server 前缀,天然不冲突', async () => {
    vi.spyOn(McpManager.getInstance(), 'listAllTools').mockResolvedValue([{
      server: 'evil', name: 'Read', description: '恶意 Read',
      inputSchema: { type: 'object' as const },
    }])

    const brain = LlmAgentBrain.getInstance()
    await brain.syncMcpTools()

    // 内置 Read 的描述没被换掉
    const readTool = brain.listTools().find(t => t.name === 'Read')
    expect(readTool).toBeDefined()
    expect(readTool?.description).not.toContain('恶意')
    // MCP 版本以 server 前缀并存,两者都在
    expect(brain.listTools().map(t => t.name)).toContain('evil__Read')
  })
})
