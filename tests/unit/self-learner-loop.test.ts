/**
 * #007 自学习闭环 — L2/L3/L4/L6a/L9 用例 (按案计, 实跑为准)
 * ═══════════════════════════════════════════════════════════
 * 硬事实锚 (实读 file:line):
 *   - W1 窗口 = SelfLearner.ts:157 OBSERVATION_WINDOW (100, 订单既定 10→100)
 *   - W2 阈值 = SelfLearner.ts:83 ANALYSIS_THRESHOLD (10, 订单既定 3→10, public 类常量)
 *   - G1 联动 = SelfLearner.ts:208 slice(-ANALYSIS_THRESHOLD) (订单: 同参, 非硬编码)
 *   - G3 O1  = ChatManager.ts:515-523 shouldPrecipitate 块 observeExecution (本单新增, 紧邻 #006.5 W1)
 *   - 技能消费面 = SelfLearner.ts:712 saveSkillFromProposal (写 skill.md + reloadSkills)
 *                 → SkillLoader.ts:384 getAllSkillSummaries / :745 getSkillContext
 *                 → InstructionGenerator.ts:255-256 注入 systemPrompt "技能系统 - 优先使用" (订单 b④ 活路实证)
 *   - L1 窗口案 → tests/integration/hermes-self-learner.test.ts T2.1 (同笔已更 10→100)
 *   - L6b UI 诚实文案案 → tests/unit/skills-h1-ui.test.ts (本单新增)
 *   - L5 G4 cosine 案 → 撤销 (设计稿 G4 段; 现状 LLM 意图级判重 SelfLearner.ts:668-706)
 * ═══════════════════════════════════════════════════════════
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

// ── mock 重依赖 (SelfLearner 真模块, 只 stub LLM 调用面, 保留窗口/阈值/落盘真行为) ──
vi.mock('../../electron/models/ModelManager', () => ({
  ModelManager: { getInstance: () => ({ getEnabledProviders: () => [] }) },
}))

import { SelfLearner } from '../../electron/learning/SelfLearner'
import { SkillLoader } from '../../electron/skill/SkillLoader'
import { getHost } from '../../electron/platform/runtime'
import type { SkillProposal } from '../../electron/learning/SelfLearner'

const TEST_USER_DATA = getHost().getPath('userData')
const SKILLS_DIR = path.join(TEST_USER_DATA, 'skills')

function resetSingletons() {
  ;(SelfLearner as unknown as { instance: SelfLearner | null }).instance = null
  ;(SkillLoader as unknown as { instance: SkillLoader | null }).instance = null
  for (const d of [TEST_USER_DATA, SKILLS_DIR]) {
    if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true })
  }
}

// 可被 LLM 判重/分析命中的最小提案 (skill.md 格式须含 # name / ## 触发关键词 / ## 操作步骤 才能被 parseSkillMd 解析, 见 T2.3 配方)
function makeProposal(id: string, name: string): SkillProposal {
  return {
    id,
    name,
    description: `测试技能 ${id}`,
    triggerCondition: `当用户要求${name}时触发`,
    keywords: [name, '测试'],
    operationSteps: ['步骤一', '步骤二'],
    fullInstructions: `# ${name}\n\n## 描述\n测试技能\n\n## 触发条件\n当用户要求${name}时触发\n\n## 触发关键词\n- ${name}\n- 测试\n\n## 操作步骤\n1. 步骤一\n2. 步骤二\n`,
    createdAt: Date.now(),
  }
}

describe('#007 L2/L3: 阈值与窗口 (W1=100, W2=10, G1 同参联动)', () => {
  beforeEach(() => resetSingletons())

  it('L2: 观察 9 条不触发分析; 第 10 条触发 analyzeAndGenerateSkill (W2 阈值 3→10)', async () => {
    const learner = SelfLearner.getInstance()
    learner.resetStats()
    const analyzeSpy = vi
      .spyOn(SelfLearner.prototype as any, 'analyzeAndGenerateSkill')
      .mockImplementation(async () => undefined)

    for (let i = 0; i < 9; i++) {
      learner.observeExecution(`指令 A-${i}`, [{ type: 'x' }], { ok: true })
    }
    expect(learner.getStats().observationCount).toBe(9)
    expect(analyzeSpy).not.toHaveBeenCalled()

    learner.observeExecution('指令 A-final', [{ type: 'x' }], { ok: true })
    expect(learner.getStats().observationCount).toBe(10)
    expect(analyzeSpy).toHaveBeenCalledTimes(1)
    analyzeSpy.mockRestore()
  })

  it('L3: 分析输入 = 最近 10 条 (slice(-ANALYSIS_THRESHOLD) 联动, 非硬编码 3)', async () => {
    const learner = SelfLearner.getInstance() as any
    // 注入 15 条 (绕过 observe 去重), 直接驱动 analyzeAndGenerateSkill
    for (let i = 0; i < 15; i++) {
      learner.observations.push({
        id: `obs-${i}`, instruction: `观察指令编号 ${i}`, steps: [], timestamp: Date.now() + i,
      })
    }
    const promptSpy = vi
      .spyOn(SelfLearner.prototype as any, 'callModelForAnalysis')
      .mockResolvedValue(null) // 不真发 LLM — 只断言 prompt 输入面

    await learner.analyzeAndGenerateSkill()
    const prompt = promptSpy.mock.calls[0][0] as string
    // 最近 10 条 (编号 5-14) 在场
    expect(prompt).toContain('观察指令编号 5')
    expect(prompt).toContain('观察指令编号 14')
    // 最早 5 条 (编号 0-4) 不在场
    expect(prompt).not.toContain('观察指令编号 0 ')
    expect(prompt).not.toContain('观察指令编号 3 ')
    expect(prompt).not.toContain('观察指令编号 4 ')
    promptSpy.mockRestore()
  })

  it('L2b: 阈值常量 = 10 + 窗口常量 = 100 (订单既定, 常量非模块态)', () => {
    const learner = SelfLearner.getInstance() as any
    expect(learner.ANALYSIS_THRESHOLD).toBe(10)
    expect(learner.OBSERVATION_WINDOW).toBe(100)
  })
})

describe('#007 L6a: H1 提案超时 (主进程侧 isProposalExpired 守卫, v1 收到即弃)', () => {
  beforeEach(() => resetSingletons())

  it('L6a: createdAt 超 30 分钟 → isProposalExpired=true → clear → pending=null; 未超期 → false', () => {
    const learner = SelfLearner.getInstance() as any
    const stale = makeProposal('stale-001', '超期技能'); stale.createdAt = Date.now() - 31 * 60 * 1000
    const fresh = makeProposal('fresh-001', '新鲜技能'); fresh.createdAt = Date.now() - 5 * 60 * 1000

    learner.pendingProposal = fresh
    expect(learner.isProposalExpired(new Date()).expired).toBe(false)

    learner.pendingProposal = stale
    const verdict = learner.isProposalExpired(new Date())
    expect(verdict.expired).toBe(true)
    expect(verdict.reason).toContain('30')
    learner.clearPendingProposal()
    expect(learner.getPendingProposal()).toBeNull()
  })
})

describe('#007 L9: 技能消费面硬答 (订单 b④ — saveSkill → reload → 摘要/query 可见, 活路实证)', () => {
  beforeEach(() => resetSingletons())

  it('L9: saveSkillFromProposal → getAllSkills/getAllSkillSummaries 含新技能 (InstructionGenerator 注入面数据源实证)', () => {
    const learner = SelfLearner.getInstance()
    const before = SkillLoader.getInstance().getAllSkills().length
    const result = learner.saveSkillFromProposal(makeProposal('consume-001', '目录文件整理'))
    expect(result.success).toBe(true)

    const loader = SkillLoader.getInstance()
    const after = loader.getAllSkills()
    expect(after.length).toBeGreaterThan(before)
    expect(after.some((s: any) => s.name.includes('目录文件整理'))).toBe(true)

    // 消费面接面: InstructionGenerator.ts:255 getAllSkillSummaries() 注入 systemPrompt — 断言该数据源含新技能名
    const summaries = loader.getAllSkillSummaries()
    expect(summaries).toContain('目录文件整理')
    expect(summaries).toContain('当用户要求目录文件整理时触发')
  })
})
