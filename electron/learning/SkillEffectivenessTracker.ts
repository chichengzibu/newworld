import { LogManager } from '../core/LogManager'
import { getHost } from '../platform/runtime'
import { EventBus } from '../runtime/bridge/EventBus'
import * as fs from 'node:fs'
import * as path from 'node:path'


export interface SkillUsageStat {
  skillName: string
  calls: number
  successes: number
  failures: number
  avgDurationMs: number
  satisfactionScore?: number
  lastCalledAt: number
}

/**
 * 【M4-B】技能效果判定 —— 低基数结论标签。
 *
 * 【为什么要有"判定"而不只是原始计数】
 * 调用次数/成功次数是原料,但没人能直接读出"这技能好不好用"。
 * 判定把原料压成一个可展示、可排序、可筛选的结论。
 *
 * 【判定阈值从哪来 —— 业界调研】
 * - 「support counts / helpful-harmful counters 是最小可用信号」
 *   (ACE 与 ALTK-Evolve 两个独立工作都收敛到这一点)
 * - 「技能库需要按【效用】剪枝,不能按【时间】保留」
 *   (一万个平庸技能比十个高价值技能更糟)
 * - 但【绝对成功率 ≠ 边际效用】:FlowEvo 的对照实验表明,真正有害的判据是
 *   「带该技能 vs 不带该技能」的成功率【差值】为负(阈值 −0.1),
 *   而非绝对成功率低。绝对成功率低的技能可能只是任务本身难。
 *   → 因此本判定【只做展示与告警,不做自动回滚】。
 *     自动处置必须等有对照数据(带/不带该技能的匹配任务对比),那是 M4-C 的事。
 */
export type SkillVerdict =
  | 'untested'           // 从未被调用
  | 'insufficient_data'  // 调用太少,样本不足以下结论
  | 'healthy'            // 成功率 >= 80%
  | 'degraded'           // 50% <= 成功率 < 80%
  | 'harmful'            // 成功率 < 50%

export interface SkillVerdictInfo {
  skillName: string
  /** 被观测单元类型 —— 见 SkillCallRecord.unitType */
  unitType: 'tool' | 'skill'
  verdict: SkillVerdict
  calls: number
  successes: number
  failures: number
  /** 0~1,样本不足时为 undefined */
  successRate?: number
  avgDurationMs: number
  lastCalledAt: number
}

/**
 * 【M4-D】技能的边际效用 —— 同类别任务下,带它 vs 不带它的成功率差。
 *
 * 【口径】观察性对比,非受控实验(见 getMarginalUtility 的说明)。
 * delta 为 undefined = 样本不足,不给结论。
 */
export interface SkillUtility {
  skillName: string;
  /** 带该技能的运行 */
  withSkill: { runs: number; successes: number; rate?: number };
  /** 同类别任务下、未应用该技能的运行 */
  withoutSkill: { runs: number; successes: number; rate?: number };
  /** 带 − 不带;undefined = 样本不足 */
  delta?: number;
  /** 样本不足标记 */
  insufficientData: boolean;
  /** 口径标记:恒为 true —— 这是观察性对比,不是因果结论 */
  observational: true;
}

export interface SkillCallRecord {
  /**
   * 被观测单元的名字。
   *
   * 【M4-B 口径澄清 — 重要】
   * 本字段名叫 skillName(历史名),但【实际记录的是"可复用的工作单元"】,
   * 目前有两类:
   *   - 'tool' —— 一次工具调用(Read/Edit/run_command…)
   *   - 'skill' —— 一次技能应用
   * 两者都用 unitType 标注,避免"工具名被当成技能名"这种语义污染:
   * 一个叫 Read 的东西不是技能,把它记进技能库会污染技能的效用统计。
   */
  skillName: string
  /** 被观测单元的类型 —— 见上。缺省视为 'skill'(保持历史数据语义) */
  unitType?: 'tool' | 'skill'
  ts: number
  durationMs: number
  success: boolean
  conversationId?: string
  overridden?: boolean
  /**
   * 【M4-D】任务类别 —— 归一化后的用户指令。
   *
   * 【为什么需要】
   * 「这个技能有没有用」不能只看「带它时成功率多少」——
   * 用户可能专挑难活儿时才启用它。真正的判据是【同类别任务下】:
   *   带该技能的成功率  vs  不带该技能的成功率
   * 要做这个对比,就必须能把「带/不带」的运行归到同一类别里 —— 即本字段。
   */
  category?: string
}

/**
 * SkillEffectivenessTracker: 跟踪 skill 调用效果 + 用户满意度。
 * 持久化到 ~/.pipiclaw/skill-stats.json
 * 主要消费者:InsightManager(给 Insights 看板用) + SkillVersioning 自动推荐回滚
 */
