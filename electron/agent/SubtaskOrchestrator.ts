/**
 * New World - 并行子任务编排器（多 agent 编排的真实执行层）
 *
 * 【此前的事实】
 * LlmAgentBrain.spawn() 只 `new` 一个子实例就返回：instruction 没被当成 prompt，
 * 没有执行、没有等待、没有聚合；生产路径零调用。所谓"多 agent"只是类型占位。
 *
 * 【这里做的】
 * 模型通过 parallel_subtasks 工具给出一组彼此独立的指令 → 本编排器：
 *   1. 复用 spawn() 的隔离语义造子实例（工具容器 / runs / 预算隔离，深度上限 1）
 *   2. 有界并发真正并行执行（默认 3，上限 5 个子任务）
 *   3. Promise 级失败隔离：一个子任务失败不影响其余
 *   4. 聚合为一段 tool result 回灌给父 LLM 继续推理
 *   5. 全程发 subtask.* 事件，事件 runId 用父 runId —— 直接绕过子 run 未 bind 导致事件丢失的坑
 *   6. 父 run 取消（AbortSignal）会逐个 abort 子 run
 *
 * 不在本模块引入 LlmAgentBrain 运行时依赖：emit / 子实例都通过参数注入，避免循环依赖。
 */
import type { LlmAgentBrain, LlmAgentEvent, RunCheckpointEvent } from './LlmAgentBrain'
import type { ToolExecResult } from './tools'
import type { ContextKind } from './tools/constants'
import type { InlineLlmConfig } from '../llm/types'

export const MAX_PARALLEL_SUBTASKS = 5
export const DEFAULT_SUBTASK_CONCURRENCY = 3
/** 单条子任务结果回灌上限：防止小模型把上下文塞爆 */
const RESULT_CHAR_LIMIT = 1500

export interface SubtaskOrchestrationOptions {
  parent: LlmAgentBrain
  parentRunId: string
  instructions: string[]
  contextKind?: ContextKind
  model?: string
  provider?: 'openai' | 'openai-compatible' | 'anthropic' | 'zhipu'
  config?: InlineLlmConfig
  concurrency?: number
  maxIterations?: number
  signal?: AbortSignal
  checkpoint?: (ev: RunCheckpointEvent) => void
  suppressedSkills?: string[]
  /** 会话归属 —— 仅用于子任务 token 记账 */
  conversationId?: string
  /** 子任务真实 token 回执；父 run 的 usage chunk 不包含子 run，必须单独记 */
  onChildUsage?: (u: { model?: string; promptTokens: number; completionTokens: number; conversationId?: string }) => void
  emit: (e: LlmAgentEvent) => void
}

interface SubtaskOutcome {
  index: number
  id: string
  instruction: string
  ok: boolean
  content: string
  error?: string
  durationMs: number
  tokens: number
}

