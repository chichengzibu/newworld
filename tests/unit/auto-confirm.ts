/**
 * PiPiClaw — 测试辅助:自动确认执行计划 (M1-D)
 *
 * 【为什么需要】
 * M1-D 给 TaskExecutor 链路加了执行确认闸门:LLM 生成步骤后不再立即执行,
 * 而是等用户确认(默认 60s 超时 → fail-safe 拒绝)。
 * 这意味着任何走 sendMessage 真实链路、并且会触发任务执行的测试,
 * 都会因为"没人点确认"而挂起或被拒。
 *
 * 【设计取舍】
 * 不去放宽生产代码的闸门 —— 那是安全边界,不该为测试让步。
 * 改为在测试侧显式表达"这个测试的用户会点确认",让测试意图可见:
 *   - 需要自动放行的旧测试: installAutoConfirm()
 *   - 本就该验证"用户不确认则不执行"的新测试: 什么都不装,让它拒绝
 *
 * 另外提供一个开关把模式置为 'safe' —— safe 模式跳过闸门,
 * 供那些只关心后续逻辑、不关心确认流程的测试使用。
 */
import { vi } from 'vitest'
import { BrowserWindow } from 'electron'

let restore: (() => void) | null = null

/**
 * 让后续 sendMessage 触发的任务自动确认。
 * 通过 stub BrowserWindow.getAllWindows 让主进程"以为有渲染窗口",
 * 并订阅 chat:onTaskPlan 立即回传确认。
 */
export function installAutoConfirm(): void {
  uninstallAutoConfirm()
  const fakeWin = { isDestroyed: () => false, webContents: { send: vi.fn() } }
  ;(BrowserWindow as any).getAllWindows = vi.fn(() => [fakeWin])

  const originalSend = fakeWin.webContents.send
  fakeWin.webContents.send = vi.fn((channel: string, payload: any) => {
    if (channel === 'chat:onTaskPlan' && payload?.planId) {
      // 异步回传,避免与 sendMessage 的同步栈互锁
      setTimeout(() => {
        void (async () => {
          try {
            const { ChatManager } = await import('../../electron/chat/ChatManager')
            ChatManager.getInstance().resolveTaskConfirmation(payload.planId, true)
          } catch { /* 单例未就绪则忽略 */ }
        })()
      }, 0)
    }
    return originalSend?.(channel, payload)
  })

  restore = () => { delete (BrowserWindow as any).getAllWindows }
}

/** 把执行模式置为 safe(纯对话,跳过确认闸门) */
export async function setExecutionModeSafe(mode: 'safe' | 'plan' | 'craft' = 'safe'): Promise<() => void> {
  const { ConfigStore } = await import('../../electron/core/ConfigStore')
  ConfigStore.getInstance().set('execution.mode', mode)
  return () => ConfigStore.getInstance().set('execution.mode', 'craft')
}

export function uninstallAutoConfirm(): void {
  restore?.()
  restore = null
}