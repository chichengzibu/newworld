import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import SubtaskPanel from '../../../src/components/chat/SubtaskPanel.vue'
import type { SubtaskTraceEntry } from '../../../src/stores/chat'

function entries(): SubtaskTraceEntry[] {
  return [
    { id: 's0', parentRunId: 'r', childRunId: 'r-c0', index: 0, instruction: '检索 A', status: 'done', durationMs: 1200, tokens: 12 },
    { id: 's1', parentRunId: 'r', childRunId: 'r-c1', index: 1, instruction: '检索 B', status: 'failed', error: 'LLM 不可用' },
    { id: 's2', parentRunId: 'r', childRunId: 'r-c2', index: 2, instruction: '检索 C', status: 'running' },
  ]
}

describe('P3: SubtaskPanel 子任务可视化', () => {
  it('按状态渲染指令、计数和错误', () => {
    const wrapper = mount(SubtaskPanel, { props: { entries: entries() } })
    const text = wrapper.text()
    expect(text).toContain('并行子任务')
    expect(text).toContain('1/3 完成')
    expect(text).toContain('1 失败')
    expect(text).toContain('检索 A')
    expect(text).toContain('1.2s')
    expect(text).toContain('12 tokens')
    expect(text).toContain('LLM 不可用')
    expect(text).toContain('执行中')
    expect(wrapper.findAll('.subtask-row')).toHaveLength(3)
  })

  it('全部成功时不显示失败计数', () => {
    const wrapper = mount(SubtaskPanel, {
      props: { entries: [entries()[0]] },
    })
    expect(wrapper.text()).not.toContain('失败')
  })
})
