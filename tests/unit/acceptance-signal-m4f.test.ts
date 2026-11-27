/**
 * New World — 用户接受度信号测试（M4-F）
 * ═══════════════════════════════════════════════════════════════
 * 【这一批在测什么】
 * M4-E 的成功信号是弱代理(「工具全成功 + 有最终答复」)—— 那是**过程**指标,
 * 不是「用户是否满意」。本批补上用户信号这一路。
 *
 * 【最关键的一条】
 * 「不是」「不对」这类词在**正常任务描述**里也常见:
 *   「把**不是**苹果的挑出来」「**不对**称的那些别动」
 * 若全文匹配 → 大量正常后续指令被误判成「不满意」→
 * **效用统计偏悲观**,比没有统计更糟。故只认**句首**标记。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: vi.fn((k: string) => `/tmp/newworld-m4f-${k}`) },
}))

vi.mock('electron-log', () => ({
  default: {
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
    transports: { file: { resolvePathFn: () => {}, maxSize: 0, format: '' }, console: { level: 'info' } },
  },
}))

import { classifyAcceptance, rejectionByRegenerate } from '../../src/utils/acceptanceSignal'
import { AcceptanceLog } from '../../electron/learning/AcceptanceLog'

describe('M4-F 接受度信号识别', () => {
  it('句首纠正词 → rejected', () => {
    expect(classifyAcceptance('不对,应该先看 README').verdict).toBe('rejected')
    expect(classifyAcceptance('错了,是另一个路径').verdict).toBe('rejected')
    expect(classifyAcceptance('重做一遍').verdict).toBe('rejected')
    expect(classifyAcceptance('wrong, use the other path').verdict).toBe('rejected')
  })

  it('句首认可词 → accepted', () => {
    expect(classifyAcceptance('好了,可以了').verdict).toBe('accepted')
    expect(classifyAcceptance('谢谢,搞定').verdict).toBe('accepted')
    expect(classifyAcceptance('done, thanks').verdict).toBe('accepted')
  })

  it('【关键】纠正词出现在句中 → 不判定(避免误伤正常任务描述)', () => {
    // 「不是苹果的挑出来」是正常任务,不是抱怨
    expect(classifyAcceptance('把不是苹果的东西挑出来').verdict).toBe('unknown')
    expect(classifyAcceptance('那些不对称的图形不要').verdict).toBe('unknown')
    // 「不是」在中间出现也不判
    expect(classifyAcceptance('这个文件不是我要的那个').verdict).toBe('unknown')
  })

  it('普通后续指令 → unknown(不猜)', () => {
    expect(classifyAcceptance('再帮我看看别的').verdict).toBe('unknown')
    expect(classifyAcceptance('').verdict).toBe('unknown')
    expect(classifyAcceptance('   ').verdict).toBe('unknown')
  })

  it('前导标点不影响判定', () => {
    expect(classifyAcceptance('，不对').verdict).toBe('rejected')
    expect(classifyAcceptance('! 好了').verdict).toBe('accepted')
  })

  it('点「重新生成」→ 明确的 rejected', () => {
    const r = rejectionByRegenerate()
    expect(r.verdict).toBe('rejected')
    expect(r.reason).toContain('重新生成')
  })
})

describe('M4-F 接受度日志', () => {
  beforeEach(() => {
    ;(AcceptanceLog as any).instance = undefined;
    (AcceptanceLog.getInstance() as any).records.clear();
  });

  it('登记运行 → 先是 unknown,收到信号后才落判定', () => {
    const log = AcceptanceLog.getInstance();
    log.registerRun({ conversationId: 'c1', messageId: 'm1', skills: ['pdf-skill'], ts: Date.now() });
    expect(log.get('m1')?.verdict).toBe('unknown');

    log.recordVerdict('c1', 'm1', 'rejected', '用户点了重新生成');
    expect(log.get('m1')?.verdict).toBe('rejected');
    expect(log.get('m1')?.reason).toContain('重新生成');
  });

  it('按技能聚合 → 只算有明确信号的(unknown 不进分母)', () => {
    const log = AcceptanceLog.getInstance();
    // 三次运行:一次接受、一次拒绝、一次无信号
    log.registerRun({ conversationId: 'c', messageId: 'a', skills: ['s1'], ts: 1 });
    log.registerRun({ conversationId: 'c', messageId: 'b', skills: ['s1'], ts: 2 });
    log.registerRun({ conversationId: 'c', messageId: 'd', skills: ['s1'], ts: 3 });
    log.recordVerdict('c', 'a', 'accepted');
    log.recordVerdict('c', 'b', 'rejected');

    const agg = log.skillAcceptance('s1');
    expect(agg.accepted).toBe(1);
    expect(agg.rejected).toBe(1);
    expect(agg.unknown).toBe(1);
    // 分母 = accepted + rejected = 2(不是 3)
    expect(agg.rate).toBe(0.5);
  });

  it('技能不匹配的运行不计入该技能的统计', () => {
    const log = AcceptanceLog.getInstance();
    log.registerRun({ conversationId: 'c', messageId: 'x', skills: ['other'], ts: 1 });
    log.recordVerdict('c', 'x', 'rejected');
    expect(log.skillAcceptance('s1').rejected).toBe(0);
    expect(log.skillAcceptance('other').rejected).toBe(1);
  });

  it('重复上报 → 后者覆盖(用户先纠正后又点重新生成,后者更强)', () => {
    const log = AcceptanceLog.getInstance();
    log.registerRun({ conversationId: 'c', messageId: 'm', skills: ['s'], ts: 1 });
    log.recordVerdict('c', 'm', 'accepted', '下一条消息含认可词');
    log.recordVerdict('c', 'm', 'rejected', '用户点击了重新生成');
    expect(log.get('m')?.verdict).toBe('rejected');
  });

  it('信号先到、运行登记后到 → 兜住不丢', () => {
    const log = AcceptanceLog.getInstance();
    log.recordVerdict('c', 'late', 'rejected', '信号先到');
    log.registerRun({ conversationId: 'c', messageId: 'late', skills: ['s'], ts: 1 });
    // 登记不应把已有判定冲掉
    expect(log.get('late')?.verdict).toBe('rejected');
  });
})
