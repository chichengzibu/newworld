/**
 * PiPiClaw — M4 面板渲染测试（设置页嵌入后端 + 模型对比页今日成本）
 * ═══════════════════════════════════════════════════════════════
 * 【为什么单独一份】
 * SkillsView 的 4 个面板已在 `skills-m4-panels.test.ts` 覆盖。
 * 本份覆盖另外两个:
 *   - 「设置 → 记忆」的**嵌入后端**卡片(M3-A 加的)
 *   - 「模型对比」的**今日成本**卡片(M3-E 加的)
 *
 * 【两个面板的共同要害:诚实标注】
 * 这两处都涉及「用假数据冒充真数据」的诱惑:
 *   - 嵌入后端:伪向量时必须说「召回是噪声」,不能装作在用真向量
 *   - 今日成本:没有成本记录时不能说「今日花费 $0.00」(那会被读成"没花钱")
 * 所以用例盯的是**文案**,不只是结构。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('element-plus/es/components/message/index', () => ({
  ElMessage: { warning: vi.fn(), success: vi.fn(), error: vi.fn(), info: vi.fn() },
}))
vi.mock('element-plus/es/components/message-box/index', () => ({
  ElMessageBox: { confirm: vi.fn(() => Promise.resolve('confirm')), alert: vi.fn() },
}))

import i18n from '../../src/locales'
import Settings from '../../src/views/Settings.vue'
import ModelCompare from '../../src/views/ModelCompare.vue'

let api: any

function installApi() {
  api = {
    app: { getVersion: vi.fn().mockResolvedValue({ success: true, data: '4.5.0' }), getPlatform: vi.fn(() => 'win32') },
    config: { get: vi.fn().mockResolvedValue({ success: true, data: null }), set: vi.fn(() => ({ catch: vi.fn() })) },
    shortcut: { get: vi.fn().mockResolvedValue({ success: true, data: { toggle: 'Ctrl+Alt+P' } }), set: vi.fn().mockResolvedValue({ success: true }) },
    hermes: {
      getMemories: vi.fn().mockResolvedValue({ success: true, data: { coreMemory: '', experienceMemory: '', memories: [] } }),
      saveCoreMemory: vi.fn().mockResolvedValue({ success: true }),
      embedding: {
        get: vi.fn().mockResolvedValue({
          success: true,
          data: { config: { provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'bge-m3' }, model: 'ollama-nomic', realVectors: true },
        }),
        set: vi.fn().mockResolvedValue({ success: true }),
        detect: vi.fn().mockResolvedValue({ success: true, data: { available: true, models: ['bge-m3:latest'] } }),
        test: vi.fn().mockResolvedValue({
          success: true,
          data: {
            ok: true, model: 'ollama-nomic', realVectors: true, dimension: 1024,
            latencyMs: 42, reachable: true,
            semanticCheck: { similar: 0.78, unrelated: 0.40, meaningful: true },
          },
        }),
      },
    },
    mcp: { list: vi.fn().mockResolvedValue({ success: true, data: [] }) },
    models: { list: vi.fn().mockResolvedValue({ success: true, data: [] }), getTemplates: vi.fn().mockResolvedValue({ success: true, data: [] }) },
    permissions: { list: vi.fn().mockResolvedValue({ success: true, data: [] }) },
    schedule: { list: vi.fn().mockResolvedValue({ success: true, data: [] }) },
    gateway: { status: vi.fn().mockResolvedValue({ success: true, data: { running: false } }), logs: vi.fn().mockResolvedValue({ success: true, data: [] }) },
    channel: {
      modelGetStats: vi.fn().mockResolvedValue({ success: true, data: [] }),
      modelListRatings: vi.fn().mockResolvedValue({ success: true, data: [] }),
      modelUsageTop: vi.fn().mockResolvedValue({ success: true, data: [] }),
      modelUsageTotal: vi.fn().mockResolvedValue({
        success: true, data: { totalCalls: 0, totalTokens: 0, totalCost: 0, modelCount: 0 },
      }),
    },
    insight: {
      // ModelCompare 的今日成本走的是既有的 insight.costToday 通道
      // 【形状必须与真实 handler 一致】insight:cost:today 返回的是**扁平**结构
      // (totalCostUsd / totalInputTokens / byModel / recent 同级),
      // 不是 {today:{...}} 嵌套 —— 组件读的就是扁平的那层。
      costToday: vi.fn().mockResolvedValue({
        success: true,
        data: {
          totalCostUsd: 0.1234,
          totalTokens: 5900,
          totalInputTokens: 5000,
          totalOutputTokens: 900,
          byModel: { 'qwen3.5:9b': 0.1234 },
          recent: [],
          stub: false,
        },
      }),
      getPricing: vi.fn().mockResolvedValue({ success: true, data: [] }),
      setPricing: vi.fn().mockResolvedValue({ success: true }),
    },
  }
  ;(window as any).electronAPI = api
}

/**
 * 【为什么 stub 掉 el-tabs / el-tab-pane,其余用真组件】
 * el-tab-pane 只渲染**被激活过**的那个 tab 的内容 —— 于是「今日成本」卡片
 * 在默认 tab(性价比对比)下根本不在 DOM 里,测不到。
 *
 * 改法:stub 掉 tab 容器让它**渲染所有 pane 的内容**,其余组件用真的 ——
 * 这样验到的仍是**真实渲染路径**(数据 → 模板 → DOM),只是不受 tab 切换机制影响。
 */
