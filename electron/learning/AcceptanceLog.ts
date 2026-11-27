/**
 * New World — 用户接受度日志（M4-F）
 * ═══════════════════════════════════════════════════════════════
 * 【为什么需要】
 * M4-E 的评分器用的是**弱代理**成功信号:「工具调用全成功 + 有最终答复」。
 * 但那衡量的是「过程没出错」,不是「用户满意」。
 *
 * 业界对 agent 效果的主流做法是把**用户反馈**当最硬的信号
 * (trace-to-eval 的经典路径:用户点踩 → 进评测集 → 下次改动对着真实失败回归)。
 *
 * 【能采集什么信号 —— 以及不能采集什么】
 * 可采集(客观、明确):
 *   - **重新生成** → 用户明确不要上一个答复 → `rejected`（最强的负面信号）
 *   - **下一条消息里出现纠正词**(不对/错了/重做/not right…) → `rejected`
 *   - **下一条消息里出现认可词**(好了/可以/完成/done…) → `accepted`
 * 不可采集(不做推断):
 *   - 「用户没再说话」 ≠ 满意（可能只是走了）→ 记 `unknown`，**不猜**
 *
 * 【口径诚实】
 * `unknown` 占多数是正常的。宁可少判,不要把「没说话」当成「满意」——
 * 那会让效用统计偏乐观,比没有统计更危险。
 *
 * 【和对照实验的关系】
 * 受控对照(M4-E)里跑的是**无人值守**的变体,没有用户参与
 * → 接受度信号对它是**不适用**的,那一路只用确定性层。
 * 接受度信号服务的是**观察性**对比(M4-D 的边际效用):
 * 真实使用中,带该技能的运行被接受的比例 vs 不带的比例。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { getHost } from '../platform/runtime'
import { LogManager } from '../core/LogManager'

/** 一次运行的接受度判定 */
export type AcceptanceVerdict = 'accepted' | 'rejected' | 'unknown'

/** 运行登记(等用户给出信号后再补判定) */
export interface AcceptanceRun {
  conversationId: string;
  /** 助手消息 id —— 用户信号就是针对这条消息给的 */
  messageId: string;
  /** 该次运行应用过的技能 id(用于按技能聚合) */
  skills: string[];
  /** 任务类别(归一后的指令) */
  category?: string;
  ts: number;
}

/** 接受度记录 */
export interface AcceptanceRecord extends AcceptanceRun {
  verdict: AcceptanceVerdict;
  /** 判定依据(如「用户点了重新生成」/「下一条消息含纠正词」) */
  reason?: string;
}

/** 按技能的接受度汇总 */
export interface SkillAcceptance {
  skillId: string;
  accepted: number;
  rejected: number;
  unknown: number;
  /** 接受率(分母只算有明确信号的)—— unknown 不进分母 */
  rate?: number;
}

export class AcceptanceLog {
  private static instance: AcceptanceLog
  private log = LogManager.getInstance()
  /** messageId → 记录 */
  private records = new Map<string, AcceptanceRecord>()

  private constructor() {
    this.load();
  }

  public static getInstance(): AcceptanceLog {
    if (!AcceptanceLog.instance) AcceptanceLog.instance = new AcceptanceLog()
    return AcceptanceLog.instance
  }

  private storePath(): string {
    return path.join(getHost().getPath('userData'), 'hermes-learning', 'acceptance.json')
  }

  /**
   * 登记一次运行 —— 等用户给出信号后再补判定。
   *
   * 【为什么分两步】用户信号是**事后**才有的(用户看到答复才可能点重新生成)。
   * 运行登记必须先落,否则信号来了对不上号。
   */
  public registerRun(run: AcceptanceRun): void {
    // 【修】信号可能先到、运行登记后到(理论上不该,但兜住)——
    // 直接覆盖会把已收到的判定冲成 unknown,信号就丢了。
    const existing = this.records.get(run.messageId);
    this.records.set(run.messageId, existing
      ? { ...existing, ...run, verdict: existing.verdict }
      : { ...run, verdict: 'unknown' });
    this.persist()
  }

  /**
   * 记录用户信号。
   *
   * 幂等:同一 messageId 重复上报 → 覆盖（用户先纠正后又点重新生成，后者更强）。
   */
  public recordVerdict(
    conversationId: string,
    messageId: string,
    verdict: AcceptanceVerdict,
    reason?: string,
  ): void {
    const existing = this.records.get(messageId)
    if (existing) {
      existing.verdict = verdict
      existing.reason = reason ?? existing.reason
      this.persist()
      return
    }
    // 信号先到、运行登记后到(理论上不会,但兜住)
    this.records.set(messageId, {
      conversationId, messageId, skills: [], ts: Date.now(), verdict, reason,
    })
    this.persist()
  }

  /** 某条运行的接受度 */
  public get(messageId: string): AcceptanceRecord | undefined {
    return this.records.get(messageId)
  }

  /**
   * 按技能聚合接受度。
   *
   * 【分母口径】只算有**明确信号**的(accepted + rejected)。
   * unknown 不进分母 —— 把「没说话」算进分母会把接受率稀释,
   * 也会让「用户根本没用这个技能」看起来像「用户不满意」。
   */
  public skillAcceptance(skillId: string): SkillAcceptance {
    let accepted = 0, rejected = 0, unknown = 0;
    for (const r of this.records.values()) {
      if (!r.skills.includes(skillId)) continue;
      if (r.verdict === 'accepted') accepted++;
      else if (r.verdict === 'rejected') rejected++;
      else unknown++;
    }
    const decided = accepted + rejected;
    return {
      skillId,
      accepted,
      rejected,
      unknown,
      ...(decided > 0 ? { rate: accepted / decided } : {}),
    };
  }

  /** 全部记录(调试/导出用) */
  public list(): AcceptanceRecord[] {
    return [...this.records.values()];
  }

  /** 有界:只保留最近 N 条 —— 桌面应用磁盘敏感 */
  private trim(max = 500): void {
    if (this.records.size <= max) return;
    const sorted = [...this.records.values()].sort((a, b) => a.ts - b.ts);
    const drop = sorted.slice(0, sorted.length - max);
    for (const d of drop) this.records.delete(d.messageId);
  }

  private persist(): void {
    try {
      this.trim();
      const p = this.storePath();
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify([...this.records.values()]));
    } catch (e) {
      this.log.warn('AcceptanceLog: persist failed', e);
    }
  }

  private load(): void {
    try {
      const p = this.storePath();
      if (!fs.existsSync(p)) return;
      const data = JSON.parse(fs.readFileSync(p, 'utf-8')) as AcceptanceRecord[];
      for (const r of Array.isArray(data) ? data : []) {
        if (r?.messageId) this.records.set(r.messageId, r);
      }
    } catch (e) {
      this.log.warn('AcceptanceLog: load failed', e);
    }
  }
}
