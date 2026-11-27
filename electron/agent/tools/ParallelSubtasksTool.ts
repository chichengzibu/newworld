/**
 * New World - parallel_subtasks 工具（多 agent 编排的模型入口）
 *
 * 模型自己判断"这些子问题能否独立并行"，一次性给出 2~5 条指令；
 * 真正的执行/并发/失败隔离/聚合在 SubtaskOrchestrator。
 *
 * 本工具是**薄壳**，刻意不持有 brain 引用：
 *   - 工具是模块级单例（父子同源），把 brain 塞进构造器会串味；
 *   - 每轮 run 由 LlmAgentBrain 把 delegate 闭包放进 RuntimeToolContext 显式下传，
 *     闭包捕获当前 run 的 model/provider/contextKind/AbortSignal，零模块态。
 */
import type { PiPiTool, ToolExecResult, RuntimeToolContext } from './Tool'

export const ParallelSubtasksToolMetadata = {
  name: 'parallel_subtasks',
  description:
    '把多个【彼此独立、不需要互相等待结果】的子任务同时交给子代理执行,' +
    '结果会汇总后返回。仅当确实能并行时使用(例如同时检索几个不同主题、' +
    '分别审查几个独立文件);有依赖关系时不要用它。' +
    '每条 tasks 元素必须是一条完整、自包含的指令(子代理看不到父对话)。' +
    '最多 5 条。子代理不能再派生子代理。',
  parametersJson: {
    type: 'object',
    properties: {
      tasks: {
        type: 'array',
        description: '可并行的子任务指令数组，每项都是完整自包含的指令',
        minItems: 1,
        maxItems: 5,
        items: { type: 'string' },
      },
    },
    required: ['tasks'],
  },
  requiresPermission: false,
  domain: 'agent-orchestration',
}

export class ParallelSubtasksTool implements PiPiTool {
  metadata = ParallelSubtasksToolMetadata

  async execute(args: Record<string, unknown>, ctx?: RuntimeToolContext): Promise<ToolExecResult> {
    const tasks = args?.tasks
    if (!Array.isArray(tasks) || tasks.length === 0) {
      return { ok: false, result: '', error: 'tasks 必须是非空字符串数组' }
    }
    if (tasks.length > 5) {
      return { ok: false, result: '', error: 'tasks 最多 5 项，请合并或分批' }
    }
    if (!tasks.every((t) => typeof t === 'string' && t.trim().length > 0)) {
      return { ok: false, result: '', error: 'tasks 每一项都必须是非空字符串' }
    }
    if (!ctx?.delegate) {
      // 没有编排上下文就不伪造执行结果 —— 例如测试直调、或旧调用方未注入
      return { ok: false, result: '', error: '当前运行未提供并行编排上下文' }
    }
    return ctx.delegate(tasks.map((t) => String(t).trim()))
  }
}