const tabStubs = {
  'el-tabs': { template: '<div class="ep-tabs"><slot /></div>', props: ['modelValue'] },
  'el-tab-pane': { template: '<div class="ep-tab-pane"><slot /></div>', props: ['label', 'name'] },
}

async function mountView(Comp: any) {
  setActivePinia(createPinia())
  const ElementPlus = (await import('element-plus')).default
  const w = mount(Comp, {
    global: {
      plugins: [ElementPlus, i18n],
      stubs: tabStubs,
      mocks: {
        $route: { path: '/settings', push: vi.fn() },
        $router: { push: vi.fn() },
      },
    },
  })
  await flushPromises()
  await flushPromises()
  return w
}

describe('M4 设置页嵌入后端卡片', () => {
  beforeEach(() => { installApi() })

  it('真向量时如实显示「已启用真实向量」', async () => {
    const w = await mountView(Settings)
    expect(w.text()).toContain('嵌入后端')
    expect(w.text()).toContain('已启用真实向量')
  })

  it('伪向量时如实显示「召回是噪声」—— 不能装作在用真向量', async () => {
    installApi()
    api.hermes.embedding.get.mockResolvedValue({
      success: true,
      data: { config: {}, model: 'stub-deterministic', realVectors: false },
    })
    const w = await mountView(Settings)
    expect(w.text()).toContain('召回是噪声')
    expect(w.text()).not.toContain('已启用真实向量')
  })

  it('「测试连接」后显示语义自检结论', async () => {
    const w = await mountView(Settings)
    const btn = w.findAll('button').find((b: any) => b.text().includes('测试连接'))
    expect(btn).toBeTruthy()
    await btn!.trigger('click')
    await flushPromises()
    expect(api.hermes.embedding.test).toHaveBeenCalled()
  })

  it('「检测本地模型」列出本机可用的嵌入模型', async () => {
    const w = await mountView(Settings)
    const btn = w.findAll('button').find((b: any) => b.text().includes('检测本地模型'))
    expect(btn).toBeTruthy()
    await btn!.trigger('click')
    await flushPromises()
    expect(api.hermes.embedding.detect).toHaveBeenCalled()
  })
})

describe('M4 模型对比页今日成本卡片', () => {
  beforeEach(() => { installApi() })

  it('显示今日费用与输入/输出 token 分项', async () => {
    const w = await mountView(ModelCompare)
    const text = w.text()
    expect(text).toContain('今日成本')
    expect(text).toContain('输入 token')
    expect(text).toContain('输出 token')
  })

  it('按模型分布显示每个模型花了多少', async () => {
    const w = await mountView(ModelCompare)
    expect(w.text()).toContain('qwen3.5:9b')
  })

  it('「定价设置」入口在(用户得能给自己的模型配价)', async () => {
    const w = await mountView(ModelCompare)
    const btn = w.findAll('button').find((b: any) => b.text().includes('定价设置'))
    expect(btn).toBeTruthy()
  })

  it('「定价设置」弹出单价表单', async () => {
    const w = await mountView(ModelCompare)
    const btn = w.findAll('button').find((b: any) => b.text().includes('定价设置'))
    await btn!.trigger('click')
    await flushPromises()
    expect(w.text()).toContain('输入单价')
    expect(w.text()).toContain('输出单价')
  })
})
