/**
 * 【M3-G】会话 id —— 原本从 runtime/conversation/Conversation 引入,
 * 但那套 conversation 状态机是 #005 时期的平行架构(从未接入当前主线),
 * 已随 M3-G 一并移除。这里就地定义,语义不变(string)。
 */
export type ConversationId = string
import { randomUUID } from 'node:crypto'

export type ContextId = string

export interface SkillContextData {
  userId?: string
  conversationId?: ConversationId
  permissionToken?: string
  env?: Record<string, string>
  cwd?: string
  state?: Record<string, unknown>
  trace: ContextId[]
}

export class SkillContext {
  public readonly id: ContextId
  public data: SkillContextData

  constructor(data: Partial<SkillContextData> = {}) {
    this.id = randomUUID()
    this.data = { ...data, trace: data.trace ?? [] }
  }

  fork(extra: Partial<SkillContextData> = {}): SkillContext {
    const child = new SkillContext({ ...this.data, ...extra, trace: [...this.data.trace, this.id] })
    return child
  }

  toJSON(): SkillContextData {
    return { ...this.data, trace: [...this.data.trace] }
  }
}