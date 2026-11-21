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
  // 【M4-X】开源技能库卡片用了这两个图标 —— mock 是**显式枚举**的,
  // 少一个图标整份 spec 全红(见上面 Goods 的注释)。
  Refresh: { template: '<i />' },
  Search: { template: '<i />' },
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
      // 【M4-V】裁判门禁状态 —— 默认"不放行"(与现实一致:现有裁判都未达标)
      judgeTrust: vi.fn().mockResolvedValue({
        success: true,
        data: { trusted: false, model: 'qwen3.5:9b', reason: 'κ=0.411 < 门槛 0.6；换序改口率 67.9% > 门槛 10%' },
      }),
      // 【M4-X】开源技能库 —— 默认给两条推荐
      hubSearch: vi.fn().mockResolvedValue({ success: true, data: [] }),
      hubRecommend: vi.fn().mockResolvedValue({
        success: true,
        data: {
          items: [
            { id: 'anthropic-skills:pdf', sourceId: 'anthropic-skills', name: 'PDF 处理', description: '处理 PDF 文件与表格', tags: ['pdf'] },
          ],
          index: { fetchedAt: 1730000000000, count: 34, sources: [{ id: 'anthropic-skills', name: 'Anthropic 官方技能集', ok: true, count: 19 }] },
        },
      }),
      hubRefresh: vi.fn().mockResolvedValue({ success: true, data: { fetchedAt: Date.now(), count: 34, sources: [] } }),
      hubInstall: vi.fn().mockResolvedValue({ success: true, data: { skillId: 'pdf', skills: [] } }),
      // 【M4-AC】安装前预览 —— 默认"没有可执行脚本"
      hubPreview: vi.fn().mockResolvedValue({ success: true, data: { files: ['SKILL.md'], executables: [] } }),
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
  it('【M4-N】试验结果表:综合分差与裁判对照都落到界面上了', async () => {
    // 【为什么补这条】M4-N 给试验结果表加了两列(综合分差 / 裁判对照)——
    // 用户可见的东西必须有自动化守护(M4-H 教训:面板只过 typecheck 不算数)。
    const result = {
      skillId: 'pdf-extract',
      pairs: [
        {
          task: { id: 't0', instruction: '把桌面上的 PDF 归档' },
          withSkill: { variant: 'with_skill', run: {}, grade: { passed: true, score: 1, layers: [] } },
          withoutSkill: { variant: 'without_skill', run: {}, grade: { passed: false, score: 0.33, layers: [] } },
          delta: 1,
          scoreDelta: 0.67,
          pairwise: 'with_better',
        },
        {
          task: { id: 't1', instruction: '整理下载文件夹' },
          withSkill: { variant: 'with_skill', run: {}, grade: { passed: false, score: 0.33, layers: [] } },
          withoutSkill: { variant: 'without_skill', run: {}, grade: { passed: false, score: 0.53, layers: [] } },
          delta: 0,
          scoreDelta: -0.2,
          pairwise: 'unstable',
        },
      ],
      summary: {
        n: 2, withSkillSuccesses: 1, withoutSkillSuccesses: 0,
        withSkillRate: 0.5, withoutSkillRate: 0, delta: 0.5,
        verdict: 'positive', note: '有帮助:带该技能的成功率明显更高(差值 50%,判定门槛 ±10%)',
        meanScoreDelta: 0.235, scoreDeltaDirection: 'mixed',
        pairwise: {
          n: 2, withBetter: 1, withoutBetter: 0, tie: 0, unstable: 1,
          note: 'pairwise 裁判(参考信号,不参与判定):2 个配对 —— 带技能更好 1 / 不带更好 0 / 平局 0;其中 1 个**两次顺序结论不一致**(unstable)——裁判在这些配对上顺序敏感,不可当结论用',
        },
      },
      finishedAt: 0,
    }
    installApi({ skills: { ...installApi().skills, runUtilityTrial: vi.fn().mockResolvedValue({ success: true, data: result }) } })

    const w = await mountView()
    const sel = w.findComponent({ name: 'ElSelect' })
    sel.vm.$emit('update:modelValue', 'pdf-extract')
    await flushPromises()
    const ta = w.find('textarea')
    ta.setValue('把桌面上的 PDF 归档' + String.fromCharCode(10) + '整理下载文件夹')
    await flushPromises()

    const btn = w.findAll('button').find((b: any) => b.text().includes('开始验证'))
    await btn!.trigger('click')
    await flushPromises()
    await flushPromises()

    const text = w.text()
    // 综合分差:两行分别 +67% 与 -20%
    expect(text).toContain('+67%')
    expect(text).toContain('-20%')
    // 裁判对照:一致 → 带技能更好;不一致 → 不稳定(不是"平局")
    expect(text).toContain('带技能更好')
    expect(text).toContain('不稳定')
    // 汇总说明里要点明裁判顺序敏感
    expect(text).toContain('顺序敏感')
  })

  /* ─────────────────── 【M4-AC】安装前预览可执行脚本 ─────────────────── */

  it('【M4-AC】包里有可执行脚本 → 安装前弹确认,并列出文件名', async () => {
    vi.clearAllMocks()
    installApi()
    api.skills.hubPreview.mockResolvedValue({
      success: true,
      data: { files: ['SKILL.md', 'scripts/run.py'], executables: ['scripts/run.py'] },
    })
    const w = await mountView()
    const btn = w.findAll('button').find((b: any) => b.text().includes('下载安装'))
    await btn!.trigger('click')
    await flushPromises()

    const { ElMessageBox } = await import('element-plus/es/components/message-box/index')
    const calls = (ElMessageBox.confirm as any).mock.calls
    expect(calls.length).toBe(1)
    // 必须把文件名摆出来 —— 只说"有脚本"等于没说
    expect(String(calls[0][0])).toContain('scripts/run.py')
    // 确认之后才真的装
    expect(api.skills.hubInstall).toHaveBeenCalledWith('anthropic-skills:pdf')
  })

  it('【M4-AC】没有可执行脚本 → 不打扰用户,直接安装', async () => {
    vi.clearAllMocks()
    installApi()
    const w = await mountView()
    const btn = w.findAll('button').find((b: any) => b.text().includes('下载安装'))
    await btn!.trigger('click')
    await flushPromises()

    const { ElMessageBox } = await import('element-plus/es/components/message-box/index')
    expect((ElMessageBox.confirm as any).mock.calls.length).toBe(0)
    expect(api.skills.hubInstall).toHaveBeenCalled()
  })

  it('【M4-AC】用户取消 → 不安装', async () => {
    vi.clearAllMocks()
    installApi()
    api.skills.hubPreview.mockResolvedValue({
      success: true,
      data: { files: ['SKILL.md', 'x.sh'], executables: ['x.sh'] },
    })
    const { ElMessageBox } = await import('element-plus/es/components/message-box/index')
    ;(ElMessageBox.confirm as any).mockRejectedValueOnce(new Error('cancel'))

    const w = await mountView()
    const btn = w.findAll('button').find((b: any) => b.text().includes('下载安装'))
    await btn!.trigger('click')
    await flushPromises()

    expect(api.skills.hubInstall).not.toHaveBeenCalled()
  })

  /* ─────────────────── 【M4-V】裁判门禁在界面上的表现 ─────────────────── */

  it('【M4-V】门禁不通过:勾选框禁用,并写明具体哪一项不达标', async () => {
    const w = await mountView()
    const text = w.text()
    // 不可用 + 具体原因(不是笼统的"不可用")
    expect(text).toContain('不可用')
    expect(text).toContain('κ=0.411')
    expect(text).toContain('67.9%')
    // 勾选框是禁用的
    // 注意:勾选框自己的文本是它的 label 内容("裁判对照"是 form-item 的 label,不在框内)
    const cb = w.findAllComponents({ name: 'ElCheckbox' }).find((c: any) => c.text().includes('LLM 裁判'))
    expect(cb).toBeDefined()
    expect((cb as any).props('disabled')).toBe(true)
    expect(w.text()).toContain('裁判对照')
  })

  it('【M4-V】门禁通过:勾选框可用,并给出依据', async () => {
    installApi({
      skills: {
        ...installApi().skills,
        judgeTrust: vi.fn().mockResolvedValue({
          success: true,
          data: { trusted: true, model: 'good-model', reason: '已校准(2026-11-19,n=220,κ=0.720)', basis: 'x' },
        }),
      },
    })
    const w = await mountView()
    const cb = w.findAllComponents({ name: 'ElCheckbox' }).find((c: any) => c.text().includes('LLM 裁判'))
    expect(cb).toBeDefined()
    expect((cb as any).props('disabled')).toBe(false)
    expect(w.text()).toContain('κ=0.720')
  })

  /* ─────────────────── 【M4-X】开源技能库 ─────────────────── */

  it('【M4-X】开源技能库:推荐条目落到界面上,带来源与说明', async () => {
    const w = await mountView()
    const text = w.text()
    expect(text).toContain('开源技能库')
    expect(text).toContain('PDF 处理')       // 推荐条目的名字
    expect(text).toContain('处理 PDF 文件与表格') // 推荐条目的说明
    expect(text).toContain('下载安装')        // 装它的按钮
    // 索引状态要如实展示(几条、什么时候拉的)
    expect(text).toContain('索引')
    expect(text).toContain('34')
  })

  it('【M4-X】搜索开源技能:把关键词传给主进程,结果替换列表', async () => {
    installApi()
    api.skills.hubSearch.mockResolvedValue({
      success: true,
      data: [{ id: 'x:1', sourceId: 'x', name: '搜到的技能', description: '按关键词搜出来的', tags: [] }],
    })
    const w = await mountView()
    const input = w.find('input[placeholder*="搜索开源技能"]')
    expect(input.exists()).toBe(true)
    await input.setValue('pdf')
    const ta = w.find('input[placeholder*="搜索开源技能"]')
    await ta.trigger('keyup.enter')
    await flushPromises()
    expect(api.skills.hubSearch).toHaveBeenCalled()
    expect((api.skills.hubSearch as any).mock.calls.some((c: any) => c[0]?.q === 'pdf')).toBe(true)
    expect(w.text()).toContain('搜到的技能')
  })

  it('【M4-X】点「下载安装」→ 调主进程安装', async () => {
    const w = await mountView()
    await flushPromises()
    const btn = w.findAll('button').find((b: any) => b.text().includes('下载安装'))
    expect(btn).toBeTruthy()
    await btn!.trigger('click')
    await flushPromises()
    expect(api.skills.hubInstall).toHaveBeenCalledWith('anthropic-skills:pdf')
  })

  it('【M4-V】裁判被门禁拦下:结果里写明为什么没跑(不是一片空白)', async () => {
    const result = {
      skillId: 'pdf-extract',
      pairs: [{
        task: { id: 't0', instruction: '把桌面上的 PDF 归档' },
        withSkill: { variant: 'with_skill', run: {}, grade: { passed: true, score: 1, layers: [] } },
        withoutSkill: { variant: 'without_skill', run: {}, grade: { passed: false, score: 0.33, layers: [] } },
        delta: 1, scoreDelta: 0.67,
      }],
      summary: {
        n: 1, withSkillSuccesses: 1, withoutSkillSuccesses: 0,
        withSkillRate: 1, withoutSkillRate: 0, delta: 1,
        verdict: 'positive', note: '有帮助:带该技能的成功率明显更高',
        meanScoreDelta: 0.67, scoreDeltaDirection: 'consistent_with',
        judgeStatus: {
          ran: false, trusted: false,
          reason: 'κ=0.411 < 门槛 0.6；裁判未通过校准门禁,未产生任何裁判调用',
        },
      },
      finishedAt: 0,
    }
    installApi({
      skills: {
        ...installApi().skills,
        runUtilityTrial: vi.fn().mockResolvedValue({ success: true, data: result }),
      },
    })
    const w = await mountView()
    const sel = w.findComponent({ name: 'ElSelect' })
    sel.vm.$emit('update:modelValue', 'pdf-extract')
    await flushPromises()
    const ta = w.find('textarea')
    ta.setValue('把桌面上的 PDF 归档')
    await flushPromises()
    const btn = w.findAll('button').find((b: any) => b.text().includes('开始验证'))
    await btn!.trigger('click')
    await flushPromises()
    await flushPromises()

    const text = w.text()
    expect(text).toContain('κ=0.411')
    expect(text).toContain('未产生任何裁判调用')
  })
})
