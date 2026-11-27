/**
 * New World — M4-B 学习闭环测试
 * ═══════════════════════════════════════════════════════════════
 * 【本批要锁死的东西】
 *
 * M4-B 把「学习闭环」接上了真实执行事件。闭环四组件缺一环则不成立:
 *   ① 轨迹捕获 —— 执行过程被记录成结构化轨迹(不是聊天文本)
 *   ② 结果追踪 —— 成败被记录(此前 _result 参数被丢弃)
 *   ③ 诊断反馈 —— 失败被归类(可统计、可聚类)
 *   ④ 效果反馈 —— 每次工具调用的效果被记录(SkillEffectivenessTracker 此前零调用方)
 *
 * 【每条断言背后是一个真实缺陷】
 *   - "重复不丢弃"  → 此前重复指令直接 return,用户做 20 次只留 1 条样本,
 *                      而"重复"恰恰是最该学的信号
 *   - "失败不丢弃"  → 此前 if (result.success) 只记成功,失败样本全丢,
 *                      事故无法转成评测用例
 *   - "观察端不靠中文正则" → 此前 /(文件|整理|创建|...)/ 门控,steps 恒为 [],
 *                      与真实执行无关的样本污染分析池
 *   - "学习不得阻塞主流程" → 前一版裸调 observeExecution,一个 TypeError
 *                      就能让任务流抛错 → 回退普通对话 → 用户看到的是
 *                      "LLM 连不上",真实失败原因被吞掉(见 chat-execution-ui B-3)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

// ── mock 重依赖 (SelfLearner 真模块, 只 stub LLM 调用面) ──
vi.mock('../../electron/models/ModelManager', () => ({
  ModelManager: { getInstance: () => ({ getEnabledProviders: () => [] }) },
}))

import { SelfLearner } from '../../electron/learning/SelfLearner'
import { classifyFailure, type FailureType } from '../../electron/learning/FailureClassifier'
import { getHost } from '../../electron/platform/runtime'

const TEST_USER_DATA = getHost().getPath('userData')
/** SelfLearner 的落盘目录 = <userData>/hermes-learning (见 SelfLearner.ts:134) */
const LEARNING_DIR = path.join(TEST_USER_DATA, 'hermes-learning')

function resetLearner() {
  ;(SelfLearner as unknown as { instance: SelfLearner | null }).instance = null
  const obsFile = path.join(LEARNING_DIR, 'observations.json')
  if (fs.existsSync(obsFile)) fs.rmSync(obsFile, { force: true })
}

/** 读回落盘的观察(走真读盘路径,证明真的写下去了) */
function readObservations(): any[] {
  const p = path.join(LEARNING_DIR, 'observations.json')
  if (!fs.existsSync(p)) return []
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'))
  } catch {
    return []
  }
}

describe('M4-B ① 失败分类器 (electron/learning/FailureClassifier)', () => {
  it('权限类错误归 permission_denied', () => {
    expect(classifyFailure('EACCES: permission denied').type).toBe('permission_denied')
    expect(classifyFailure('forbidden').type).toBe('permission_denied')
    expect(classifyFailure('未授权访问').type).toBe('permission_denied')
  })

  it('超时类错误归 timeout', () => {
    expect(classifyFailure('request timed out').type).toBe('timeout')
    expect(classifyFailure('ETIMEDOUT').type).toBe('timeout')
    expect(classifyFailure('操作超时').type).toBe('timeout')
  })

  it('目标不存在归 not_found', () => {
    expect(classifyFailure('ENOENT: no such file or directory').type).toBe('not_found')
    expect(classifyFailure('文件不存在').type).toBe('not_found')
  })

  it('限流归 rate_limited(不吃掉正常词 —— 不能像旧版那样用 includes("rate"))', () => {
    expect(classifyFailure('rate limit exceeded').type).toBe('rate_limited')
    expect(classifyFailure('HTTP 429').type).toBe('rate_limited')
    // 反例护栏:"generate/moderate/accurate" 里的 rate 不是限流
    expect(classifyFailure('failed to generate response').type).not.toBe('rate_limited')
    expect(classifyFailure('moderate temperature').type).not.toBe('rate_limited')
  })

  it('输出解析失败归 parse_error', () => {
    expect(classifyFailure('Unexpected token in JSON').type).toBe('parse_error')
    expect(classifyFailure('解析失败').type).toBe('parse_error')
  })

  it('上下文超限归 context_overflow', () => {
    expect(classifyFailure('context length exceeded').type).toBe('context_overflow')
    expect(classifyFailure('maximum context window').type).toBe('context_overflow')
  })

  it('用户取消归 user_cancelled(不该算成失败事故)', () => {
    expect(classifyFailure('aborted by user').type).toBe('user_cancelled')
    expect(classifyFailure('用户取消').type).toBe('user_cancelled')
  })

  it('命令/工具执行失败归 tool_error', () => {
    expect(classifyFailure('command exited with code 1').type).toBe('tool_error')
    expect(classifyFailure('工具执行失败').type).toBe('tool_error')
  })

  it('无法识别的归 unknown(兜底,永不丢样本)', () => {
    expect(classifyFailure('¯\\_(ツ)_/¯').type).toBe('unknown')
    expect(classifyFailure(undefined).type).toBe('unknown')
    expect(classifyFailure('').type).toBe('unknown')
  })

  it('类目互斥且低基数:同一条错误只归一类', () => {
    // 顺序敏感:"permission denied" 同时含 permission 与 denied,
    // 若先匹配泛化的 tool_error 就会归错类
    const cases: Array<[string, FailureType]> = [
      ['EACCES: permission denied, command failed', 'permission_denied'],
      ['timeout while running tool', 'timeout'],
      ['ENOENT not found', 'not_found'],
    ]
    for (const [input, expected] of cases) {
      expect(classifyFailure(input).type).toBe(expected)
    }
  })

  it('自由文本只进 message,绝不进 type(否则统计退化成统计字符串)', () => {
    const r = classifyFailure('EACCES: permission denied, open /etc/shadow')
    expect(r.type).toBe('permission_denied')
    expect(r.message).toContain('/etc/shadow')
  })
})

