/**
 * 【P3】渲染 store 消费子任务事件 —— 主进程事件 → subtaskTrace → 面板可见数据
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

const captured = vi.hoisted(() => ({ onAgentEvent: null as null | ((d: unknown) => void) }))

vi.stubGlobal('window', {
  localStorage: {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  },
  electronAPI: {
    chat: {
      conversations: async () => ({ success: true, data: [] }),
      createConversation: async () => ({
        success: true,
        data: { id: 'c1', title: 'subtask test', messages: [], status: 'active' },
      }),
      getSettings: async () => ({ success: true, data: {} }),
      getLastModel: async () => ({ success: true, data: { providerId: null, modelId: null } }),
      onMessage: () => () => {},
      onConversationUpdate: () => () => {},
      onStreamUpdate: () => () => {},
      onUsage: () => () => {},
      onTaskPlan: () => () => {},
      onTaskStep: () => () => {},
      onAgentEvent: (cb: (d: unknown) => void) => {
        captured.onAgentEvent = cb
        return () => {}
      },
    },
  },
})

describe('chat store 子任务轨迹', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    captured.onAgentEvent = null
  })

  it('ST-1: started 建档，done/failed 按 subtaskId 原地更新，不重复建行', async () => {
    const { useChatStore } = await import('../../../src/stores/chat')
    const store = useChatStore()
    store.initialize()
    const emit = captured.onAgentEvent
    expect(emit).not.toBeNull()
    // currentConversationId 为空时事件会被过滤 → 先建一个会话
    await store.createConversation({ title: 'subtask test' })
    const cid = store.currentConversationId
    expect(cid).toBeTruthy()

    emit!({
      conversationId: cid,
      event: {
        type: 'subtask.started',
        runId: 'r',
        data: {
          parentRunId: 'r', childRunId: 'r-c0', subtaskId: 's0', index: 0,
          instruction: '检索 A',
        },
      },
    })
    expect(store.subtaskTrace).toHaveLength(1)
    expect(store.subtaskTrace[0].status).toBe('running')

    emit!({
      conversationId: cid,
      event: {
        type: 'subtask.done',
        runId: 'r',
        data: { subtaskId: 's0', durationMs: 500, tokens: 9 },
      },
    })
    expect(store.subtaskTrace).toHaveLength(1)
    expect(store.subtaskTrace[0].status).toBe('done')
    expect(store.subtaskTrace[0].tokens).toBe(9)

    emit!({
      conversationId: cid,
      event: {
        type: 'subtask.failed',
        runId: 'r',
        data: { subtaskId: 's1', childRunId: 'r-c1', index: 1, instruction: '检索 B', error: '超时' },
      },
    })
    // failed 事件若无 started 会按"未知 id"丢弃 —— 与真实编排器事件序列一致（总是先 started）
    expect(store.subtaskTrace).toHaveLength(1)
  })
})
