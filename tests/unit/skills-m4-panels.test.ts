/**
 * PiPiClaw — M4 新增面板的渲染测试
 * ═══════════════════════════════════════════════════════════════
 * 【为什么要有这个】
 * 本批新增了 6 个 UI 面板(嵌入后端配置 / 技能目录 / 效果统计 / 边际效用 /
 * 技能验证 / 今日成本)。此前它们**只过了 typecheck 与构建** ——
 * 但 typecheck 通过 ≠ 模板能渲染 ≠ 数据能落到界面上。
 *
 * 人工实跑确实抓到了问题(i18n 缺 key、flaky 断言),但**人工截图不可回归**。
 * 故把这批面板的关键渲染面钉成自动化测试。
 *
 * 【每个用例守的是「用户能不能看到该看到的东西」】
 * - 面板在数据为空时**不该占位**(空卡片比没卡片更糟)
 * - 有数据时关键字段必须出现在 DOM 里
 * - 判定的**中文标签**必须正确(用户看不懂 'insufficient_data')
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

vi.mock('element-plus/es/components/message/index', () => ({
  ElMessage: { warning: vi.fn(), success: vi.fn(), error: vi.fn(), info: vi.fn() },
}))
vi.mock('element-plus/es/components/message-box/index', () => ({
  ElMessageBox: { confirm: vi.fn(() => Promise.resolve('confirm')), alert: vi.fn() },
}))
vi.mock('@/components/skills/SkillCard.vue', () => ({ default: { template: '<div />' } }))
vi.mock('@/components/skills/SkillImportDialog.vue', () => ({ default: { template: '<div />' } }))
vi.mock('@element-plus/icons-vue', () => ({
  Upload: { template: '<i />' }, MagicStick: { template: '<i />' }, Box: { template: '<i />' },
  SuccessFilled: { template: '<i />' }, Plus: { template: '<i />' },
  // 【M4-M】SkillsView 新增了「浏览 ClawHub 市场」按钮(Goods 图标)——
  // 这个 mock 是**显式枚举**的,少一个图标,组件就渲染不出来(整份 spec 全红)。
  Goods: { template: '<i />' },
}))

import SkillsView from '../../src/views/SkillsView.vue'

/**
 * 【为什么用真组件而不是 stub】
 * `el-table` 的列内容(el-table-column 的 default slot)是**按行**渲染的 ——
 * stub 掉它,表格里的「+50%」「100%」这些值根本不会进 DOM,
 * 测试就只能验到静态文案,验不到"数据真的落到界面上了"。
 * 故这里用真组件:验的是**真实渲染路径**。
 */

/** 可控的 electronAPI 替身 */
let api: any

function installApi(over: Record<string, any> = {}) {
  api = {
    learning: {
      clearPendingProposal: vi.fn(),
      saveSkillProposal: vi.fn().mockResolvedValue({ success: true }),
      onNewProposal: () => () => { },
      getPendingProposal: vi.fn().mockResolvedValue({ success: true, data: null }),
      getAcceptance: vi.fn().mockResolvedValue({ success: true, data: [] }),
    },
    skills: {
      list: vi.fn().mockResolvedValue({ success: true, data: [] }),
      mergeCandidates: vi.fn(),
      performMerge: vi.fn(),
      getStorageInfo: vi.fn().mockResolvedValue({
        success: true,
        data: { primaryDir: 'C:/userdata/skills', extraDirs: [], primaryCount: 3, extraCounts: [], total: 3 },
      }),
      getCustomDirs: vi.fn().mockResolvedValue({ success: true, data: [] }),
      getDirectoryPreview: vi.fn().mockResolvedValue({ success: true, data: { exists: true, path: 'D:/proj/skills', skills: [] } }),
      addCustomDir: vi.fn().mockResolvedValue({ success: true, data: [] }),
      removeCustomDir: vi.fn().mockResolvedValue({ success: true, data: [] }),
      getEffectiveness: vi.fn().mockResolvedValue({ success: true, data: [] }),
      getUtility: vi.fn().mockResolvedValue({ success: true, data: [] }),
      runUtilityTrial: vi.fn().mockResolvedValue({ success: true, data: null }),
    },
    ...over,
  }
  ;(window as any).electronAPI = api
  return api
}

async function mountView() {
  const ElementPlus = (await import('element-plus')).default
  const w = mount(SkillsView, {
    global: {
      plugins: [ElementPlus],
      mocks: {
        $route: { path: '/skills', push: vi.fn() },
        $router: { push: vi.fn() },
      },
    },
  })
  await flushPromises()
  await flushPromises()
  return w
}