export class SkillEffectivenessTracker {
  private static instance: SkillEffectivenessTracker
  private log = LogManager.getInstance()
  private bus = EventBus.getInstance()
  private records: SkillCallRecord[] = []
  private storePath: string
  private maxRecords = 1000
  /** 落盘去抖定时器 —— 见 persistToDisk 的说明 */
  private persistTimer: ReturnType<typeof setTimeout> | null = null
  /** 判定所需的最少样本量 —— 少于此不结论 */
  private static readonly MIN_SAMPLES = 3
  /**
   * 【M4-D】边际效用对比所需的最少样本量(每侧)。
   *
   * 3 次运行得出的成功率差值噪声太大 —— 一次翻转就是 ±33%。
   * 5 次是「差值还能被看见」的最低门槛。
   */
  private static readonly MIN_CONTRAST_SAMPLES = 5

  private constructor() {
    this.storePath = path.join(getHost().getPath('userData'), 'skill-stats.json')
    this.loadFromDisk()
  }

  public static getInstance(): SkillEffectivenessTracker {
    if (!SkillEffectivenessTracker.instance) SkillEffectivenessTracker.instance = new SkillEffectivenessTracker()
    return SkillEffectivenessTracker.instance
  }

  record(record: SkillCallRecord): void {
    this.records.push(record)
    if (this.records.length > this.maxRecords) this.records.shift()
    void this.bus.publish('skill:effectiveness:recorded', { skillName: record.skillName, success: record.success })
    this.persistToDisk()
  }

  getStats(skillName: string): SkillUsageStat | undefined {
    const records = this.records.filter(r => r.skillName === skillName)
    if (records.length === 0) return undefined
    const successes = records.filter(r => r.success).length
    const failures = records.length - successes
    const avg = records.reduce((s, r) => s + r.durationMs, 0) / records.length
    const lastCalledAt = Math.max(...records.map(r => r.ts))
    const overrideRate = records.filter(r => r.overridden).length / records.length
    return {
      skillName,
      calls: records.length,
      successes,
      failures,
      avgDurationMs: avg,
      satisfactionScore: 1 - overrideRate,
      lastCalledAt,
    }
  }

  listAllStats(): SkillUsageStat[] {
    const skillNames = Array.from(new Set(this.records.map(r => r.skillName)))
    return skillNames.map(n => this.getStats(n)!).filter(Boolean)
  }

  recommendRollback(skillName: string): boolean {
    const stats = this.getStats(skillName)
    if (!stats) return false
    return stats.calls >= 3 && stats.successes / stats.calls < 0.5
  }

  /**
   * 【M4-B】判定一个技能的效果 —— 低基数结论 + 支撑证据。
   *
   * 【口径声明 — 重要】
   * 这是【绝对成功率】判定,不是【边际效用】判定。
   * 业界实测:真正有害的判据是"带该技能 vs 不带该技能"的**差值**为负,
   * 而非绝对成功率低 —— 绝对成功率低的技能可能只是任务本身难。
   * 因此本方法【只产出信号供展示与告警,不自动回滚技能】。
   * 自动处置需要对照数据(带/不带该技能的匹配任务对比),那属于验证闸门环节。
   */
  public getVerdict(skillName: string): SkillVerdictInfo {
    const stats = this.getStats(skillName)
    if (!stats) {
      return {
        skillName,
        unitType: 'skill',
        verdict: 'untested',
        calls: 0,
        successes: 0,
        failures: 0,
        avgDurationMs: 0,
        lastCalledAt: 0,
      }
    }
    const rate = stats.calls > 0 ? stats.successes / stats.calls : undefined
    let verdict: SkillVerdict
    if (stats.calls < SkillEffectivenessTracker.MIN_SAMPLES) {
      verdict = 'insufficient_data'
    } else if (rate! >= 0.8) {
      verdict = 'healthy'
    } else if (rate! >= 0.5) {
      verdict = 'degraded'
    } else {
      verdict = 'harmful'
    }
    // 单元类型取该名字下最近一条记录(同名的记录类型应一致)
    const last = [...this.records].reverse().find((r) => r.skillName === skillName)
    return {
      skillName,
      unitType: last?.unitType ?? 'skill',
      verdict,
      calls: stats.calls,
      successes: stats.successes,
      failures: stats.failures,
      successRate: rate,
      avgDurationMs: stats.avgDurationMs,
      lastCalledAt: stats.lastCalledAt,
    }
  }

  /** 全部技能的判定列表(按判定严重度排序:harmful → degraded → …) */
  public listAllVerdicts(): SkillVerdictInfo[] {
    const order: Record<SkillVerdict, number> = {
      harmful: 0,
      degraded: 1,
      insufficient_data: 2,
      healthy: 3,
      untested: 4,
    }
    return this.listAllStats()
      .map((s) => this.getVerdict(s.skillName))
      .sort((a, b) => order[a.verdict] - order[b.verdict])
  }

  /**
   * 【M4-D】某个技能的真实使用统计 —— 供技能卡展示。
   *
   * 【为什么不用 SkillLoader 的 usageCount/successRate】
   * 那两个字段写它们的 `recordSkillUsage()` **全仓零调用方** ——
   * 技能卡上显示的「0 次使用 / 100% 成功率」是编造的,不是"还没数据"。
   * 现从真实的应用记录统计,无数据时返回 undefined(UI 显示 "—"),
   * 不用假的 100% 冒充。
   */
  public getSkillUsage(skillName: string): { runs: number; successes: number; successRate?: number } | undefined {
    const records = this.records.filter(r => r.skillName === skillName && r.unitType === 'skill');
    if (records.length === 0) return undefined;
    const successes = records.filter(r => r.success).length;
    return { runs: records.length, successes, successRate: successes / records.length };
  }

