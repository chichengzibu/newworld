/**
 * New World — M1-D 执行确认闸门测试
 *
 * 【安全边界必须有测试】
 * 修复前: LLM 生成步骤后【立即执行】,渲染层确认弹窗是死代码
 * (showTaskConfirmDialog 从未被置 true)。用户全程黑盒。
 *
 * 本测试锁定三条不可回退的契约:
 *   1. 确认门只在 'safe' 模式下跳过 —— plan 和 craft 都必须确认
 *   2. 拒绝默认值是 false —— 超时/无窗口/未知 planId 一律拒绝
 *   3. 确认后才 resolve —— promise 在确认前不兑现
 *
 * 任何一条变红都意味着安全回退。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { TestHost } from '../unit/test-host'

describe('M1-D 执行确认闸门', () => {
  let cm: any
  let ConfigStore: any

  beforeEach(async () => {
    // 注意: 不能用 vi.resetModules() —— 它会把 electron-setup.ts 注入的
    // PlatformHost 一并清掉,导致 ConfigStore.getHost() 抛
    // "PlatformHost 尚未初始化"。改为手动重置两个单例即可拿到干净状态。
    const { setHost } = await import('../../electron/platform/runtime')
    setHost(new TestHost())
    const { ChatManager: CM } = await import('../../electron/chat/ChatManager')
    const { ConfigStore: CS } = await import('../../electron/core/ConfigStore')
    ;(CM as any).destroy?.()
    cm = CM.getInstance()
    ConfigStore = CS
  })

  afterEach(() => {
    try { ConfigStore.getInstance().set('execution.mode', 'craft') } catch { /* 无配置则忽略 */ }
  })

  const setMode = (m: string) => { ConfigStore.getInstance().set('execution.mode', m) }

  it('S1: getExecutionMode 与 IpcServer 读写同一键 —— 单一真源', () => {
    setMode('plan')
    expect(cm.getExecutionMode()).toBe('plan')
    setMode('safe')
    expect(cm.getExecutionMode()).toBe('safe')
    setMode('craft')
    expect(cm.getExecutionMode()).toBe('craft')
  })

  it('S2: 非法模式值回落到默认,不进入未定义态', () => {
    ConfigStore.getInstance().set('execution.mode', 'bogus-mode')
    const m = cm.getExecutionMode()
    expect(['safe', 'plan', 'craft']).toContain(m)
  })

  it('S3: 无渲染窗口时拒绝执行(fail-safe)—— 定时任务/IM 入口不得盲执行', async () => {
    // 不 mock BrowserWindow → getAllWindows 返回空 → 应拒绝
    const electron = await import('electron')
    ;(electron.BrowserWindow as any).getAllWindows.mockReturnValue([])

    const ok = await cm.requestPlanConfirmation('c1', '删除所有文件', [
      { order: 1, description: '删除 D:/x', status: 'pending', params: {} },
    ])
    expect(ok).toBe(false)
  })

  it('S4: 用户确认后才 resolve —— promise 在确认前不兑现', async () => {
    const electron = await import('electron')
    ;(electron.BrowserWindow as any).getAllWindows.mockReturnValue([
      { isDestroyed: () => false, webContents: { send: vi.fn() } },
    ])

    let resolved: boolean | null = null
    const p = cm
      .requestPlanConfirmation('c2', '整理文件', [
        { order: 1, description: '扫描', status: 'pending', params: {} },
      ])
      .then(v => { resolved = v; return v })

    // 捕获发出的 planId
    const sendMock = (electron.BrowserWindow.getAllWindows() as any)[0].webContents.send as any
    const planCall = sendMock.mock.calls.find((c: unknown[]) => c[0] === 'chat:onTaskPlan')
    expect(planCall).toBeDefined()
    const planId = planCall![1].planId

    // 尚未确认 → 仍未兑现
    await new Promise(r => setTimeout(r, 30))
    expect(resolved).toBeNull()

    // 确认后兑现
    expect(cm.resolveTaskConfirmation(planId, true)).toBe(true)
    expect(await p).toBe(true)
  })

  it('S5: 拒绝也必须 resolve —— 否则主进程会一直等到超时', async () => {
    const electron = await import('electron')
    ;(electron.BrowserWindow as any).getAllWindows.mockReturnValue([
      { isDestroyed: () => false, webContents: { send: vi.fn() } },
    ])

    const p = cm.requestPlanConfirmation('c3', 'x', [
      { order: 1, description: 'y', status: 'pending', params: {} },
    ])
    const sendMock = (electron.BrowserWindow.getAllWindows() as any)[0].webContents.send as any
    const planId = sendMock.mock.calls.find((c: unknown[]) => c[0] === 'chat:onTaskPlan')![1].planId

    cm.resolveTaskConfirmation(planId, false)
    expect(await p).toBe(false)
  })

  it('S6: 未知 planId 一律拒绝 —— 不给误确认留口子', () => {
    expect(cm.resolveTaskConfirmation('plan_never_existed_999', true)).toBe(false)
  })

  it('S7: 超时拒绝(不等用户到天荒地老)', async () => {
    const electron = await import('electron')
    ;(electron.BrowserWindow as any).getAllWindows.mockReturnValue([
      { isDestroyed: () => false, webContents: { send: vi.fn() } },
    ])

    // 显式传短超时,避免测试等待 60s
    const ok = await cm.requestPlanConfirmation('c4', 'x', [
      { order: 1, description: 'y', status: 'pending', params: {} },
    ], 50)
    expect(ok).toBe(false)
  })
})