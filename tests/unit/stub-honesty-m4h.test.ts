/**
 * New World — 兜底占位实现的诚实性测试（M4-H）
 * ═══════════════════════════════════════════════════════════════
 * 【为什么这条值得单独钉】
 * `main.ts` 的注册顺序是:
 *   ① 先注册 AgentBrainImpl(脚手架 stub,永远能注册成功)
 *   ② 再尝试注册 LlmAgentBrain(真实 tool loop)—— 失败则保留 ①
 * 所以当真实 brain 注册失败时(比如 provider 配置有问题),用户面对的是 stub。
 *
 * 而 stub 旧实现回的是 `思考完成: <用户消息前 50 字>` ——
 * **看起来像一个正常的 AI 答复,但其实什么都没处理**。
 * 用户会以为模型想过了、答了。
 *
 * 这是本项目最在意的那类缺陷:「看起来在工作,其实没有」。
 * 用户侧唯一能看到的就是这条回复,所以诚实必须写在这里、且被测试钉住。
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: vi.fn((k: string) => `/tmp/newworld-stub-${k}`) },
  ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {} },
  BrowserWindow: class {},
  dialog: { showMessageBox: () => {}, showOpenDialog: () => {} },
  shell: { openExternal: () => {}, openPath: () => {} },
  globalShortcut: { register: () => true, unregister: () => {} },
  Menu: { buildFromTemplate: () => ({}), setApplicationMenu: () => {} },
  Tray: class { setToolTip() {} setContextMenu() {} on() {} },
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }) },
}))
vi.mock('electron-log', () => ({
  default: {
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
    transports: { file: { resolvePathFn: () => {}, maxSize: 0, format: '' }, console: { level: 'info' } },
  },
}))

import { AgentBrainImpl } from '../../electron/agent/AgentBrain'

describe('M4-H 兜底占位实现必须诚实', () => {
  it('回复正文要明说「未接入真实模型」,不能看起来像正常答复', async () => {
    const brain = AgentBrainImpl.getInstance()
    const d = await brain.think({
      content: '帮我把桌面上这些 PDF 归档一下',
      conversationId: 'c1',
    } as any)

    const payload = d.payload as any
    expect(typeof payload.text).toBe('string')
    // 旧实现回的是「思考完成: ...」—— 看起来像答了,其实没处理
    expect(payload.text).not.toMatch(/^思考完成/)
    expect(payload.text).toContain('未接入真实模型')
    expect(payload.text).toContain('没有真正处理')
  })

  it('回复要给出可操作的下一步(去哪配 provider)', async () => {
    const brain = AgentBrainImpl.getInstance()
    const d = await brain.think({ content: '你好', conversationId: 'c2' } as any)
    const payload = d.payload as any
    expect(payload.text).toMatch(/模型管理|API Key|provider/i)
  })

  it('带 stub 标记 —— 让会话层能把它标成「占位答复」而不是正常消息', async () => {
    const brain = AgentBrainImpl.getInstance()
    const d = await brain.think({ content: '你好', conversationId: 'c3' } as any)
    const payload = d.payload as any
    expect(payload.stub).toBe(true)
  })
})