  /**
   * 【M4-D】技能的【边际效用】—— 同类别任务下,带它 vs 不带它的成功率差。
   *
   * 【为什么绝对成功率不够】
   * 「带该技能的成功率 40%」说明不了它有没有用 —— 用户可能专挑难活儿时启用它。
   * 业界对照实验的判据是【差值】:同任务类别下,
   *   带技能的成功率 − 不带技能的成功率
   * 差值为负 → 该技能在这类任务上是负贡献。
   *
   * 【口径声明 — 这是观察性对比,不是受控实验】
   * 「不带该技能」的运行是自然发生的,不是随机分配的 —— 存在混杂:
   * 用户可能在任务变难时才想起用技能,那样带技能的组天然更难,
   * 差值会【低估】技能的贡献;反之也可能高估。
   * 所以本方法只产出【信号】,不作因果结论,更不做自动处置。
   * 真要因果结论,需要同一批任务上随机带/不带各跑一遍(对照 rollout)。
   *
   * 【样本量】
   * 任一侧样本不足 MIN_CONTRAST_SAMPLES → 判为数据不足,不给差值。
   */
  public getMarginalUtility(skillName: string): SkillUtility {
    const skillRecords = this.records.filter(r => r.skillName === skillName && r.unitType === 'skill')
    const withRuns = skillRecords.length

    // 「不带该技能」= 同类别任务下、且没有应用该技能的运行
    // 没有类别信息的老记录无法归类 → 只能排除(宁可样本少,不混口径)
    const categories = new Set(skillRecords.map(r => r.category).filter((c): c is string => !!c))
    const withoutRecords = this.records.filter(
      r => r.unitType === 'skill'
        && r.skillName !== skillName
        && !!r.category
        && categories.has(r.category),
    )
    const withoutRuns = withoutRecords.length

    const withSuccess = skillRecords.filter(r => r.success).length
    const withoutSuccess = withoutRecords.filter(r => r.success).length

    const withRate = withRuns > 0 ? withSuccess / withRuns : undefined
    const withoutRate = withoutRuns > 0 ? withoutSuccess / withoutRuns : undefined
    const enough = withRuns >= SkillEffectivenessTracker.MIN_CONTRAST_SAMPLES
      && withoutRuns >= SkillEffectivenessTracker.MIN_CONTRAST_SAMPLES

    return {
      skillName,
      withSkill: { runs: withRuns, successes: withSuccess, rate: withRate },
      withoutSkill: { runs: withoutRuns, successes: withoutSuccess, rate: withoutRate },
      // 样本不足 → delta 留空(不猜)
      delta: enough && withRate !== undefined && withoutRate !== undefined ? withRate - withoutRate : undefined,
      insufficientData: !enough,
      /** 口径标记 —— 提醒消费方这是观察性对比 */
      observational: true,
    }
  }

  /** 全部技能的边际效用(按差值升序 —— 最负的排最前) */
  public listAllUtilities(): SkillUtility[] {
    const names = new Set(
      this.records.filter(r => r.unitType === 'skill').map(r => r.skillName),
    )
    return [...names]
      .map(n => this.getMarginalUtility(n))
      .sort((a, b) => (a.delta ?? 0) - (b.delta ?? 0))
  }

  private loadFromDisk(): void {
    try {
      if (fs.existsSync(this.storePath)) {
        this.records = JSON.parse(fs.readFileSync(this.storePath, 'utf-8'))
      }
    } catch (e) {
      this.log.warn('SkillEffectivenessTracker: load failed', e)
    }
  }

  /**
   * 落盘 —— 【M4-B 改为去抖】
   *
   * 原实现每次 record 都同步写全量 JSON。此前 record() 全仓零调用方,
   * 所以无所谓;M4-B 把它接成了主链路(每个工具调用一条),
   * 一次 10 步的任务就是 10 次同步全量写 —— 主进程被同步 IO 卡住。
   *
   * 现改为:去抖 500ms 落一次盘。
   *   - 突发的一串调用只写一次盘
   *   - unref:定时器不阻止进程退出
   *   - flush():进程退出前/测试里需要立即落盘时显式调用
   */
  private persistToDisk(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer)
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      this.writeToDisk()
    }, 500)
    // 不阻止进程退出
    if (typeof this.persistTimer.unref === 'function') this.persistTimer.unref()
  }

  /** 立即落盘(去抖窗口未到时的强制写入) */
  public flush(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    this.writeToDisk()
  }

  private writeToDisk(): void {
    try {
      fs.writeFileSync(this.storePath, JSON.stringify(this.records))
    } catch (e) {
      this.log.warn('SkillEffectivenessTracker: persist failed', e)
    }
  }
}