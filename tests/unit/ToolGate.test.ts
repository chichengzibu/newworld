/**
 * PiPiClaw - ToolGate 权限门测试 (M2-B)
 *
 * 【安全边界,密集覆盖】
 * 这个门挡住的是"本地模型静默改掉用户文件"。任何一条断言变红,
 * 都意味着安全洞重新打开 —— 所以覆盖必须穷举,包括看起来绕的路径。
 *
 * 核心原则(fail-safe):
 *   - 拿不准 → 拒绝
 *   - 没人在场 → 拒绝
 *   - 没接确认桥 → 拒绝
 *   - 确认桥崩了 → 拒绝
 * 只有明确 auto 的只读操作才放行。
 */
import { describe, it, expect, vi } from 'vitest'
import { ToolGate } from '../../electron/agent/ToolGate'
import type { PiPiTool, RuntimeToolContext } from '../../electron/agent/tools/Tool'

const mkTool = (name: string, requiresPermission = false, extra: Record<string, unknown> = {}): PiPiTool => ({
  metadata: { name, description: '', parametersJson: {}, requiresPermission, ...extra } as never,
  execute: async () => ({ ok: true, result: 'ok' }),
})

const UI: RuntimeToolContext = { contextKind: 'ui' }
const HEADLESS: RuntimeToolContext = { contextKind: 'headless' }

