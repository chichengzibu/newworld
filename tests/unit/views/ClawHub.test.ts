import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

/**
 * New World — 私有技能仓库页面测试（M4-X）
 * ═══════════════════════════════════════════════════════════════════════
 * 【这一批在测什么】
 * M4-X 把本页的 4 个**本地演示**页签删了(本地市场/发布/审核/模板 ——
 * 审计结论:下载是 stub、审核通过的条目永远装不上、模板实例化写到
 * `userData/templates/` 而 SkillLoader 从不扫那个目录)。
 * 本页现在**只剩远程仓库** —— 自建仓库、zip 带 Ed25519 签名。
 *
 * 所以这里测的是:
 *   ① 页面如实呈现"私有技能仓库"与它与开源技能库的区别
 *   ② 连仓库 → 调 registry IPC → 列出条目
 *   ③ 安装 → 调 install IPC
 *   ④ 连不上 → **说清楚失败**(不能一片空白)
 */

const ElMessageMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }))
vi.mock('element-plus', () => ({ ElMessage: ElMessageMock }))
vi.mock('element-plus/es/components/message/index', () => ({ ElMessage: ElMessageMock }))

const mockRegistry = [
  { id: 'r1', name: '内部 PDF 工具', description: '公司专用的 PDF 处理', category: 'internal', tags: ['pdf'], version: '1.2.0', installedVersion: '1.0.0', hasUpdate: true },
  { id: 'r2', name: '内部部署助手', description: '部署流水线相关', category: 'devops', tags: ['deploy'], version: '0.9.0', installedVersion: undefined, hasUpdate: false },
]

;(window as any).electronAPI = {
  channel: {
    clawhubRegistryList: vi.fn().mockResolvedValue({ success: true, data: mockRegistry }),
    clawhubRegistryInstall: vi.fn().mockResolvedValue({ success: true, data: { skillId: 'r1' } }),
  },
}

const elementPlusStubs = {
  'el-button': { template: '<button class="el-button-stub" @click="$emit(\'click\')"><slot /></button>' },
  'el-input': { template: '<input class="el-input-stub" />' },
  'el-card': { template: '<div class="el-card-stub"><slot /></div>' },
  'el-tag': { template: '<span class="el-tag-stub"><slot /></span>' },
  // 真实的 el-alert 渲染 title 属性 —— stub 也要渲染,否则界面上的提示语测不到
  'el-alert': { template: '<div class="el-alert-stub">{{ title }}</div>', props: ['title'] },
  'el-row': { template: '<div class="el-row-stub"><slot /></div>' },
  'el-col': { template: '<div class="el-col-stub"><slot /></div>' },
  'el-skeleton': { template: '<div class="el-skeleton-stub" />' },
}

import ClawHub from '../../../src/views/ClawHub.vue'

async function mountView() {
  const w = mount(ClawHub, { global: { stubs: elementPlusStubs } })
  await flushPromises()
  return w
}

describe('M4-X 私有技能仓库页面', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(window as any).electronAPI.channel.clawhubRegistryList.mockResolvedValue({ success: true, data: mockRegistry })
    ;(window as any).electronAPI.channel.clawhubRegistryInstall.mockResolvedValue({ success: true, data: { skillId: 'r1' } })
  })

  it('页面标题是「私有技能仓库」,并说清与开源技能库的区别', async () => {
    const w = await mountView()
    const text = w.text()
    expect(text).toContain('私有技能仓库')
    expect(text).toContain('开源技能库')
    // 本地演示的那套不该再出现在界面上
    expect(text).not.toContain('本地演示模式')
    expect(text).not.toContain('发布技能')
    expect(text).not.toContain('审核队列')
  })

  it('点「连接仓库」→ 调 registry 列表 IPC', async () => {
    const w = await mountView()
    const btn = w.findAll('button').find((b: any) => b.text().includes('连接仓库'))
    expect(btn).toBeTruthy()
    await btn!.trigger('click')
    await flushPromises()
    expect((window as any).electronAPI.channel.clawhubRegistryList).toHaveBeenCalled()
  })

  it('连上后列出条目:名称、说明、版本、可更新标记', async () => {
    const w = await mountView()
    const btn = w.findAll('button').find((b: any) => b.text().includes('连接仓库'))
    await btn!.trigger('click')
    await flushPromises()
    const text = w.text()
    expect(text).toContain('内部 PDF 工具')
    expect(text).toContain('公司专用的 PDF 处理')
    expect(text).toContain('v1.2.0')
    expect(text).toContain('可更新')
    expect(text).toContain('未安装')
  })

  it('点「安装」→ 调 registry 安装 IPC', async () => {
    const w = await mountView()
    const btn = w.findAll('button').find((b: any) => b.text().includes('连接仓库'))
    await btn!.trigger('click')
    await flushPromises()
    const installBtn = w.findAll('button').find((b: any) => b.text().trim() === '安装')
    expect(installBtn).toBeTruthy()
    await installBtn!.trigger('click')
    await flushPromises()
    expect((window as any).electronAPI.channel.clawhubRegistryInstall).toHaveBeenCalledWith('r2', undefined)
  })

  it('连不上 → 说清楚失败(不是一片空白)', async () => {
    ;(window as any).electronAPI.channel.clawhubRegistryList.mockResolvedValue({ success: false, error: 'HTTP 404' })
    const w = await mountView()
    const btn = w.findAll('button').find((b: any) => b.text().includes('连接仓库'))
    await btn!.trigger('click')
    await flushPromises()
    expect(ElMessageMock.error).toHaveBeenCalled()
    expect(String((ElMessageMock.error as any).mock.calls[0][0])).toContain('404')
  })

  it('没连接时给用户视角的下一步指引(环境变量细节收进 hover tooltip, 审计 #P1-5)', async () => {
    ;(window as any).electronAPI.channel.clawhubRegistryList.mockResolvedValue({ success: true, data: [] })
    const w = await mountView()
    const btn = w.findAll('button').find((b: any) => b.text().includes('连接仓库'))
    await btn!.trigger('click')
    await flushPromises()
    const text = w.text()
    expect(text).toContain('尚未连接私有技能仓库')
    // 运维细节(环境变量/文件路径)保留在 tooltip 里, 不再常驻正文
    const hint = w.find('.empty-hint p')
    const tip = String(hint.attributes('title') ?? '')
    expect(tip).toContain('NW_CLAWHUB_REGISTRY')
    expect(tip).toContain('NW_CLAWHUB_PUBKEY')
  })
})
