/**
 * v4.12 Computer Use 能力边界 —— 单测
 *
 * 这组测试锁定的不是"功能可用"，而是**能力缺失时如实报告**。
 *
 * 背景：修之前有三个真问题
 *   ① captureFrame() 第一行 `if (!this.recording) return null` —— 三个调用方
 *      都是「不录制、直接要一帧」，于是必然拿到 null，整条链路第一步就死
 *   ② ocrFrame / understandFrame 返回占位文案，但 available 语义缺失 ——
 *      调用方无法区分「屏幕上真没字」和「这个能力没实现」
 *   ③ ComputerUseHandler 把占位文案当屏幕内容拼进 LLM prompt 并返回 ok:true ——
 *      模型在瞎猜，用户以为任务真跑了
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/nw-cu-test', getAppPath: () => '/tmp/nw-cu-test', isPackaged: false },
  BrowserWindow: Object.assign(vi.fn(), {
    getAllWindows: vi.fn(() => []),
    getFocusedWindow: vi.fn(() => null),
    fromId: vi.fn(() => null),
  }),
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn() },
  desktopCapturer: { getSources: vi.fn(async () => []) },
}))

describe('① 截屏：不再依赖录制状态', () => {
  it('captureOnce 在未录制时也能取帧（修掉"要一帧却拿不到"）', async () => {
    const { ScreenVision } = await import('../../electron/computeruse/ScreenVision')
    const vision = ScreenVision.getInstance()
    expect(vision.isRecording()).toBe(false)

    // mock 返回一个可用屏幕源
    const electron = await import('electron')
    ;(electron as any).desktopCapturer.getSources = vi.fn(async () => [
      {
        thumbnail: {
          toDataURL: () => 'data:image/png;base64,AAAA',
          getSize: () => ({ width: 1280, height: 720 }),
        },
      },
    ])

    const frame = await vision.captureOnce()
    expect(frame).not.toBeNull()
    expect(frame!.width).toBe(1280)
    expect(frame!.height).toBe(720)
    expect(frame!.dataUrl).toContain('data:image/png')
  })

  it('captureFrame 在未录制时回落到 captureOnce（不再是 null）', async () => {
    const { ScreenVision } = await import('../../electron/computeruse/ScreenVision')
    const vision = ScreenVision.getInstance()
    const electron = await import('electron')
    ;(electron as any).desktopCapturer.getSources = vi.fn(async () => [
      { thumbnail: { toDataURL: () => 'data:image/png;base64,BBBB', getSize: () => ({ width: 800, height: 600 }) } },
    ])

    const frame = await vision.captureFrame()
    expect(frame).not.toBeNull()
    expect(frame!.width).toBe(800)
  })

  it('没有可用屏幕源时返回 null（而不是抛错或假数据）', async () => {
    const { ScreenVision } = await import('../../electron/computeruse/ScreenVision')
    const vision = ScreenVision.getInstance()
    const electron = await import('electron')
    ;(electron as any).desktopCapturer.getSources = vi.fn(async () => [])

    const frame = await vision.captureOnce()
    expect(frame).toBeNull()
  })
})

describe('② OCR / 屏幕理解：明确标注不可用', () => {
  it('ocrFrame 返回 available:false + 原因，而不是空字符串', async () => {
    const { ScreenVision } = await import('../../electron/computeruse/ScreenVision')
    const vision = ScreenVision.getInstance()
    const fakeFrame = { ts: 0, dataUrl: 'data:image/png;base64,AAAA', width: 100, height: 100, byteSize: 4 }

    const r = await vision.ocrFrame(fakeFrame)
    // 关键：available 为 false，调用方能区分"没实现"与"屏幕上没文字"
    expect(r.available).toBe(false)
    expect(r.unavailableReason).toBeTruthy()
    expect(r.unavailableReason).toContain('未实现')
    expect(r.text).toBe('')
    expect(r.blocks).toEqual([])
  })

  it('understandFrame 返回 available:false，且 description 为空（不塞占位文案）', async () => {
    const { ScreenVision } = await import('../../electron/computeruse/ScreenVision')
    const vision = ScreenVision.getInstance()
    const fakeFrame = { ts: 0, dataUrl: 'data:image/png;base64,AAAA', width: 100, height: 100, byteSize: 4 }

    const r = await vision.understandFrame(fakeFrame)
    expect(r.available).toBe(false)
    expect(r.unavailableReason).toContain('未实现')
    // 关键：description 必须是空 —— 有内容就会被当成屏幕内容拼进 prompt
    expect(r.description).toBe('')
    expect(r.elements).toEqual([])
  })
})

describe('③ ComputerUseHandler：能力缺失时拒绝而非假装成功', () => {
  it('屏幕理解不可用时返回 ok:false + 明确原因', async () => {
    const { ComputerUseHandler } = await import('../../electron/computeruse/ComputerUseHandler')
    const handler = ComputerUseHandler.getInstance()

    const electron = await import('electron')
    ;(electron as any).desktopCapturer.getSources = vi.fn(async () => [
      { thumbnail: { toDataURL: () => 'data:image/png;base64,CCCC', getSize: () => ({ width: 640, height: 480 }) } },
    ])

    const result = await handler.run({ instruction: '打开浏览器', maxSteps: 3 })
    expect(result.ok).toBe(false)
    expect(result.steps).toHaveLength(0)
    expect(result.error).toBeTruthy()
    // 说清缺的是什么，而不是含糊的"失败"
    expect(result.error).toContain('未实现')
    // 给用户可执行的替代建议
    expect(result.error).toContain('Read')
  })

  it('截屏不可用（无屏幕源）时也返回 ok:false 并提示权限', async () => {
    const { ComputerUseHandler } = await import('../../electron/computeruse/ComputerUseHandler')
    const handler = ComputerUseHandler.getInstance()
    const electron = await import('electron')
    ;(electron as any).desktopCapturer.getSources = vi.fn(async () => [])

    const result = await handler.run({ instruction: '截图看看', maxSteps: 2 })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('屏幕录制权限')
  })
})

describe('④ ActionExecutor：不执行时如实说明', () => {
  it('autoExecute=false 时 note 说明「没有开启入口」，而不是指向不存在的 UI', async () => {
    const { ActionExecutor } = await import('../../electron/computeruse/ActionExecutor')
    const executor = ActionExecutor.getInstance()
    executor.setAutoExecute(false)

    const r = await executor.execute({ kind: 'click', x: 10, y: 20 })
    expect(r.executed).toBe(false)
    expect(r.note).toBeTruthy()
    // 旧文案说"需用户在 UI 确认后调 setAutoExecute(true)"，但这个 UI 不存在
    expect(r.note).not.toContain('UI 确认')
    expect(r.note).toContain('没有开启')
  })
})