/** 有界并发执行全部子任务；任何单个失败都不会中断其余任务或父 run。 */
export async function orchestrateSubtasks(opts: SubtaskOrchestrationOptions): Promise<ToolExecResult> {
  const instructions = opts.instructions
    .map((s) => String(s ?? '').trim())
    .filter(Boolean)
    .slice(0, MAX_PARALLEL_SUBTASKS)

  if (instructions.length === 0) {
    return { ok: false, result: '', error: 'tasks 不能为空，且每项必须是非空字符串' }
  }
  if (opts.signal?.aborted) {
    return { ok: false, result: '', error: '并行子任务已取消（尚未开始）' }
  }

  const concurrency = Math.max(1, Math.min(
    Math.floor(opts.concurrency ?? DEFAULT_SUBTASK_CONCURRENCY),
    instructions.length,
  ))
  const outcomes: SubtaskOutcome[] = []
  const childAborts = new Set<() => boolean>()

  const onParentAbort = (): void => {
    for (const abort of Array.from(childAborts)) {
      try { abort() } catch { /* 单个子任务 abort 失败不影响其余 */ }
    }
  }
  opts.signal?.addEventListener('abort', onParentAbort, { once: true })

  let nextIndex = 0
  const worker = async (): Promise<void> => {
    while (nextIndex < instructions.length) {
      if (opts.signal?.aborted) return
      const index = nextIndex++
      const instruction = instructions[index]
      const subtaskId = `sub-${opts.parentRunId}-${index}`
      const childRunId = `${opts.parentRunId}-child-${index}`
      const startedAt = Date.now()

      opts.emit({
        type: 'subtask.started',
        runId: opts.parentRunId,
        parentRunId: opts.parentRunId,
        subtaskId,
        childRunId,
        index,
        instruction,
      })

      let cancelChild: (() => boolean) | undefined
      try {
        // spawn() 只造实例；instruction 在这里才真正作为 prompt 交给 child.run()
        const sub = await opts.parent.spawn(
          { instruction },
          {
            parentRunId: opts.parentRunId,
            contextKind: opts.contextKind,
            checkpoint: opts.checkpoint,
          },
        )
        // contracts 的 SubAgent.brain 类型是最小 AgentBrain 接口（只有 think/call/spawn），
        // 这里实际拿到的是 LlmAgentBrain，显式收窄到它真实具备的运行面。
        const childBrain = sub.brain as unknown as {
          run: (prompt: string, runOpts: Record<string, unknown>) => Promise<{
            content: string
            totalTokens?: number
            promptTokens?: number
            completionTokens?: number
          }>
          abortRun: (runId: string) => boolean
        }
        cancelChild = () => childBrain.abortRun(childRunId)
        childAborts.add(cancelChild)

        const result = await childBrain.run(instruction, {
          runId: childRunId,
          parentRunId: opts.parentRunId,
          model: opts.model,
          provider: opts.provider,
          config: opts.config,
          maxIterations: opts.maxIterations ?? 4,
          contextKind: opts.contextKind ?? 'headless',
          checkpoint: opts.checkpoint,
          ...(opts.suppressedSkills?.length ? { suppressedSkills: opts.suppressedSkills } : {}),
        })

        const durationMs = Date.now() - startedAt
        const tokens = result.totalTokens ?? 0
        // 子 run 不走 ChatManager 的 usage 广播 → 不单独记就会漏账
        opts.onChildUsage?.({
          model: opts.model,
          promptTokens: result.promptTokens ?? 0,
          completionTokens: result.completionTokens ?? 0,
          conversationId: opts.conversationId,
        })
        outcomes.push({
          index, id: subtaskId, instruction, ok: true,
          content: result.content, durationMs, tokens,
        })
        opts.emit({
          type: 'subtask.done',
          runId: opts.parentRunId,
          parentRunId: opts.parentRunId,
          subtaskId, childRunId, index, durationMs, tokens,
        })
      } catch (e) {
        const durationMs = Date.now() - startedAt
        const error = (e as Error)?.message ?? String(e)
        outcomes.push({
          index, id: subtaskId, instruction, ok: false,
          content: '', error, durationMs, tokens: 0,
        })
        opts.emit({
          type: 'subtask.failed',
          runId: opts.parentRunId,
          parentRunId: opts.parentRunId,
          subtaskId, childRunId, index, durationMs, error,
        })
      } finally {
        if (cancelChild) childAborts.delete(cancelChild)
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()))
  opts.signal?.removeEventListener('abort', onParentAbort)

  outcomes.sort((a, b) => a.index - b.index)
  const okCount = outcomes.filter((o) => o.ok).length
  const failedCount = outcomes.length - okCount
  const totalTokens = outcomes.reduce((sum, o) => sum + o.tokens, 0)
  const totalDurationMs = outcomes.reduce((sum, o) => sum + o.durationMs, 0)

  opts.emit({
    type: 'subtask.aggregated',
    runId: opts.parentRunId,
    parentRunId: opts.parentRunId,
    count: outcomes.length,
    okCount,
    failedCount,
    totalTokens,
    totalDurationMs,
  })

  if (opts.signal?.aborted) {
    return {
      ok: false,
      result: '',
      error: `并行子任务已取消（已完成 ${okCount}/${instructions.length}）`,
    }
  }

  const lines = [
    `并行子任务 ${outcomes.length} 个：成功 ${okCount}，失败 ${failedCount}，耗时 ${totalDurationMs}ms，tokens ${totalTokens}。`,
  ]
  for (const o of outcomes) {
    const body = o.ok
      ? (o.content.length > RESULT_CHAR_LIMIT
        ? `${o.content.slice(0, RESULT_CHAR_LIMIT)}…（结果过长已截断）`
        : o.content) || '（无正文）'
      : `失败：${o.error}`
    lines.push(`### 子任务 ${o.index + 1} [${o.ok ? '成功' : '失败'}] ${o.instruction}\n${body}`)
  }

  // 部分失败时仍回灌成功结果（ok=true），否则 brain 只会把 error 给模型、丢掉已有材料。
  return { ok: okCount > 0, result: lines.join('\n\n'), ...(failedCount > 0 ? { error: `${failedCount} 个子任务失败，详见结果` } : {}) }
}
