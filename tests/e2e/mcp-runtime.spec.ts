import { test, expect, shouldRunElectronE2E } from './helpers/electron-app'
import path from 'node:path'

/**
 * MCP 运行时端到端（M4-P）
 * ═══════════════════════════════════════════════════════════════════════
 * 【为什么补这个文件】
 * MCP 的**传输层**是通的(`scripts/mcp-filesystem-poc.mjs` 14/14 PASS),但那份 PoC
 * 有两处降级:Phase 2 跳过(「main.js 是 IIFE bundle,没法 import」)、
 * Phase 3 只 grep `dist-electron/main.js` 里有没有 McpManager 字样。
 * 也就是说 **「配置 → 启动 → 工具同步进 agent → 真调用」这条集成链从没端到端跑过**。
 * 路线图开篇写着「MCP 0%」—— 要么它过时了,要么它只是"看着在"。
 *
 * 【本文件断的是三件事】
 * ① 集成链真的通:起 server → 列工具 → 真调一次 → 拿到真实内容
 * ② **路径沙箱真的关得住**(M4-P 修的那条):默认白名单下够不着程序的工作目录,
 *    用户显式授权的目录之外一律拒绝
 * ③ 能停干净(不留孤儿进程)
 */

test.describe('MCP 运行时 · 端到端', () => {
  test.skip(!shouldRunElectronE2E, 'requires E2E_ELECTRON=1')

  const repoRoot = path.resolve(__dirname, '..', '..')

  /** 起一个 filesystem server(名字里带 filesystem → 走内置脚本 + 白名单那套) */
  async function startFilesystemServer(window: any, name: string, allowedPaths?: string[]) {
    return window.evaluate(async (cfg: any) => {
      const api = (window as any).electronAPI
      return api.mcp.startServer(cfg)
    }, {
      name,
      command: 'node',
      args: [],
      env: {},
      enabled: true,
      startupTimeoutMs: 20_000,
      callTimeoutMs: 20_000,
      ...(allowedPaths ? { allowedPaths } : {}),
    })
  }

  test('集成链通:启动 → 列工具 → 真调用 → 停服', async ({ window }) => {
    const serverName = 'e2e-filesystem-chain'
    // 授权一个真实目录,验证"授权后能用"
    const allowedDir = path.join(repoRoot, 'src', 'views')

    const started = await startFilesystemServer(window, serverName, [allowedDir])
    expect(started?.success, `MCP server 启动失败:${started?.error}`).toBe(true)
    expect(started.data.state, `server 状态不是 ready:${JSON.stringify(started.data)}`).toBe('ready')
    expect(started.data.toolCount, '工具数不对').toBe(5)

    try {
      // ② 列工具
      const listed = await window.evaluate(async () => (window as any).electronAPI.mcp.listTools())
      expect(listed?.success, `列工具失败:${listed?.error}`).toBe(true)
      expect(listed.data.length).toBe(5)
      const names = listed.data.map((t: any) => t.name)
      for (const expectName of ['list_directory', 'read_file', 'write_file', 'search_files', 'get_file_info']) {
        expect(names, `工具清单缺 ${expectName}`).toContain(expectName)
      }
      expect(listed.data.every((t: any) => t.server === serverName)).toBe(true)

      // ③ 真调用:相对路径按**授权目录**解析 → 应列出 src/views 的 .vue 文件
      const invoked = await window.evaluate(async (payload) => {
        const api = (window as any).electronAPI
        return api.mcp.invoke(payload)
      }, { server: serverName, toolName: 'list_directory', args: { path: '.' } })
      expect(invoked?.success, `调用失败:${invoked?.error}`).toBe(true)
      const text = JSON.stringify(invoked.data)
      expect(text, '调用结果为空').toContain('.vue')
      // 应是 src/views 的内容,而不是仓库根
      expect(text, '相对路径没按授权目录解析 —— 拿到了仓库根').not.toContain('node_modules')

      // 越界必须被拒(授权目录之外)
      const blocked = await window.evaluate(async (payload) => {
        const api = (window as any).electronAPI
        return api.mcp.invoke(payload)
      }, {
        server: serverName,
        toolName: 'read_file',
        args: { path: 'C:\\Windows\\System32\\drivers\\etc\\hosts' },
      })
      expect(blocked?.success, '越界访问竟然成功了 —— 沙箱失效!').toBe(false)
      expect(String(blocked?.error ?? '')).toMatch(/sandbox|outside|not under/i)
    } finally {
      const stopped = await window.evaluate(async (name) => {
        const api = (window as any).electronAPI
        return api.mcp.stopServer(name)
      }, serverName)
      expect(stopped?.success, '停服失败').toBe(true)
    }
  })

  test('默认白名单:够不着程序的工作目录(除非用户显式授权)', async ({ window }) => {
    const serverName = 'e2e-filesystem-default'
    // **不配 allowedPaths** → 走默认白名单
    const started = await startFilesystemServer(window, serverName)
    expect(started?.success, `MCP server 启动失败:${started?.error}`).toBe(true)

    try {
      // 读仓库根下的文件 → 必须被拒(默认白名单只含应用自己的沙箱目录)
      const repoFile = path.join(repoRoot, 'package.json')
      const blocked = await window.evaluate(async (payload) => {
        const api = (window as any).electronAPI
        return api.mcp.invoke(payload)
      }, {
        server: serverName,
        toolName: 'read_file',
        args: { path: repoFile },
      })
      expect(blocked?.success, '默认白名单下竟然读到了程序工作目录 —— 沙箱有洞').toBe(false)
      expect(String(blocked?.error ?? '')).toMatch(/sandbox|outside|not under/i)

      // 相对路径也解析不到工作目录(应落在沙箱目录里)
      const listed = await window.evaluate(async (payload) => {
        const api = (window as any).electronAPI
        return api.mcp.invoke(payload)
      }, { server: serverName, toolName: 'list_directory', args: { path: '.' } })
      if (listed?.success) {
        expect(JSON.stringify(listed.data), '相对路径落到了程序工作目录').not.toContain('node_modules')
      }
    } finally {
      await window.evaluate(async (name) => {
        const api = (window as any).electronAPI
        return api.mcp.stopServer(name)
      }, serverName)
    }
  })
})
