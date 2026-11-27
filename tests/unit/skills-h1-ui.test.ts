/**
 * #007 L6b (订单 d④ 诚实文案):
 *   SkillsView 收到超期提案 (createdAt > 30min) → pendingProposal=null
 *   + clearPendingProposal 被调 + ElMessage.warning("提案已超期自动忽略") (非静默丢弃)
 *   未超期 → pendingProposal 保留 + 零 warning
 *
 * 触发面实读: SkillsView.vue:385-402 onMounted → window.require('electron').ipcRenderer
 *   .on('skills:new-proposal', handler) — 本测试 mock window.require 捕获 handler 直触发 (不依赖 jsdom 路由)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'

const warningMock = vi.fn()
const successMock = vi.fn()
vi.mock('element-plus/es/components/message/index', () => ({
  ElMessage: {
    warning: (m: any) => warningMock(m),
    success: (m: any) => successMock(m),
    error: vi.fn(),
    info: vi.fn(),
  },
}))
vi.mock('element-plus/es/components/message-box/index', () => ({
  ElMessageBox: { confirm: vi.fn(() => Promise.resolve('confirm')), alert: vi.fn() },
}))
vi.mock('@/components/skills/SkillCard.vue', () => ({ default: { template: '<div />' } }))
vi.mock('@/components/skills/SkillImportDialog.vue', () => ({ default: { template: '<div />' } }))
vi.mock('@element-plus/icons-vue', () => ({
  Upload: { template: '<i />' }, MagicStick: { template: '<i />' }, Box: { template: '<i />' }, SuccessFilled: { template: '<i />' },
  // 【M4-M】SkillsView 的「浏览 ClawHub 市场」按钮用了 Goods 图标 —— mock 是显式枚举的
  Goods: { template: '<i />' },
  // 【M4-X】开源技能库卡片用了这两个图标 —— mock 是显式枚举的,少一个就整份 spec 全红
  Refresh: { template: '<i />' }, Search: { template: '<i />' },
}))

import SkillsView from '../../src/views/SkillsView.vue'
import * as messageAPI from 'element-plus/es/components/message/index'

function epStub(name: string) {
  return { name, template: '<div><slot /></div>' }
}

let onCallback: ((proposal: any) => void) | null = null

/**
 * 【M4-A】订阅方式已变 —— mock 随之更新。
 *
 * 此前 SkillsView 用 `window.require('electron').ipcRenderer` 订阅,
 * 但渲染窗口是 contextIsolation: true,window.require 是 undefined,
 * 订阅永远注册不上,提案横幅不可能出现。
 * 现经 preload 暴露的 learning.onNewProposal 订阅。
 */
function installRequireMock() {
  const clearPendingSpy = vi.fn()
  ;(window as any).electronAPI = {
    learning: {
      clearPendingProposal: clearPendingSpy,
      saveSkillProposal: vi.fn().mockResolvedValue({ success: true }),
      // 【M4-A】新订阅入口
      onNewProposal: (cb: (proposal: any) => void) => {
        onCallback = cb
        return () => { onCallback = null }
      },
      getPendingProposal: vi.fn().mockResolvedValue({ success: true, data: null }),
    },
    skills: { list: vi.fn().mockResolvedValue({ success: true, data: [] }), mergeCandidates: vi.fn(), performMerge: vi.fn() },
  }
  return clearPendingSpy
}

describe('#007 L6b: SkillsView H1 超期拒绝 (收到时刻判定 + 诚实文案)', () => {
  let wrapper: any
  let clearPendingSpy: any

  beforeEach(() => {
    warningMock.mockClear()
    successMock.mockClear()
    onCallback = null
    clearPendingSpy = installRequireMock()
    wrapper = mount(SkillsView as any, {
      global: {
        components: {
          elButton: epStub('el-button'), elIcon: epStub('el-icon'), elAlert: epStub('el-alert'),
        },
        stubs: { ElButton: true, ElIcon: true, ElAlert: true },
      },
    })
  })

  afterEach(() => {
    wrapper?.unmount()
    vi.restoreAllMocks()
  })

  it('L6b-1: 提案超 30 分钟 → 拒绝 + 诚实文案 + clearPendingProposal 被调; pendingProposal=null', async () => {
    expect(typeof onCallback).toBe('function')
    const stale = {
      id: 'p-stale', name: 'stale', description: 'd', triggerCondition: 'c',
      keywords: [], operationSteps: [], fullInstructions: '', createdAt: Date.now() - 31 * 60 * 1000,
    }
    onCallback!(stale)
    await new Promise(r => setTimeout(r, 30))
    await new Promise(r => setTimeout(r, 30))

    expect(warningMock).toHaveBeenCalledTimes(1)
    expect(warningMock).toHaveBeenCalledWith('提案已超期自动忽略')
    expect(clearPendingSpy).toHaveBeenCalled()
  })

  it('L6b-2: 提案 5 分钟前 → pendingProposal 保留 (不超期) + 零 warning + 零 clear', async () => {
    const fresh = {
      id: 'p-fresh', name: 'fresh', description: 'd', triggerCondition: 'c',
      keywords: [], operationSteps: [], fullInstructions: '', createdAt: Date.now() - 5 * 60 * 1000,
    }
    onCallback!(fresh)
    await new Promise(r => setTimeout(r, 30))

    expect(warningMock).not.toHaveBeenCalled()
    expect(clearPendingSpy).not.toHaveBeenCalled()
    // 横幅渲染面: pendingProposal 在场 → data-testid 锚点存在
    expect(wrapper.find('[data-testid="proposal-banner"]').exists()).toBe(true)
    // 诚实文案锚: "30 分钟未操作自动忽略" 提示在场 (订单 d④)
    expect(wrapper.find('[data-testid="proposal-expiry"]').text()).toContain('30 分钟未操作自动忽略')
  })
})
