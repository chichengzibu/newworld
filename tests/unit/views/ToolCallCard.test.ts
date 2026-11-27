/**
 * New World — M1-C 工具调用可视化测试
 *
 * 【为什么要测组件】
 * ToolCallCard 的核心逻辑是"把 call/result 事件流配对成时间线"。
 * 配错会导致:
 *   - 成功的工具显示成失败(用户不信任 agent)
 *   - 失败的工具混在成功里(用户看不到哪里出错)
 *   - 大返回值塞爆 DOM(性能)
 * 这三点都是用户直接感知的,必须有测试锁住。
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import ToolCallCard from '../../../src/components/chat/ToolCallCard.vue'
import type { AgentTraceEntry } from '../../../src/stores/chat'

const mk = (o: Partial<AgentTraceEntry>): AgentTraceEntry => ({
  type: 'tool_call', runId: 'r1', name: 'Read', ...o,
} as AgentTraceEntry)

describe('M1-C ToolCallCard', () => {
  it('无轨迹时不渲染任何东西(不占视觉空间)', async () => {
    const w = mount(ToolCallCard, { props: { entries: [] } })
    expect(w.find('.trace-toggle').exists()).toBe(false)
  })

  it('默认折叠 —— 工具过程不喧宾夺主', async () => {
    const w = mount(ToolCallCard, {
      props: { entries: [mk({ type: 'tool_call' }), mk({ type: 'tool_result', ok: true, durationMs: 12 })] },
    })
    expect(w.find('.trace-toggle').exists()).toBe(true)
    expect(w.find('.trace-body').exists()).toBe(false)
  })

  it('展开后按 call/result 配对成一条,而不是两条', async () => {
    const w = mount(ToolCallCard, {
      props: {
        entries: [
          mk({ type: 'tool_call', name: 'Read', args: { file_path: '/a.txt' } }),
          mk({ type: 'tool_result', name: 'Read', ok: true, durationMs: 30 }),
        ],
      },
      attachTo: document.body,
    })
    await w.find('.trace-toggle').trigger('click')
    await nextTick()
    const items = w.findAll('.trace-item')
    expect(items).toHaveLength(1)          // 1 次调用 = 1 个条目
    expect(items[0].classes()).toContain('ok')
    expect(w.text()).toContain('Read')
  })

  it('失败的工具调用必须显眼 —— 独立 class + 展开错误详情', async () => {
    const w = mount(ToolCallCard, {
      props: {
        entries: [
          mk({ type: 'tool_call', name: 'Bash' }),
          mk({ type: 'tool_result', name: 'Bash', ok: false, durationMs: 5, error: 'command not allowed: rm' }),
        ],
      },
      attachTo: document.body,
    })
    await w.find('.trace-toggle').trigger('click')
    await nextTick()
    const item = w.find('.trace-item')
    expect(item.classes()).toContain('failed')
    expect(w.text()).toContain('command not allowed: rm')
    // 失败详情默认展开 —— 错误不该藏在折叠层后面
    expect(w.find('.trace-detail.is-error').attributes('open')).toBeDefined()
  })

  it('只收到 tool_call 未收到 result → 标记为 running(不谎报成功)', async () => {
    const w = mount(ToolCallCard, {
      props: { entries: [mk({ type: 'tool_call', name: 'Grep' })] },
      attachTo: document.body,
    })
    await w.find('.trace-toggle').trigger('click')
    await nextTick()
    expect(w.find('.trace-item').classes()).toContain('running')
  })

  it('不同 runId 的同名工具不串台', async () => {
    const w = mount(ToolCallCard, {
      props: {
        entries: [
          mk({ type: 'tool_call', runId: 'r1', name: 'Read' }),
          mk({ type: 'tool_result', runId: 'r1', name: 'Read', ok: true }),
          mk({ type: 'tool_call', runId: 'r2', name: 'Read' }),
          mk({ type: 'tool_result', runId: 'r2', name: 'Read', ok: false, error: 'boom' }),
        ],
      },
      attachTo: document.body,
    })
    await w.find('.trace-toggle').trigger('click')
    await nextTick()
    const items = w.findAll('.trace-item')
    expect(items).toHaveLength(2)
    expect(items[0].classes()).toContain('ok')
    expect(items[1].classes()).toContain('failed')
  })

  it('大返回值被截断 —— 不把整个 tool result 塞进 DOM', async () => {
    const w = mount(ToolCallCard, {
      props: {
        entries: [
          mk({ type: 'tool_call', name: 'Read', args: { file_path: '/big.bin' } }),
          mk({ type: 'tool_result', name: 'Read', ok: true, durationMs: 200, error: 'x'.repeat(5000) }),
        ],
      },
      attachTo: document.body,
    })
    await w.find('.trace-toggle').trigger('click')
    await nextTick()
    const pre = w.find('.trace-pre.is-error')
    expect(pre.exists()).toBe(true)
    expect(pre.text().length).toBeLessThan(1200)
    expect(pre.text()).toContain('已截断')
  })

  it('汇总行显示成功/失败/总次数 —— 用户一眼看到整体结果', async () => {
    const w = mount(ToolCallCard, {
      props: {
        entries: [
          mk({ type: 'tool_call', name: 'A' }), mk({ type: 'tool_result', name: 'A', ok: true, durationMs: 10 }),
          mk({ type: 'tool_call', name: 'B' }), mk({ type: 'tool_result', name: 'B', ok: false, durationMs: 20 }),
        ],
      },
      attachTo: document.body,
    })
    await w.find('.trace-toggle').trigger('click')
    await nextTick()
    expect(w.text()).toContain('1 失败')
    expect(w.text()).toContain('共 2 次')
  })
})