describe('ToolGate 权限门', () => {
  describe('1. 只读工具自动放行', () => {
    it.each(['Read', 'Glob', 'Grep'])('%s 无需确认直接放行', async (name) => {
      const d = await ToolGate.check(mkTool(name), {}, UI)
      expect(d.allowed).toBe(true)
      expect(d.permission).toBe('auto')
    })

    it('只读工具即便没有确认桥也放行', async () => {
      const d = await ToolGate.check(mkTool('Read'), { file_path: '/tmp/x' }, HEADLESS)
      expect(d.allowed).toBe(true)
    })
  })

  describe('2. 核心安全洞:EditTool 写文件必须确认', () => {
    it('requiresPermission:true 的工具在无确认桥时被拒绝', async () => {
      // 修复前: EditTool 直接写文件,零检查。这是本门存在的全部理由。
      const d = await ToolGate.check(mkTool('Edit', true), { file_path: '/tmp/a.txt' }, UI)
      expect(d.allowed).toBe(false)
      expect(d.reason).toContain('fail-safe')
    })

    it('headless 上下文一律拒绝 —— 不因为"没人在"就默认同意', async () => {
      const d = await ToolGate.check(
        mkTool('Edit', true), { file_path: '/tmp/a.txt' }, HEADLESS,
        { requestConfirmation: async () => true },   // 故意提供桥,验证 contextKind 才是决定因素
      )
      expect(d.allowed).toBe(false)
      expect(d.reason).toContain('无法弹窗')
    })

    it('用户确认后放行', async () => {
      const confirm = vi.fn().mockResolvedValue(true)
      const d = await ToolGate.check(mkTool('Edit', true), { file_path: '/tmp/a.txt' }, UI, { requestConfirmation: confirm })
      expect(d.allowed).toBe(true)
      expect(confirm).toHaveBeenCalledTimes(1)
    })

    it('用户拒绝则不放行', async () => {
      const d = await ToolGate.check(
        mkTool('Edit', true), { file_path: '/tmp/a.txt' }, UI,
        { requestConfirmation: async () => false },
      )
      expect(d.allowed).toBe(false)
      expect(d.reason).toContain('用户拒绝')
    })

    it('确认桥抛异常 → 拒绝(fail-safe)', async () => {
      const d = await ToolGate.check(
        mkTool('Edit', true), { file_path: '/tmp/a.txt' }, UI,
        { requestConfirmation: async () => { throw new Error('bridge down') } },
      )
      expect(d.allowed).toBe(false)
      expect(d.reason).toContain('fail-safe')
    })

    it('确认提示里包含目标路径 —— 用户得知道要改什么', async () => {
      const confirm = vi.fn().mockResolvedValue(true)
      await ToolGate.check(
        mkTool('Edit', true), { file_path: '/important/notes.md' }, UI,
        { requestConfirmation: confirm },
      )
      expect(confirm.mock.calls[0][1]).toContain('/important/notes.md')
    })
  })

  describe('3. 敏感路径硬拒 —— 即使用户点了确认', () => {
    it.each([
      ['~/.ssh/id_rsa', '/home/u/.ssh/id_rsa'],
      ['aws 凭据', '/home/u/.aws/credentials'],
      ['gnupg', '/home/u/.gnupg/secring.gpg'],
      ['Windows System32', 'C:/Windows/System32/config'],
      ['.env 文件', '/proj/.env'],
      ['pem 证书', '/certs/server.pem'],
      ['key 文件', '/certs/server.key'],
    ])('%s 一律 deny', async (_label, p) => {
      const d = await ToolGate.check(
        mkTool('Edit', true), { file_path: p }, UI,
        { requestConfirmation: async () => true },   // 即使用户点确认也拦
      )
      expect(d.allowed).toBe(false)
      expect(d.permission).toBe('deny')
    })

    it('普通路径不被误伤', async () => {
      const d = await ToolGate.check(
        mkTool('Edit', true), { file_path: '/tmp/project/src/index.ts' }, UI,
        { requestConfirmation: async () => true },
      )
      expect(d.allowed).toBe(true)
    })

    it('Bash 的危险命令参数也被路径规则拦下(rm -rf ~/.ssh)', async () => {
      const d = await ToolGate.check(
        mkTool('Bash'), { command: 'rm', args: ['-rf', '/home/u/.ssh'] }, UI,
        { requestConfirmation: async () => true },
      )
      expect(d.allowed).toBe(false)
    })
  })

  /**
   * 【M4-D】内置工具的档位必须与 ToolGate 的档位表一致。
   *
   * 【为什么需要这条用例】
   * ToolGate 的兜底是「未登记 → confirm」。这对陌生工具是对的(保守),
   * 但对**本项目的内置只读工具**是个陷阱:
   *   新增一个只读工具 → metadata.requiresPermission=false →
   *   但没在 DEFAULT_PERMISSIONS 登记 → 静默变成 confirm →
   *   headless 场景直接被拒,UI 场景每次调用都弹确认框。
   *
   * 真实案例:load_skill(M4-A 新增)漏登记 → 「技能被应用」这件事在数据里
   * 根本不存在 —— M4-D 的整个信号源是空的。
   *
   * 本用例把「漏登记」从静默陷阱变成红灯。
   */
  describe('5. 内置工具档位与声明一致', () => {
    it('声明 requiresPermission=false 的内置工具,实际档位必须是 auto', async () => {
      const { BUILTIN_TOOLS } = await import('../../electron/agent/tools')
      const readOnly = BUILTIN_TOOLS.filter(t => t.metadata.requiresPermission === false)
      expect(readOnly.length).toBeGreaterThan(0)
      for (const tool of readOnly) {
        const d = await ToolGate.check(tool, {}, UI)
        expect(
          d.permission,
          `内置只读工具 ${tool.metadata.name} 未在 ToolGate 档位表登记 —— ` +
          `实际档位 ${d.permission},会导致 headless 被拒 / UI 每次弹确认框`,
        ).toBe('auto')
      }
    })

    it('声明 requiresPermission=true 的内置工具,实际档位必须是 confirm', async () => {
      const { BUILTIN_TOOLS } = await import('../../electron/agent/tools')
      for (const tool of BUILTIN_TOOLS.filter(t => t.metadata.requiresPermission === true)) {
        const d = await ToolGate.check(tool, {}, UI)
        expect(d.permission, `内置工具 ${tool.metadata.name} 的档位应至少为 confirm`).not.toBe('auto')
      }
    })
  })

  describe('4. 未知工具默认保守', () => {
    it('未在白名单内的工具默认按 confirm 处理', async () => {
      const d = await ToolGate.check(mkTool('SomeNewDangerousTool'), {}, UI)
      expect(d.allowed).toBe(false)
      // 没有确认桥 → 拒绝,而不是"不认识就放行"
    })

    it('工具显式标记 deny 时直接拒绝(即使确认桥说行)', async () => {
      const d = await ToolGate.check(
        mkTool('Whatever', false, { deny: true }), {}, UI,
        { requestConfirmation: async () => true },
      )
      expect(d.allowed).toBe(false)
    })
  })

  describe('5. 参数名兼容', () => {
    it.each(['file_path', 'path', 'filePath', 'target', 'dest'])('能从 %s 提取路径', async (key) => {
      const d = await ToolGate.check(
        mkTool('Edit', true), { [key]: '/home/u/.ssh/id_rsa' }, UI,
        { requestConfirmation: async () => true },
      )
      expect(d.allowed).toBe(false)
    })

    it('args 里没有路径时不崩溃', async () => {
      const d = await ToolGate.check(mkTool('Edit', true), { foo: 1 }, UI)
      expect(typeof d.allowed).toBe('boolean')
    })
  })

  describe('6. 批量判定', () => {
    it('checkAll 逐个判定并保持顺序', async () => {
      const ds = await ToolGate.checkAll([
        { tool: mkTool('Read'), args: {} },
        { tool: mkTool('Edit', true), args: { file_path: '/tmp/x' } },
        { tool: mkTool('Glob'), args: {} },
      ], UI)
      expect(ds).toHaveLength(3)
      expect(ds[0].allowed).toBe(true)
      expect(ds[1].allowed).toBe(false)
      expect(ds[2].allowed).toBe(true)
    })
  })
})