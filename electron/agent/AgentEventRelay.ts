/**
 * New World - Agent 运行事件中继 (M1-C)
 *
 * 问题背景: `LlmAgentBrainEvents` 已定义 10 种事件类型 (run_start / iteration /
 * tool_call / tool_result / content_delta / thinking_delta / final_answer /
 * run_error / run_aborted), 但此前【零生产订阅者】 —— 所有事件 emit 进虚空。
 * 这是"agent 在干什么用户看不到"的根因。
 *
 * 本模块职责:
 *   1. 订阅 LlmAgentBrainEvents(单例全局事件源)
 *   2. 把事件关联到 conversationId(run 维度无会话信息,由会话层在订阅期注入)
 *   3. 对外提供 per-run 订阅,供 ChatManager 转成 IPC 广播
 *
 * 设计取舍:
 *   - 不在 brain 内部持有 conversationId(brain 无状态红线,见 LlmAgentBrain.ts:24)
 *   - 关联方式:调用方先 `beginScope(conversationId)`,事件经过时自动打标
 *   - 单进程单会话场景下 beginScope 足够;并发多会话靠 runId 二次校验(见 relay 注释)
 */

import { LlmAgentBrainEvents, type LlmAgentEvent } from './LlmAgentBrain'

/** 跨层传递的 agent 运行事件(带会话归属) */
export interface AgentRunEvent {
  runId: string
  type: LlmAgentEvent['type']
  /** 会话归属 —— 由 ChatManager 订阅期注入 */
  conversationId: string
  /** 事件负载(原始 event 去掉 runId/type 后的部分) */
  data: Record<string, unknown>
}

export type AgentRunEventHandler = (event: AgentRunEvent) => void

class AgentEventRelay {
  private static instance: AgentEventRelay
  private handlers: Set<AgentRunEventHandler> = new Set()
  /** runId → conversationId 归属表(brain 侧无会话概念,由此处补齐) */
  private runScope: Map<string, string> = new Map()
  private wired = false

  private constructor() {}

  public static getInstance(): AgentEventRelay {
    if (!AgentEventRelay.instance) AgentEventRelay.instance = new AgentEventRelay()
    return AgentEventRelay.instance
  }

  /** 接一次上游事件源(幂等) */
  private wire(): void {
    if (this.wired) return
    this.wired = true
    LlmAgentBrainEvents.subscribe((e) => {
      const conversationId = this.runScope.get(e.runId)
      if (!conversationId) return // 无归属(如测试直调 run)则不进生产流
      const { runId, type, ...rest } = e as LlmAgentEvent & Record<string, unknown>
      const evt: AgentRunEvent = {
        runId,
        type,
        conversationId,
        data: rest as Record<string, unknown>,
      }
      for (const h of Array.from(this.handlers)) {
        try { h(evt) } catch { /* 单个订阅者异常不影响其他订阅者 */ }
      }
    })
  }

  /** 声明一个 run 的会话归属(在调用 run/think 前调用) */
  bindRun(runId: string, conversationId: string): void {
    this.wire()
    this.runScope.set(runId, conversationId)
    // 防泄漏:run 结束后由 releaseRun 清理;此处兜底一个上限
    if (this.runScope.size > 64) {
      const oldest = this.runScope.keys().next().value
      if (oldest) this.runScope.delete(oldest)
    }
  }

  /** run 结束清理 */
  releaseRun(runId: string): void {
    this.runScope.delete(runId)
  }

  /** 订阅(返回退订函数) */
  subscribe(handler: AgentRunEventHandler): () => void {
    this.wire()
    this.handlers.add(handler)
    return () => { this.handlers.delete(handler) }
  }
}

export const AgentEventRelayBus = AgentEventRelay.getInstance()