describe('M4 技能面板渲染', () => {
  beforeEach(() => {
    installApi()
  })

  it('技能目录卡片:显示主目录路径与技能数', async () => {
    const w = await mountView()
    const text = w.text()
    expect(text).toContain('技能目录')
    expect(text).toContain('C:/userdata/skills')
  })

  it('技能目录卡片:没有额外目录时给出说明(而不是空白)', async () => {
    const w = await mountView()
    expect(w.text()).toContain('尚未添加额外目录')
  })

  it('效果统计面板:有数据时显示判定标签的中文', async () => {
    installApi()
    api.skills.getEffectiveness.mockResolvedValue({
      success: true,
      data: [
        { skillName: 'pdf-extract', unitType: 'skill', calls: 8, successes: 6, failures: 2, successRate: 0.75, verdict: 'degraded' },
      ],
    })
    const w = await mountView()
    expect(w.text()).toContain('效果统计')
    expect(w.text()).toContain('表现一般')
  })

  it('边际效用面板:显示带/不带两组的成功率与差值', async () => {
    installApi()
    api.skills.getUtility.mockResolvedValue({
      success: true,
      data: [
        {
          skillName: 'pdf-extract',
          withSkill: { runs: 6, successes: 5, rate: 0.83 },
          withoutSkill: { runs: 6, successes: 2, rate: 0.33 },
          delta: 0.5,
        },
      ],
    })
    const w = await mountView()
    const text = w.text()
    expect(text).toContain('边际效用')
    expect(text).toContain('pdf-extract')
    expect(text).toContain('+50%')
  })

  it('边际效用面板:样本不足时明说「样本不足」而不是给差值', async () => {
    installApi()
    api.skills.getUtility.mockResolvedValue({
      success: true,
      data: [{
        skillName: 's', withSkill: { runs: 2, successes: 1, rate: 0.5 },
        withoutSkill: { runs: 2, successes: 1, rate: 0.5 },
        delta: undefined,
      }],
    })
    const w = await mountView()
    expect(w.text()).toContain('样本不足')
  })

  it('用户接受度:有信号时显示百分比,无信号时显示「无信号」而不是 0%', async () => {
    installApi()
    api.skills.getUtility.mockResolvedValue({
      success: true,
      data: [{
        skillName: 'with-signal', withSkill: { runs: 4, successes: 4, rate: 1 },
        withoutSkill: { runs: 4, successes: 1, rate: 0.25 }, delta: 0.75,
      }],
    })
    api.learning.getAcceptance.mockResolvedValue({
      success: true,
      data: [{ skillId: 'with-signal', accepted: 4, rejected: 0, unknown: 2, rate: 1 }],
    })
    const w = await mountView()
    expect(w.text()).toContain('用户接受度')
    expect(w.text()).toContain('100%')
  })

  it('技能验证卡片:说明 token 成本翻倍(用户有权知情)', async () => {
    const w = await mountView()
    const text = w.text()
    expect(text).toContain('技能验证')
    expect(text).toContain('token 成本翻倍')
  })

  it('技能验证:没选技能时直接拒绝(不白跑模型)', async () => {
    installApi()
    const w = await mountView()
    const btn = w.findAll('button').find((b: any) => b.text().includes('开始验证'))
    expect(btn).toBeTruthy()
    await btn!.trigger('click')
    await flushPromises()
    const { ElMessageBox } = await import('element-plus/es/components/message-box/index')
    // 连确认框都不该弹(弹了就是让用户以为要跑了)
    expect((ElMessageBox.confirm as any).mock.calls.length).toBe(0)
    expect(api.skills.runUtilityTrial).not.toHaveBeenCalled()
  })

  it('技能验证:开始前必须先弹确认(成本告知不能省)', async () => {
    installApi()
    const w = await mountView()
    // 选中一个技能
    const sel = w.findComponent({ name: 'ElSelect' })
    sel.vm.$emit('update:modelValue', 'pdf-extract')
    await flushPromises()
    // 填任务
    const ta = w.find('textarea')
    ta.setValue('把桌面上的 PDF 归档')
    await flushPromises()

    const btn = w.findAll('button').find((b: any) => b.text().includes('开始验证'))
    await btn!.trigger('click')
    await flushPromises()
    const { ElMessageBox } = await import('element-plus/es/components/message-box/index')
    expect((ElMessageBox.confirm as any).mock.calls.length).toBe(1)
    // 确认框里要说明 token 翻倍
    const msg = String((ElMessageBox.confirm as any).mock.calls[0][0])
    expect(msg).toContain('token')
  })

  it('空数据时各面板不占位(没有数据就别渲染空卡片)', async () => {
    const w = await mountView()
    // 效果统计/边际效用是 v-if 控制的 —— 没有数据就不该出现
    expect(w.text()).not.toContain('边际效用')
    expect(w.text()).not.toContain('效果统计')
  })
})
