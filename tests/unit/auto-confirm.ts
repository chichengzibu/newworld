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

/**
 * 【M2-B】工具级确认桥 —— 让"验证别的逻辑"的测试能跑过新加的权限门。
 *
 * ToolGate 对 Edit/Write 这类写操作默认要求用户确认;未提供确认桥时按
 * fail-safe 拒绝。老测试(runtime-context-propagation 验证 contextKind
 * 贯穿、spawn-independence 验证快照溯源)关心的是自己的主题,不是权限。
 *
 * 【设计约束:纯函数,不写全局】
 * 早期版本用 globalThis.__pipiclawToolConfirm 让 run() 自动拾取 ——
 * 那等于在生产代码里留了一个可被误用的旁路(与
 * LlmAgentBrain 的 preApprovedToolConfirm 不同,那个是显式入参)。
 * 已废弃。确认桥只能由调用方在 run({ requestToolConfirmation }) 显式传入,
 * 生产代码路径上不存在任何全局读取点。
 *
 * 护栏:主题为安全/权限的测试【禁止】使用本桥 —— 那类测试必须自己传
 * () => false 或不传,见 ToolGate.test.ts 与 harness-wiring 的 G3。
 */
export function installToolConfirmation(
  answer: (toolName: string, prompt: string) => boolean = () => true,
): (toolName: string, prompt: string) => Promise<boolean> {
  return async (toolName: string, prompt: string): Promise<boolean> => answer(toolName, prompt)
}

/**
 * 【M2-B】非 UI 上下文的预授权选项 —— 返回值直接传给 run()。
 *
 * 背景:ToolGate 有一条刻意的 fail-safe 规则 ——
 * contextKind !== 'ui' 时无法弹窗询问用户,故 confirm 级工具一律拒绝。
 * 这是对的:定时任务 / IM 入站 / headless 场景下没有人在旁边点确认,
 * 不该默认放行写操作。
 *
 * 但有一类测试的主题恰恰是"非 UI 上下文里的行为"(如
 * runtime-context-propagation 验证 contextKind=im_inbound 逐跳贯穿、
 * spawn-independence 验证子代理快照溯源)。它们需要写工具真的跑起来,
 * 否则验证不到目标逻辑。
 *
 * 【为什么是函数返回值而不是全局开关】
 * 曾实现为 globalThis.__pipiclawHeadlessExempt —— 那是把安全边界
 * 建立在"没人会写这行代码"的约定上,任何人加一行赋值就能绕过 fail-safe。
 * 已废弃。改为显式注入,与 requestToolConfirmation 同构:
 * 生产代码路径上不存在任何可被误用的全局旁路。
 *
 * 用法: run(prompt, { preApprovedToolConfirm: true })
 *
 * 护栏:主题为安全/权限的测试【禁止】使用本选项
 * (见 ToolGate.test.ts 与 harness-wiring 的 G3 用户拒绝用例)。
 */
export function headlessPreApproval(): { preApprovedToolConfirm: true } {
  return { preApprovedToolConfirm: true as const }
}