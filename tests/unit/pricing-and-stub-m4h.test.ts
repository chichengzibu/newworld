/**
 * PiPiClaw — M4-H 定价可维护 + 兜底诚实性测试
 * ═══════════════════════════════════════════════════════════════
 * 【定价这一块在测什么】
 * `CostTracker.setPricing` 此前是**双重死代码**:
 *   ① 零调用方
 *   ② 只改内存,**不落盘** → 重启即丢
 * 而用户自己的模型(API 中转站的模型名、私有部署的模型名)不在默认表里 →
 * 查表落空 → 成本恒 0 → 成本面板永远是 $0.0000,**却看不出原因**。
 *
 * 【兜底诚实性在测什么】
 * 见 tests/unit/stub-honesty-m4h.test.ts —— 兜底实现不能回一句
 * 看起来像正常答复的话。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

vi.mock('electron', () => ({
  app: { getPath: vi.fn((k: string) => `/tmp/pipiclaw-price-${k}`) },
  ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {} },
  BrowserWindow: class {},
  dialog: { showMessageBox: () => {}, showOpenDialog: () => {} },
  shell: { openExternal: () => {}, openPath: () => {} },
  globalShortcut: { register: () => true, unregister: () => {} },
  Menu: { buildFromTemplate: () => ({}), setApplicationMenu: () => {} },
  Tray: class { setToolTip() {} setContextMenu() {} on() {} },
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }) },
}))
vi.mock('electron-log', () => ({
  default: {
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
    transports: { file: { resolvePathFn: () => {}, maxSize: 0, format: '' }, console: { level: 'info' } },
  },
}))

import { CostTracker } from '../../electron/insight/CostTracker'
import { getHost } from '../../electron/platform/runtime'

const USER_DATA = getHost().getPath('userData')

function resetTracker() {
  ;(CostTracker as any).instance = undefined
}

describe('M4-H 模型定价可维护', () => {
  beforeEach(() => {
    resetTracker()
    // 清掉上次留下的定价文件,保证用例独立
    const p = path.join(USER_DATA, 'cost-pricing.json')
    if (fs.existsSync(p)) fs.rmSync(p, { force: true })
  })
  afterEach(() => resetTracker())

  it('默认定价表里有常见模型', () => {
    const tracker = CostTracker.getInstance()
    expect(tracker.getPricing('gpt-4o-mini')).toBeDefined()
    expect(tracker.getPricing('claude-sonnet-4')).toBeDefined()
    // 本地模型条目也要有 —— 成本确实是 0,但要能归到「本地」这一类
    expect(tracker.getPricing('ollama-qwen3.5')).toBeDefined()
  })

  it('设置定价 → 该模型的成本不再恒为 0', () => {
    const tracker = CostTracker.getInstance()
    tracker.setPricing('my-private-model', { inputPer1kUsd: 0.001, outputPer1kUsd: 0.002 })
    tracker.recordUsage({ model: 'my-private-model', inputTokens: 1000, outputTokens: 1000, conversationId: 'c1' })
    const today = tracker.getTodayCost()
    expect(today.totalCostUsd).toBeGreaterThan(0)
  })

  it('定价**落盘** —— 之前只改内存,重启即丢', () => {
    const tracker = CostTracker.getInstance()
    tracker.setPricing('persisted-model', { inputPer1kUsd: 0.5, outputPer1kUsd: 1 })

    const pricingFile = path.join(USER_DATA, 'cost-pricing.json')
    expect(fs.existsSync(pricingFile)).toBe(true)
    const raw = JSON.parse(fs.readFileSync(pricingFile, 'utf-8'))
    expect(raw['persisted-model']).toMatchObject({ inputPer1kUsd: 0.5, outputPer1kUsd: 1 })
  })

  it('重启后自定义定价仍在', () => {
    CostTracker.getInstance().setPricing('kept-model', { inputPer1kUsd: 0.25, outputPer1kUsd: 0.75 })
    resetTracker()   // 模拟重启(新实例)
    const tracker = CostTracker.getInstance()
    expect(tracker.getPricing('kept-model')).toMatchObject({ inputPer1kUsd: 0.25, outputPer1kUsd: 0.75 })
  })

  it('默认表不落盘(只存自定义的)—— 默认表每次启动重新 seed', () => {
    const tracker = CostTracker.getInstance()
    tracker.setPricing('custom-only', { inputPer1kUsd: 0.1, outputPer1kUsd: 0.2 })
    const raw = JSON.parse(fs.readFileSync(path.join(USER_DATA, 'cost-pricing.json'), 'utf-8'))
    expect(Object.keys(raw)).toEqual(['custom-only'])
  })

  it('listPricing 能区分默认与自定义', () => {
    const tracker = CostTracker.getInstance()
    tracker.setPricing('brand-new', { inputPer1kUsd: 0.1, outputPer1kUsd: 0.2 })
    const rows = tracker.listPricing()
    const gpt = rows.find(r => r.model === 'gpt-4o')
    const custom = rows.find(r => r.model === 'brand-new')
    expect(gpt?.custom).toBe(false)
    expect(custom?.custom).toBe(true)
  })

  it('定价改动不影响已记录的用量(只影响之后的计算)', () => {
    const tracker = CostTracker.getInstance()
    tracker.setPricing('later-model', { inputPer1kUsd: 1, outputPer1kUsd: 1 })
    tracker.recordUsage({ model: 'later-model', inputTokens: 100, outputTokens: 100, conversationId: 'c1' })
    const before = tracker.getTodayCost().totalCostUsd
    tracker.setPricing('later-model', { inputPer1kUsd: 2, outputPer1kUsd: 2 })
    const after = tracker.getTodayCost().totalCostUsd
    // 已记录的条目带着自己的 costUsd,不应被追溯改写
    expect(after).toBe(before)
  })
})
