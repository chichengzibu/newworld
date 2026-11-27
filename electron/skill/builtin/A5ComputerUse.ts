/**
 * New World - Skill / A5ComputerUse
 *
 * Computer Use 技能入口。
 *
 * 【v4.12 现状 —— 如实标注，不要让它看起来能用】
 * 本技能目前**不可用**，原因是底层能力缺失：
 *   · 截屏可用（ScreenVision.captureOnce 已修好）
 *   · 屏幕理解 / OCR 未实现（需多模态视觉模型，且 LlmMessage 目前只支持纯文本）
 *   · 动作执行只能作用于本应用窗口，无法操作其它程序
 *
 * 因此 run() 会返回 ok:false + 明确的不可用原因，而不是跑一个"看起来成功"
 * 的空循环。这样用户知道真相，也便于后续按需补齐能力。
 */

import { LogManager } from '../../core/LogManager'
import { ComputerUseHandler, ComputerUseResult } from '../../computeruse/ComputerUseHandler'
import { EventBus } from '../../runtime/bridge/EventBus'
import { ActionExecutor } from '../../computeruse/ActionExecutor'
import { ScreenVision } from '../../computeruse/ScreenVision'

export const A5_SKILL_NAME = 'a5:computer-use-v1'

export interface A5Input {
  /** 用户自然语言描述(例如 "打开浏览器") */
  instruction: string
  /** 最大步数(默认 5) */
  maxSteps?: number
  /** 是否自动执行(默认 false,需用户在 UI 确认) */
  autoExecute?: boolean
}

/**
 * A5ComputerUse: Computer Use 入口
 */
export async function runA5(input: A5Input): Promise<{ ok: boolean; result?: ComputerUseResult; error?: string }> {
  const log = LogManager.getInstance()
  const handler = ComputerUseHandler.getInstance()
  const executor = ActionExecutor.getInstance()
  const vision = ScreenVision.getInstance()

  try {
    log.info(`A5ComputerUse: 启动 (${input.instruction.slice(0, 30)})`)
    if (input.autoExecute) {
      executor.setAutoExecute(true)
      log.warn('A5ComputerUse: autoExecute=true, 真实执行键盘鼠标')
    } else {
      log.info('A5ComputerUse: autoExecute=false,只记录(沙箱模式)')
    }

    // 截屏能力可用，先真实截一帧确认环境（也顺带验证屏幕录制权限）
    const frame = await vision.captureOnce()
    if (!frame) {
      return {
        ok: false,
        error: '截屏失败：没有可用的屏幕源，或系统未授予屏幕录制权限。请在系统设置中允许本应用录制屏幕。',
      }
    }
    void EventBus.getInstance().publish('a5:start', { instruction: input.instruction, frameWidth: frame.width, frameHeight: frame.height })

    const result = await handler.run({ id: `a5-${Date.now()}`, instruction: input.instruction, maxSteps: input.maxSteps ?? 5, autoExecute: input.autoExecute })
    void EventBus.getInstance().publish('a5:done', { taskId: result.taskId, stepCount: result.steps.length, hitMaxSteps: result.hitMaxSteps })

    // handler 因能力缺失返回 ok:false 时，如实向上透传，不要吞掉
    if (!result.ok) {
      return { ok: false, error: result.error }
    }
    return { ok: true, result }
  } catch (e) {
    log.error('A5ComputerUse: 失败', e)
    return { ok: false, error: String(e) }
  }
}

export const a5SkillHandler = {
  name: A5_SKILL_NAME,
  description: 'Computer Use（当前未实现：屏幕理解与 OCR 缺失，请勿声称可用）',
  requiresPermission: true,
  async execute(args: A5Input) {
    return runA5(args)
  },
}

/** W8.2 wire:由 main.ts 调用,把 A5 skill 注册到 SkillRuntime */
export function registerA5Skill(): void {
  const { SkillRuntime } = require('../../runtime/skill/SkillRuntime')
  SkillRuntime.getInstance().register({
    name: A5_SKILL_NAME,
    description: 'Computer Use v1 最小 demo',
    handler: async (args: any) => runA5(args as A5Input),
  })
}
