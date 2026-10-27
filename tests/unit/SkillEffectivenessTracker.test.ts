import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as fs from 'node:fs'

vi.mock('electron', () => ({
  app: { getPath: vi.fn((k: string) => `/tmp/pipiclaw-set-${k}`) },
}))

vi.mock('electron-log', () => ({
  default: {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    transports: {
      file: { resolvePathFn: () => {}, maxSize: 0, format: '', level: 'info' },
      console: { level: 'info', format: '' },
    },
  },
}))

import { SkillEffectivenessTracker } from '../../electron/learning/SkillEffectivenessTracker'

describe('SkillEffectivenessTracker', () => {
  let tracker: SkillEffectivenessTracker

  beforeEach(() => {
    vi.clearAllMocks()
    ;(SkillEffectivenessTracker as any).instance = undefined
    tracker = SkillEffectivenessTracker.getInstance()
  })

  it('getInstance returns singleton', () => {
    expect(SkillEffectivenessTracker.getInstance()).toBe(tracker)
  })

  it('record stores a call record', () => {
    tracker.record({ skillName: 'A', ts: Date.now(), durationMs: 100, success: true })
    const stats = tracker.getStats('A')
    expect(stats).toBeDefined()
    expect(stats?.calls).toBe(1)
    expect(stats?.successes).toBe(1)
    expect(stats?.failures).toBe(0)
  })

  it('getStats aggregates calls successes and failures', () => {
    tracker.record({ skillName: 'B', ts: Date.now(), durationMs: 50, success: true })
    tracker.record({ skillName: 'B', ts: Date.now(), durationMs: 50, success: false })
    tracker.record({ skillName: 'B', ts: Date.now(), durationMs: 50, success: true })
    const stats = tracker.getStats('B')
    expect(stats?.calls).toBe(3)
    expect(stats?.successes).toBe(2)
    expect(stats?.failures).toBe(1)
  })

  it('getStats returns undefined for unknown skill', () => {
    expect(tracker.getStats('never-called')).toBeUndefined()
  })

  it('avgDurationMs computed across calls', () => {
    tracker.record({ skillName: 'avg', ts: 1, durationMs: 100, success: true })
    tracker.record({ skillName: 'avg', ts: 2, durationMs: 200, success: true })
    const stats = tracker.getStats('avg')
    expect(stats?.avgDurationMs).toBe(150)
  })

  it('recommendRollback returns true for low success rate', () => {
    tracker.record({ skillName: 'rb', ts: 1, durationMs: 10, success: false })
    tracker.record({ skillName: 'rb', ts: 2, durationMs: 10, success: false })
    tracker.record({ skillName: 'rb', ts: 3, durationMs: 10, success: true })
    expect(tracker.recommendRollback('rb')).toBe(true)
  })

  it('recommendRollback returns false for healthy skill', () => {
    tracker.record({ skillName: 'good', ts: 1, durationMs: 10, success: true })
    tracker.record({ skillName: 'good', ts: 2, durationMs: 10, success: true })
    tracker.record({ skillName: 'good', ts: 3, durationMs: 10, success: true })
    expect(tracker.recommendRollback('good')).toBe(false)
  })

  it('listAllStats returns stats per unique skill', () => {
    tracker.record({ skillName: 'x', ts: 1, durationMs: 10, success: true })
    tracker.record({ skillName: 'y', ts: 1, durationMs: 10, success: true })
    const all = tracker.listAllStats()
    const names = all.map(s => s.skillName)
    expect(names).toContain('x')
    expect(names).toContain('y')
  })

  // ══════════ 【M4-B】效果判定 ══════════
  // 背景:业界实测「support counts / helpful-harmful counters 是最小可用信号」,
  // 但计数不是结论 —— 需要一个低基数的判定标签才能被展示、排序、筛选。
  describe('M4-B 效果判定 (getVerdict)', () => {
    it('未被调用 → untested', () => {
      const v = tracker.getVerdict('never')
      expect(v.verdict).toBe('untested')
      expect(v.calls).toBe(0)
      expect(v.successRate).toBeUndefined()
    })

    it('样本不足(调用 < 3)→ insufficient_data,不下结论', () => {
      tracker.record({ skillName: 'few', ts: 1, durationMs: 10, success: false })
      tracker.record({ skillName: 'few', ts: 2, durationMs: 10, success: false })
      const v = tracker.getVerdict('few')
      // 2 次全失败 —— 若不下结论就直接 harmful,那是拿 2 个样本判死刑
      expect(v.verdict).toBe('insufficient_data')
      expect(v.successRate).toBe(0)   // 原始数据照给,只是不下结论
    })

    it('成功率 >= 80% → healthy', () => {
      for (let i = 0; i < 4; i++) tracker.record({ skillName: 'h', ts: i, durationMs: 10, success: true })
      tracker.record({ skillName: 'h', ts: 9, durationMs: 10, success: false })
      const v = tracker.getVerdict('h')
      expect(v.verdict).toBe('healthy')
      expect(v.successRate).toBeCloseTo(0.8)
    })

    it('成功率 50%~80% → degraded', () => {
      tracker.record({ skillName: 'd', ts: 1, durationMs: 10, success: true })
      tracker.record({ skillName: 'd', ts: 2, durationMs: 10, success: true })
      tracker.record({ skillName: 'd', ts: 3, durationMs: 10, success: false })
      tracker.record({ skillName: 'd', ts: 4, durationMs: 10, success: false })
      expect(tracker.getVerdict('d').verdict).toBe('degraded')
    })

    it('成功率 < 50% → harmful', () => {
      tracker.record({ skillName: 'bad', ts: 1, durationMs: 10, success: false })
      tracker.record({ skillName: 'bad', ts: 2, durationMs: 10, success: false })
      tracker.record({ skillName: 'bad', ts: 3, durationMs: 10, success: true })
      expect(tracker.getVerdict('bad').verdict).toBe('harmful')
    })

    it('harmful 判定与 recommendRollback 一致(两处口径不能分叉)', () => {
      tracker.record({ skillName: 'rb2', ts: 1, durationMs: 10, success: false })
      tracker.record({ skillName: 'rb2', ts: 2, durationMs: 10, success: false })
      tracker.record({ skillName: 'rb2', ts: 3, durationMs: 10, success: true })
      expect(tracker.getVerdict('rb2').verdict).toBe('harmful')
      expect(tracker.recommendRollback('rb2')).toBe(true)
    })

    it('unitType 被保留 —— 工具名不能被当成技能名', () => {
      tracker.record({ skillName: 'Read', ts: 1, durationMs: 10, success: true, unitType: 'tool' })
      tracker.record({ skillName: 'Read', ts: 2, durationMs: 10, success: true, unitType: 'tool' })
      tracker.record({ skillName: 'Read', ts: 3, durationMs: 10, success: true, unitType: 'tool' })
      expect(tracker.getVerdict('Read').unitType).toBe('tool')
    })

    it('listAllVerdicts 按严重度排序(harmful 在最前)', () => {
      tracker.record({ skillName: 'ok', ts: 1, durationMs: 10, success: true })
      tracker.record({ skillName: 'ok', ts: 2, durationMs: 10, success: true })
      tracker.record({ skillName: 'ok', ts: 3, durationMs: 10, success: true })
      tracker.record({ skillName: 'bad', ts: 1, durationMs: 10, success: false })
      tracker.record({ skillName: 'bad', ts: 2, durationMs: 10, success: false })
      tracker.record({ skillName: 'bad', ts: 3, durationMs: 10, success: false })
      const list = tracker.listAllVerdicts()
      expect(list[0].skillName).toBe('bad')
      expect(list[0].verdict).toBe('harmful')
    })
  })

  // ══════════ 【M4-B】落盘去抖 ══════════
  // M4-B 把 record() 接成了主链路(每次工具调用一条)——
  // 每次同步全量写会卡主进程。去抖后突发调用只写一次。
  describe('M4-B 落盘去抖', () => {
    it('连续 record 只落盘一次(去抖窗口内的突发调用合并)', () => {
      vi.useFakeTimers()
      // 注:fs 模块命名空间在 vitest 下是只读的,spyOn(fs,'writeFileSync') 会报
      // "Cannot redefine property" —— 故改为 spy 内部落盘方法,测的正是"写盘次数"
      const writeSpy = vi.spyOn(SkillEffectivenessTracker.prototype as any, 'writeToDisk')
      try {
        for (let i = 0; i < 10; i++) {
          tracker.record({ skillName: 'burst', ts: i, durationMs: 10, success: true })
        }
        // 去抖窗口内:还没落盘
        expect(writeSpy).not.toHaveBeenCalled()
        // 窗口到期:一次性落盘(不是 10 次)
        vi.advanceTimersByTime(500)
        expect(writeSpy).toHaveBeenCalledTimes(1)
      } finally {
        writeSpy.mockRestore()
        vi.useRealTimers()
      }
    })

    it('flush() 立即落盘,无需等去抖窗口', () => {
      tracker.record({ skillName: 'now', ts: 1, durationMs: 10, success: true })
      tracker.flush()
      const written = JSON.parse(fs.readFileSync((tracker as any).storePath, 'utf-8')) as any[]
      expect(written.some((r: any) => r.skillName === 'now')).toBe(true)
    })
  })
})
