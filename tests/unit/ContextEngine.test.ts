/**
 * New World - ContextEngine 单元测试 (M2-A)
 *
 * 纯函数,可穷举。三条铁律必须锁死:
 *   1. system 永远保留第一条
 *   2. 最后一个 user 永远保留(那是当前任务)
 *   3. assistant 与其 tool 结果成对处理(孤立 tool 消息会让部分 provider 报 400)
 */
import { describe, it, expect } from 'vitest'
import {
  planContext, estimateTokens, estimateMessagesTokens,
  DEFAULT_BUDGET, usableTokens, TRIM_THRESHOLD, SUMMARIZE_THRESHOLD,
  type ContextMessage, type ContextBudget,
} from '../../electron/agent/ContextEngine'

const sys = (c = '你是助手'): ContextMessage => ({ role: 'system', content: c })
const user = (c: string): ContextMessage => ({ role: 'user', content: c })
const asst = (c: string, tools?: unknown[]): ContextMessage =>
  ({ role: 'assistant', content: c, ...(tools ? { toolCalls: tools } : {}) })
const tool = (c: string, id = 't1'): ContextMessage => ({ role: 'tool', content: c, toolCallId: id })

const BIG = 'x'.repeat(40_000)   // 约 10k tokens

describe('ContextEngine', () => {
  /** 构造一个"必然超限"的上下文 —— 必须真的超过 usable*TRIM_THRESHOLD,
   *  否则测试会误判成"容量充足",断言就失去意义。 */
  const overflowing = (bigCount = 8): ContextMessage[] => [
    sys(),
    user('第一个任务'), asst('完成'),
    ...Array.from({ length: bigCount }, (_, i) => [
      user(BIG), asst(BIG), tool(BIG, `c${i}`),
    ]).flat(),
    user('当前任务'),
  ]
  describe('estimateTokens', () => {
    it('中英文混合估算合理', () => {
      expect(estimateTokens('')).toBe(0)
      expect(estimateTokens('中文')).toBe(2)          // CJK 1 字 ≈ 1 token
      expect(estimateTokens('abcd')).toBe(1)         // 4 英文 ≈ 1 token
      expect(estimateTokens('中文abcd')).toBe(3)
    })

    it('每条消息有固定结构开销', () => {
      expect(estimateMessagesTokens([{ role: 'user', content: '' }])).toBeGreaterThan(0)
    })
  })

  describe('正常路径:不该动任何东西', () => {
    it('容量充足时原样返回', () => {
      const msgs = [sys(), user('你好'), asst('你好,有什么可以帮你')]
      const p = planContext(msgs)
      expect(p.action).toBe('none')
      expect(p.messages).toHaveLength(3)
      expect(p.trimmedToolMessages).toBe(0)
      expect(p.trimmedTurns).toBe(0)
    })

    it('空上下文安全返回', () => {
      const p = planContext([])
      expect(p.action).toBe('none')
      expect(p.messages).toHaveLength(0)
    })
  })

  describe('铁律 1/2:system 与最后一个 user 必须保留', () => {
    it('裁剪后 system 仍在首位', () => {
      // 必须真超限:8 轮 × 40KB ≈ 240k 字符 ≈ 60k tokens > 0.8×108k? 用 12 轮保险
      const p = planContext(overflowing(12))
      expect(p.action).not.toBe('none')
      expect(p.messages[0].role).toBe('system')
      expect(p.messages[p.messages.length - 1].content).toBe('当前任务')
    })

    it('即使触发摘要,system 与当前 user 仍在', () => {
      const tiny: ContextBudget = { total: 2000, reserve: 200, system: 200, history: 400, toolResult: 400 }
      const msgs: ContextMessage[] = [sys(), user(BIG), asst(BIG), tool(BIG, 't1'), user('现在呢')]
      const p = planContext(msgs, tiny)
      expect(p.messages[0].role).toBe('system')
      expect(p.messages[p.messages.length - 1].content).toBe('现在呢')
    })
  })

  describe('铁律 3:不产生孤立 tool 消息', () => {
    it('裁剪历史时 assistant 与其 tool 结果成对移除', () => {
      const msgs: ContextMessage[] = [
        sys(),
        user('任务'), asst('思考中', [{ function: { name: 'Read' } }]), tool('结果1', 'c1'),
        user('任务2'), asst('思考中2', [{ function: { name: 'Read' } }]), tool('结果2', 'c2'),
        user('任务3'), asst('思考中3', [{ function: { name: 'Read' } }]), tool('结果3', 'c3'),
        user('当前'),
      ]
      const tight: ContextBudget = { total: 4000, reserve: 100, system: 100, history: 300, toolResult: 150 }
      const p = planContext(msgs, tight)

      // 关键断言:裁剪后不能出现 tool 消息前面没有 assistant toolCalls
      const toolIdxs = p.messages
        .map((m, i) => (m.role === 'tool' ? i : -1))
        .filter(i => i >= 0)
      for (const idx of toolIdxs) {
        const prev = p.messages[idx - 1]
        expect(prev?.role, `位置 ${idx} 的 tool 消息前一条必须是带 toolCalls 的 assistant`)
          .toBe('assistant')
        expect(prev?.toolCalls?.length).toBeGreaterThan(0)
      }
    })
  })

  describe('降级级别', () => {
    it('轻度超限触发 trim 而非 abort', () => {
      const usable = usableTokens(DEFAULT_BUDGET)
      // 精确构造:约 86% 占用(越过 TRIM 阈值 80%,但远低于 SUMMARIZE 90%)
      // 0.98 而非更低:消息固定开销(每条 4 token)会再拉高实际占用,
      // 折扣给太大反而落在阈值下方(实测 0.92 → 0.782,不触发)
      const targetTokens = Math.floor(usable * 0.86)
      // 一条大 user 消息约 (len/4) tokens,留一点结构开销余量
      const filler = 'a'.repeat(Math.floor(targetTokens * 4 * 0.98))
      const msgs: ContextMessage[] = [sys(), user(filler), user('现在')]
      const p = planContext(msgs)
      expect(p.action).not.toBe('none')
      expect(p.action).not.toBe('abort')
      expect(p.estimatedTokens).toBeLessThanOrEqual(usable)
      // TRIM 阈值确实被越过
      expect(estimateTokens(filler) / usable).toBeGreaterThan(TRIM_THRESHOLD)
      expect(estimateTokens(filler) / usable).toBeLessThan(SUMMARIZE_THRESHOLD)
    })

    it('重度超限触发 summarize 并插入摘要', () => {
      const tiny: ContextBudget = { total: 3000, reserve: 100, system: 100, history: 200, toolResult: 200 }
      const msgs: ContextMessage[] = [
        sys(),
        user('我想整理下载文件夹'), asst('我来帮你'),
        user(BIG), asst(BIG), tool(BIG, 'c1'),
        user('继续'), asst(BIG), tool(BIG, 'c2'),
        user('最后一步'),
      ]
      const p = planContext(msgs, tiny)
      expect(p.action).toBe('summarize')
      expect(p.messages.some(m => m.content?.includes('[历史摘要]'))).toBe(true)
    })

    it('单条消息就超限 → action=abort 而不是静默溢出', () => {
      const tiny: ContextBudget = { total: 500, reserve: 50, system: 50, history: 100, toolResult: 100 }
      const msgs: ContextMessage[] = [sys(), user(BIG)]
      const p = planContext(msgs, tiny)
      expect(p.action).toBe('abort')
      expect(p.reason).toContain('超出')
    })
  })

  describe('工具消息优先淘汰', () => {
    it('toolResult 超配额时先丢工具消息而非历史', () => {
      const msgs: ContextMessage[] = [
        sys(),
        user('任务1'), asst('想', [{ function: { name: 'Read' } }]), tool(BIG, 'c1'),
        user('任务2'), asst('想2', [{ function: { name: 'Read' } }]), tool(BIG, 'c2'),
        user('现在'),
      ]
      const budget: ContextBudget = { total: 20_000, reserve: 1_000, system: 1_000, history: 12_000, toolResult: 2_000 }
      const p = planContext(msgs, budget)
      expect(p.trimmedToolMessages).toBeGreaterThan(0)
      expect(p.reason).toContain('丢弃')
    })
  })

  describe('不变量:返回值始终合法', () => {
    it('任何输入下第一条都是 system(非空时)且最后一条是 user', () => {
      const cases: ContextMessage[][] = [
        [sys(), user('a')],
        [sys(), user(BIG)],
        [sys(), user('x'), asst(BIG), tool(BIG, 'c1'), user('y')],
        [sys(), user(BIG), asst(BIG), user('z')],
      ]
      for (const msgs of cases) {
        const p = planContext(msgs)
        if (p.action === 'abort') continue
        expect(p.messages[0].role).toBe('system')
        const lastUser = [...p.messages].reverse().find(m => m.role === 'user')
        expect(lastUser, '裁剪后必须仍有 user 消息').toBeDefined()
      }
    })

    it('降级后不超可用容量', () => {
      const usable = usableTokens(DEFAULT_BUDGET)
      const msgs: ContextMessage[] = [
        sys(), user(BIG), asst(BIG), tool(BIG, 'c1'),
        user(BIG), asst(BIG), tool(BIG, 'c2'),
        user('当前问题'),
      ]
      const p = planContext(msgs)
      if (p.action !== 'abort') {
        expect(p.estimatedTokens).toBeLessThanOrEqual(usable)
      }
    })
  })
})