describe('M4-B ② SelfLearner 轨迹型观察', () => {
  beforeEach(() => resetLearner())
  afterEach(() => resetLearner())

  it('重复指令 → 计数,不再丢弃(用户做 20 次 = 1 条样本被丢掉的老问题)', () => {
    const learner = SelfLearner.getInstance()
    learner.observeExecution('帮我整理桌面', [{ action: 'read' }], 'ok')
    learner.observeExecution('帮我整理桌面', [{ action: 'read' }], 'ok')
    learner.observeExecution('帮我整理桌面', [{ action: 'read' }], 'ok')

    const stats = learner.getStats()
    // 仍是 1 条观察(同一条指令),但 occurrences 记了 3
    expect(stats.observationCount).toBe(1)
    const obs = readObservations()
    expect(obs.length).toBe(1)
    expect(obs[0].occurrences).toBe(3)
  })

  it('outcome 被记录(此前 _result 参数被丢弃,成败完全丢失)', () => {
    const learner = SelfLearner.getInstance()
    learner.observeExecution('任务A', [{ action: 'x' }], 'ok')
    learner.observeExecution('任务B', [{ action: 'x' }], 'fail')

    const obs = readObservations()
    const a = obs.find((o: any) => o.instruction === '任务A')
    const b = obs.find((o: any) => o.instruction === '任务B')
    expect(a.outcome).toBe('ok')
    expect(b.outcome).toBe('fail')
  })

  it('result 各种形态都归一为 ok/fail/partial', () => {
    const learner = SelfLearner.getInstance()
    learner.observeExecution('形态-字符串ok', [], 'success')
    learner.observeExecution('形态-布尔false', [], false)
    learner.observeExecution('形态-对象success', [], { success: true })
    learner.observeExecution('形态-对象failure', [], { success: false })
    learner.observeExecution('形态-步骤全成功', [], { steps: [{ status: 'success' }] })
    learner.observeExecution('形态-步骤半失败', [], { steps: [{ status: 'success' }, { status: 'failed' }] })
    learner.observeExecution('形态-步骤全失败', [], { steps: [{ status: 'failed' }] })

    const obs = readObservations()
    const by = (n: string) => obs.find((o: any) => o.instruction === n)?.outcome
    expect(by('形态-字符串ok')).toBe('ok')
    expect(by('形态-布尔false')).toBe('fail')
    expect(by('形态-对象success')).toBe('ok')
    expect(by('形态-对象failure')).toBe('fail')
    expect(by('形态-步骤全成功')).toBe('ok')
    expect(by('形态-步骤半失败')).toBe('partial')
    expect(by('形态-步骤全失败')).toBe('fail')
  })

  it('失败样本也进池(事故要转成评测用例,不能让它消失)', () => {
    const learner = SelfLearner.getInstance()
    learner.observeExecution('会炸的任务', [{ action: 'x' }], 'fail', {
      source: 'task_executor',
      failure: { stepIndex: 0, type: 'permission_denied', message: 'EACCES' },
    })

    const obs = readObservations()
    expect(obs.length).toBe(1)
    expect(obs[0].outcome).toBe('fail')
    expect(obs[0].failure).toMatchObject({ stepIndex: 0, type: 'permission_denied' })
  })

  it('trajectoryId / toolsUsed / source 被记录(轨迹可归并、工具可统计)', () => {
    const learner = SelfLearner.getInstance()
    learner.observeExecution('多工具任务', [{ name: 'Read' }, { name: 'Edit' }], 'ok', {
      trajectoryId: 'run_123',
      toolsUsed: ['Read', 'Edit'],
      source: 'agent_loop',
    })

    const obs = readObservations()
    expect(obs[0].trajectoryId).toBe('run_123')
    expect(obs[0].source).toBe('agent_loop')
    expect(obs[0].toolsUsed).toEqual(['Read', 'Edit'])
  })

  it('重复时刷新结果与工具并集(最新一次执行说了算)', () => {
    const learner = SelfLearner.getInstance()
    learner.observeExecution('演进任务', [], 'fail', { toolsUsed: ['Read'] })
    learner.observeExecution('演进任务', [], 'ok', { toolsUsed: ['Edit'] })

    const obs = readObservations()
    expect(obs.length).toBe(1)
    expect(obs[0].occurrences).toBe(2)
    expect(obs[0].outcome).toBe('ok')          // 最新一次成功
    expect(obs[0].toolsUsed).toEqual(['Read', 'Edit'])  // 工具取并集
  })
})
