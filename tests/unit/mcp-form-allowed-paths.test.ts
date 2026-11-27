/**
 * New World — MCP Server 表单测试（M4-P）
 * ═══════════════════════════════════════════════════════════════════════
 * 【为什么要有这个文件】
 * M4-P 修了「默认白名单含程序工作目录」这个洞 —— 但光收紧默认值不够:
 * **用户必须能自己授权目录**,否则文件类 MCP Server 只能碰应用自己的沙箱,
 * 等于"配了却用不了"。
 * 故表单加了「允许路径」字段。这条用例钉住:
 *   ① 字段存在且能填
 *   ② 保存时**真的**把 allowedPaths 传出去(每行一个路径)
 *   ③ 编辑既有 server 时能回填
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

vi.mock('element-plus/es/components/message/index', () => ({
  ElMessage: { warning: vi.fn(), success: vi.fn(), error: vi.fn(), info: vi.fn() },
}))
vi.mock('element-plus/es/components/message-box/index', () => ({
  ElMessageBox: { confirm: vi.fn(() => Promise.resolve('confirm')), alert: vi.fn() },
}))
vi.mock('@element-plus/icons-vue', () => ({
  Plus: { template: '<i />' }, Delete: { template: '<i />' }, Upload: { template: '<i />' },
  MagicStick: { template: '<i />' }, Box: { template: '<i />' }, Connection: { template: '<i />' },
  Document: { template: '<i />' }, Warning: { template: '<i />' }, ChatDotRound: { template: '<i />' },
  Setting: { template: '<i />' }, Goods: { template: '<i />' }, Promotion: { template: '<i />' },
  Search: { template: '<i />' }, MagicStick: { template: '<i />' },
}))

import McpServerFormDialog from '../../src/components/settings/McpServerFormDialog.vue'

async function mountDialog(server?: Record<string, unknown>) {
  const ElementPlus = (await import('element-plus')).default
  // 【真实路径】对话框组件常驻挂载(modelValue=false),打开时才置 true
  // → 表单回填靠的是 `watch(() => props.modelValue)` 的**变化**。
  // 直接以 true 挂载不会触发 watch(那是测试假象,不是产品行为)。
  const w = mount(McpServerFormDialog, {
    props: { modelValue: false, ...(server ? { server } : {}) },
    global: { plugins: [ElementPlus] },
  })
  await flushPromises()
  await w.setProps({ modelValue: true })
  await flushPromises()
  return w
}

describe('M4-P MCP 表单 · 允许路径', () => {
  beforeEach(() => vi.clearAllMocks())

  it('表单里有「允许路径」输入框', async () => {
    const w = await mountDialog()
    const inputs = w.findAll('textarea')
    expect(inputs.length, '没有允许路径输入框').toBeGreaterThan(0)
    expect(w.text()).toContain('允许路径')
  })

  it('保存时把每行路径作为 allowedPaths 传出去', async () => {
    const w = await mountDialog()
    await w.find('input[placeholder="请输入名称"]').setValue('fs-server')
    await w.find('input[placeholder^="例如"]').setValue('node')

    const areas = w.findAll('textarea')
    await areas[areas.length - 1].setValue('D:\\MyProject\nD:\\Other')

    await w.findAll('button').filter((b: any) => b.text().includes('添加')).at(-1)!.trigger('click')
    await flushPromises()

    const emitted = w.emitted('save')
    expect(emitted, '没有触发 save').toBeTruthy()
    const payload = emitted![0][0] as any
    expect(payload.allowedPaths).toEqual(['D:\\MyProject', 'D:\\Other'])
  })

  it('编辑既有 server 时回填允许路径', async () => {
    const w = await mountDialog({
      name: 'fs',
      command: 'node',
      enabled: true,
      allowedPaths: ['D:\\Already'],
    })
    const areas = w.findAll('textarea')
    const value = (areas[areas.length - 1].element as HTMLTextAreaElement).value
    expect(value).toContain('D:\\Already')
  })

  it('留空 → allowedPaths 为空数组(表示"只允许应用自己的沙箱")', async () => {
    const w = await mountDialog()
    await w.find('input[placeholder="请输入名称"]').setValue('fs-server')
    await w.find('input[placeholder^="例如"]').setValue('node')
    await w.findAll('button').filter((b: any) => b.text().includes('添加')).at(-1)!.trigger('click')
    await flushPromises()
    const emitted = w.emitted('save')
    const payload = emitted![0][0] as any
    expect(payload.allowedPaths).toEqual([])
  })
})
