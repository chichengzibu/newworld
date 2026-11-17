/**
 * PiPiClaw — MCP 调用结果的口径测试（M4-P）
 * ═══════════════════════════════════════════════════════════════════════
 * 【为什么要有这个文件】
 * MCP 有**两层错误**:
 *   ① JSON-RPC error     —— 协议级(方法不存在、参数非法)
 *   ② 工具级 `isError`  —— MCP 约定:工具执行失败时**返回正常响应** + isError:true
 *      (路径沙箱拒绝、文件不存在、权限不足都属于这一类)
 *
 * 原实现只查了 ① → **②被当成成功**:`success:true`,错误文本藏在 content 里。
 * 后果不是"日志不好看":设置页的「测试」按钮会显示成功,
 * **LLM 也会以为这次工具调用成功了** —— agent 可能据此告诉用户"已完成",
 * 而文件根本没读到(沙箱拒绝了)。
 *
 * 本测试钉住:工具级失败必须**以失败返回**,错误文本要能被调用方/LLM 读到。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const invokeByName = vi.fn()

vi.mock('../../electron/mcp/McpManager', () => ({
  McpManager: {
    getInstance: () => ({ invokeByName }),
  },
}))

describe('M4-P MCP 工具级错误(isError)的口径', () => {
  beforeEach(() => {
    vi.resetModules()
    invokeByName.mockReset()
  })

  it('工具返回 isError:true → 适配层必须报失败(不能当成成功)', async () => {
    invokeByName.mockResolvedValue({
      success: false,
      error: 'Tool error: path outside sandbox: D:\\secret.txt not under any of [C:\\app\\sandbox]',
    })
    const { adaptMcpTool } = await import('../../electron/agent/McpToolAdapter')
    const tool = adaptMcpTool({
      name: 'read_file',
      description: '读文件',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      server: 'fs',
    } as never)

    const res = await tool.execute({ path: 'D:\\secret.txt' } as never)
    expect(res.ok, '沙箱拒绝被当成了成功 —— LLM 会据此说"已完成"').toBe(false)
    expect(String(res.error)).toMatch(/sandbox/i)
  })

  it('工具正常返回 → 适配层把 content 拼成给 LLM 看的文本', async () => {
    invokeByName.mockResolvedValue({
      success: true,
      result: { content: [{ type: 'text', text: '文件内容' }] },
    })
    const { adaptMcpTool } = await import('../../electron/agent/McpToolAdapter')
    const tool = adaptMcpTool({
      name: 'read_file',
      description: '读文件',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      server: 'fs',
    } as never)

    const res = await tool.execute({ path: 'a.txt' } as never)
    expect(res.ok).toBe(true)
    expect(res.result).toContain('文件内容')
  })
})
