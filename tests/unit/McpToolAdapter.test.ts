/**
 * New World - MCP 工具适配器测试 (M3-A)
 *
 * 【为什么这些断言重要】
 * MCP 工具接进 LLM 工具表,意味着第三方 server 提供的 schema 会直接
 * 出现在 function calling 里。适配层出错的后果:
 *   - 命名冲突 → LLM 调错工具
 *   - schema 丢失 → 模型瞎编参数
 *   - 结果转换错 → LLM 读到 "[object Object]"
 *   - 同名覆盖 → 第三方 server 顶掉核心内置工具
 * 这些都是用户直接感知的,必须有测试。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

describe('M3-A McpToolAdapter', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  describe('命名', () => {
    it('加 server 前缀,避免跨 server 重名', async () => {
      const { mcpToolName } = await import('../../electron/agent/McpToolAdapter')
      expect(mcpToolName('github', 'create_issue')).toBe('github__create_issue')
      expect(mcpToolName('fs', 'read')).toBe('fs__read')
    })

    it('可逆向还原 server 与 tool', async () => {
      const { parseMcpToolName } = await import('../../electron/agent/McpToolAdapter')
      expect(parseMcpToolName('github__create_issue')).toEqual({
        server: 'github', tool: 'create_issue',
      })
    })

    it('非法名返回 null 而不抛错', async () => {
      const { parseMcpToolName } = await import('../../electron/agent/McpToolAdapter')
      expect(parseMcpToolName('no_separator')).toBeNull()
      expect(parseMcpToolName('__leading')).toBeNull()
      expect(parseMcpToolName('trailing__')).toBeNull()
      expect(parseMcpToolName('')).toBeNull()
    })

    it('用双下划线而非冒号 —— 部分 provider 不允许 function name 含冒号', async () => {
      const { mcpToolName, MCP_NAME_SEPARATOR } = await import('../../electron/agent/McpToolAdapter')
      expect(MCP_NAME_SEPARATOR).toBe('__')
      expect(mcpToolName('a', 'b')).not.toContain(':')
    })
  })

  describe('schema 适配', () => {
    it('inputSchema 完整透传为 parametersJson', async () => {
      const { adaptMcpTool } = await import('../../electron/agent/McpToolAdapter')
      const t = adaptMcpTool({
        server: 'github', name: 'create_issue',
        description: '创建一个 issue',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: '标题' },
            body: { type: 'string' },
          },
          required: ['title'],
        },
      })
      expect(t.metadata.name).toBe('github__create_issue')
      const p = t.metadata.parametersJson as Record<string, unknown>
      expect(p.type).toBe('object')
      expect(p.required).toEqual(['title'])
      expect((p.properties as Record<string, unknown>).title).toBeDefined()
    })

    it('缺 schema 时兜底为 object', async () => {
      const { adaptMcpTool } = await import('../../electron/agent/McpToolAdapter')
      const t = adaptMcpTool({
        server: 'x', name: 'y', description: '',
        inputSchema: { type: 'object' },
      })
      expect(t.metadata.parametersJson.type).toBe('object')
    })

    it('缺 description 时补一个可读文案', async () => {
      const { adaptMcpTool } = await import('../../electron/agent/McpToolAdapter')
      const t = adaptMcpTool({
        server: 'x', name: 'y', description: '',
        inputSchema: { type: 'object' },
      })
      expect(t.metadata.description).toContain('x')
      expect(t.metadata.description).toContain('y')
    })
  })

  describe('权限语义', () => {
    it('MCP 工具一律标记 requiresPermission —— 来源不可控', async () => {
      const { adaptMcpTool } = await import('../../electron/agent/McpToolAdapter')
      const t = adaptMcpTool({
        server: 'thirdparty', name: 'do_anything',
        description: '', inputSchema: { type: 'object' },
      })
      expect(t.metadata.requiresPermission).toBe(true)
    })
  })

  describe('注册策略:内置优先', () => {
    it('同名时跳过 MCP 版本,保留内置工具', async () => {
      const { syncMcpTools } = await import('../../electron/agent/McpToolAdapter')
      const tools = new Map<string, any>()
      const builtin = { metadata: { name: 'Read', description: '内置 Read', parametersJson: {}, requiresPermission: false } }
      tools.set('Read', builtin)

      const mcpRead = { metadata: { name: 'Read', description: 'MCP Read', parametersJson: {}, requiresPermission: true } }
      const res = syncMcpTools(tools, [mcpRead as never, { metadata: { name: 'gh__x' } } as never])

      expect(res.skipped).toContain('Read')
      expect(res.added).toContain('gh__x')
      // 关键:内置工具没被顶掉
      expect(tools.get('Read')!.metadata.description).toBe('内置 Read')
    })

    it('不重复名时正常加入', async () => {
      const { syncMcpTools } = await import('../../electron/agent/McpToolAdapter')
      const tools = new Map<string, any>()
      const res = syncMcpTools(tools, [
        { metadata: { name: 'gh__a' } } as never,
        { metadata: { name: 'gh__b' } } as never,
      ])
      expect(res.added).toHaveLength(2)
      expect(tools.size).toBe(2)
    })
  })

  describe('执行与结果转换', () => {
    it('MCP 返回的 content 数组转成 LLM 可读文本', async () => {
      const { adaptMcpTool } = await import('../../electron/agent/McpToolAdapter')
      const { McpManager } = await import('../../electron/mcp/McpManager')
      vi.spyOn(McpManager.getInstance(), 'invokeByName').mockResolvedValue({
        success: true,
        result: { content: [{ type: 'text', text: 'issue #42 已创建' }] },
      } as never)

      const t = adaptMcpTool({
        server: 'gh', name: 'create_issue',
        description: '', inputSchema: { type: 'object' },
      })
      const r = await t.execute({ title: 'x' })
      expect(r.ok).toBe(true)
      expect(r.result).toBe('issue #42 已创建')
    })

    it('多个 content 块用换行拼接', async () => {
      const { adaptMcpTool } = await import('../../electron/agent/McpToolAdapter')
      const { McpManager } = await import('../../electron/mcp/McpManager')
      vi.spyOn(McpManager.getInstance(), 'invokeByName').mockResolvedValue({
        success: true,
        result: { content: [{ type: 'text', text: '第一行' }, { type: 'text', text: '第二行' }] },
      } as never)

      const t = adaptMcpTool({
        server: 'gh', name: 'x', description: '', inputSchema: { type: 'object' },
      })
      const r = await t.execute({})
      expect(r.result).toContain('第一行')
      expect(r.result).toContain('第二行')
    })

    it('非 text 类型转 JSON —— 不能丢信息', async () => {
      const { adaptMcpTool } = await import('../../electron/agent/McpToolAdapter')
      const { McpManager } = await import('../../electron/mcp/McpManager')
      vi.spyOn(McpManager.getInstance(), 'invokeByName').mockResolvedValue({
        success: true,
        result: { content: [{ type: 'resource', uri: 'file:///x' }] },
      } as never)

      const t = adaptMcpTool({
        server: 'gh', name: 'x', description: '', inputSchema: { type: 'object' },
      })
      const r = await t.execute({})
      expect(r.result).toContain('file:///x')
    })

    it('MCP 报错 → ok:false,不抛异常', async () => {
      const { adaptMcpTool } = await import('../../electron/agent/McpToolAdapter')
      const { McpManager } = await import('../../electron/mcp/McpManager')
      vi.spyOn(McpManager.getInstance(), 'invokeByName').mockResolvedValue({
        success: false, error: "server not ready",
      } as never)

      const t = adaptMcpTool({
        server: 'gh', name: 'x', description: '', inputSchema: { type: 'object' },
      })
      const r = await t.execute({})
      expect(r.ok).toBe(false)
      expect(r.error).toContain('server not ready')
    })

    it('invoke 抛异常 → 转成 ok:false,不炸穿 tool loop', async () => {
      const { adaptMcpTool } = await import('../../electron/agent/McpToolAdapter')
      const { McpManager } = await import('../../electron/mcp/McpManager')
      vi.spyOn(McpManager.getInstance(), 'invokeByName').mockRejectedValue(new Error('EPIPE'))

      const t = adaptMcpTool({
        server: 'gh', name: 'x', description: '', inputSchema: { type: 'object' },
      })
      const r = await t.execute({})
      expect(r.ok).toBe(false)
      expect(r.error).toContain('EPIPE')
    })

    it('空结果给占位而非空串(LLM 需要知道"确实没有内容")', async () => {
      const { adaptMcpTool } = await import('../../electron/agent/McpToolAdapter')
      const { McpManager } = await import('../../electron/mcp/McpManager')
      vi.spyOn(McpManager.getInstance(), 'invokeByName').mockResolvedValue({
        success: true, result: { content: [] },
      } as never)

      const t = adaptMcpTool({
        server: 'gh', name: 'x', description: '', inputSchema: { type: 'object' },
      })
      const r = await t.execute({})
      expect(r.ok).toBe(true)
      expect(r.result.length).toBeGreaterThan(0)
    })
  })

  describe('列举', () => {
    it('无 MCP server 时返回空数组,不抛错', async () => {
      const { listMcpTools } = await import('../../electron/agent/McpToolAdapter')
      const tools = await listMcpTools()
      expect(Array.isArray(tools)).toBe(true)
    })
  })
})