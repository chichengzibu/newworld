/**
 * PiPiClaw — 轨迹签名聚类测试（M4-I）
 * ═══════════════════════════════════════════════════════════════
 * 【这一批在测什么】
 * 旧实现按**归一化指令**聚类 —— 指令字面几乎相同才算同一个模式。
 * 于是「整理一下桌面」×2 与「收拾下桌面」×2 分成两簇,
 * 各自够不到支持度门槛 → **永远不提提案**。
 *
 * 而「同一件事的不同说法」恰恰是最值得学的模式 —— 用户不会每次都一样措辞。
 *
 * 业界三个独立工作收敛到同一结论(轨迹的结构行为信号才是区分维度):
 * TraceGraph(arXiv:2605.31308)· Hierarchical Clustering of Agent Traces
 * · AgentTrails(arXiv:2607.18816)
 *
 * 【关键细节:IDF 加权】
 * 原始工具计数被**胶水工具**主导(Read/Bash 几乎每条轨迹都有),
 * 不加权 → 所有轨迹看着都一样 → 聚类塌成一个 blob。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: vi.fn((k: string) => `/tmp/pipiclaw-m4i-${k}`) },
}))
vi.mock('electron-log', () => ({
  default: {
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
    transports: { file: { resolvePathFn: () => {}, maxSize: 0, format: '' }, console: { level: 'info' } },
  },
}))

import {
  computeIdf, similarity, signatureOf, toolOf, clusterBySignature,
} from '../../electron/learning/TrajectorySignature'
import { SelfLearner } from '../../electron/learning/SelfLearner'

/** 造一条轨迹 */
const traj = (tools: string[], ts = 1) => ({
  ts,
  outcome: 'ok' as const,
  steps: tools.map(t => ({ name: t, ok: true })),
})

describe('M4-I 轨迹签名', () => {
  it('三种步骤形状都能取到工具名', () => {
    expect(toolOf({ name: 'Read' })).toBe('Read')
    expect(toolOf({ type: 'run_command' })).toBe('run_command')
    expect(toolOf({ action: 'write_file' })).toBe('write_file')
    expect(toolOf({})).toBeUndefined()
    expect(toolOf(undefined)).toBeUndefined()
  })

  it('签名去重但保序', () => {
    expect(signatureOf(traj(['Read', 'Edit', 'Read']))).toEqual(['Read', 'Edit'])
  })

  it('IDF:胶水工具权重**低于**罕见工具(相对降权)', () => {
    const trajectories = [
      traj(['Read', 'Write'], 1),
      traj(['Read', 'Edit'], 2),
      traj(['Read', 'Bash'], 3),
    ]
    const idf = computeIdf(trajectories)
    // Read 出现在全部 3 条 → 权重最低;Write 只出现 1 次 → 权重最高
    expect(idf.get('Read')!).toBeLessThan(idf.get('Write')!)
    expect(idf.get('Write')!).toBeGreaterThan(idf.get('Read')!)
  })

  it('相似度:只共享胶水工具的两条轨迹 → 远低于阈值(不会被误并)', () => {
    const trajectories = [
      traj(['Read', 'Write'], 1),
      traj(['Read', 'Edit'], 2),
      traj(['Read', 'Bash'], 3),
    ]
    const idf = computeIdf(trajectories)
    const w = (sig: string[]) => {
      const m = new Map<string, number>()
      for (const t of sig) m.set(t, idf.get(t) ?? 0)
      return m
    }
    // 只共享 Read → 相似度远低于 0.5 的阈值
    expect(similarity(w(['Read', 'Write']), w(['Read', 'Edit']))).toBeLessThan(0.5)
    // 共享稀有工具 → 相似度高
    expect(similarity(w(['Write']), w(['Write']))).toBe(1)
  })

  it('【小语料不退化】语料只有 2 条时,相同动作仍能聚成簇', () => {
    // 踩过的坑:裸 IDF 下,出现在所有轨迹里的工具权重为 0 →
    // 语料一少,**每个工具**都在所有轨迹里 → 全零 → 一条都聚不到。
    // 平滑 IDF 解决:权重恒 ≥ 1,任何规模都能算相似度。
    const corpus = [traj(['Read', 'Edit'], 1), traj(['Read', 'Edit'], 2)]
    const idf = computeIdf(corpus)
    const items = corpus.map((t, i) => ({ signature: signatureOf(t), i }))
    const clusters = clusterBySignature(items, idf, 0.5)
    expect(clusters).toHaveLength(1)
    expect(clusters[0].members.length).toBe(2)
  })

  it('【核心】不同措辞、相同动作 → 归到同一簇', () => {
    // 语料:每条轨迹都含胶水工具 Read;真正有区分度的是 load_skill / Edit
    const corpus = [
      traj(['Read', 'load_skill', 'Edit'], 1),
      traj(['Read', 'load_skill', 'Edit'], 2),
      traj(['Read', 'Bash', 'Glob'], 3),
      traj(['Read', 'Bash', 'Glob'], 4),
    ]
    const idf = computeIdf(corpus)
    const items = corpus.map((t, i) => ({ signature: signatureOf(t), i }))

    const clusters = clusterBySignature(items, idf, 0.5)
    expect(clusters).toHaveLength(2)
    // 两个簇各 2 条
    expect(clusters.map(c => c.members.length).sort()).toEqual([2, 2])
    // 相同动作的两条在同一个簇里
    const first = clusters.find(c => c.members.some(m => m.i === 0))!
    expect(first.members.map(m => m.i).sort()).toEqual([0, 1])
  })

  it('动作不同 → 分开成簇', () => {
    const corpus = [
      traj(['load_skill', 'Edit'], 1),
      traj(['Bash', 'Glob'], 2),
    ]
    const idf = computeIdf(corpus)
    const items = corpus.map((t, i) => ({ signature: signatureOf(t), i }))
    const clusters = clusterBySignature(items, idf, 0.5)
    expect(clusters).toHaveLength(2)
  })

  it('聚类是确定性的(同样输入两次结果相同)', () => {
    const corpus = [
      traj(['Read', 'load_skill'], 1),
      traj(['Read', 'load_skill'], 2),
      traj(['Read', 'Bash'], 3),
    ]
    const idf = computeIdf(corpus)
    const items = corpus.map((t, i) => ({ signature: signatureOf(t), i }))
    const a = clusterBySignature(items, idf, 0.5).map(c => c.members.map(m => m.i))
    const b = clusterBySignature(items, idf, 0.5).map(c => c.members.map(m => m.i))
    expect(a).toEqual(b)
  })

  it('空签名的项不参与聚类(没有结构信号就没法比)', () => {
    const idf = computeIdf([traj(['Read'], 1)])
    const clusters = clusterBySignature([{ signature: [] }], idf, 0.5)
    expect(clusters).toHaveLength(0)
  })
})

/**
 * 【端到端验收】学习闭环真的能认出「同一件事的不同说法」吗?
 *
 * 旧行为:「整理一下桌面」×1 +「收拾下桌面」×1 → 两个簇,各支持度 1
 *         → 低于门槛(MIN_SUPPORT=2)→ **永远不提提案**
 * 新行为:同一套工具序列 → 一个簇,支持度 2 → 够门槛 → 能提提案
 *
 * 这才是用户能感知的差异:用户不会每次都用一样的措辞。
 */
describe('M4-I 学习闭环:不同措辞同一动作', () => {
  beforeEach(() => {
    vi.resetModules()
    ;(SelfLearner as any).instance = null
  })

  it('「整理一下桌面」+「收拾下桌面」→ 合成一个支持度 2 的模式', () => {
    const learner = SelfLearner.getInstance() as any
    // 造两条观察:指令不同,但做的动作相同(都用了 load_skill + Edit)
    const mkObs = (instruction: string, ts: number) => ({
      id: `obs-${ts}`,
      instruction,
      steps: [{ name: 'load_skill', ok: true }, { name: 'Edit', ok: true }],
      timestamp: ts,
      occurrences: 1,
      outcome: 'ok',
      source: 'agent_loop',
      trajectories: [{
        ts,
        outcome: 'ok',
        steps: [{ name: 'Read', ok: true }, { name: 'load_skill', ok: true }, { name: 'Edit', ok: true }],
        toolsUsed: ['Read', 'load_skill', 'Edit'],
      }],
    })
    const observations = [mkObs('整理一下桌面', 1), mkObs('收拾下桌面', 2)]

    const candidate = learner.selectCandidatePattern(observations)

    expect(candidate).not.toBeNull()
    // 关键:合成一个模式,支持度 = 2(两条观察各 1 次)
    expect(candidate.evidence.supportCount).toBe(2)
    expect(candidate.observations).toHaveLength(2)
    // 代表指令取用户原话
    expect(['整理一下桌面', '收拾下桌面']).toContain(candidate.instruction)
  })

  it('动作不同 → 不被硬并(各自支持度 1 → 门槛拦下,不给提案)', () => {
    const learner = SelfLearner.getInstance() as any
    const mkObs = (instruction: string, ts: number, tools: string[]) => ({
      id: `obs-${ts}`,
      instruction,
      steps: tools.map(t => ({ name: t, ok: true })),
      timestamp: ts,
      occurrences: 1,
      outcome: 'ok',
      source: 'agent_loop',
      trajectories: [{
        ts, outcome: 'ok',
        steps: tools.map(t => ({ name: t, ok: true })),
        toolsUsed: tools,
      }],
    })
    const observations = [
      mkObs('整理桌面', 1, ['Read', 'load_skill', 'Edit']),
      mkObs('发送邮件', 2, ['Read', 'Bash']),
    ]

    // 两个模式各只有 1 次支持 → 低于门槛 → 【不给提案】。
    // 这正是「没硬并」的表现:如果被硬并成 1 个簇,支持度会变成 2 → 会给出提案。
    expect(learner.selectCandidatePattern(observations)).toBeNull()

    // 对照:同动作的两条 → 合成 1 簇 → 支持度 2 → 过门槛 → 有提案
    const same = [
      mkObs('整理桌面', 1, ['Read', 'load_skill', 'Edit']),
      mkObs('收拾桌面', 2, ['Read', 'load_skill', 'Edit']),
    ]
    const merged = learner.selectCandidatePattern(same)
    expect(merged).not.toBeNull()
    expect(merged!.evidence.supportCount).toBe(2)
  })

  it('老数据(没有轨迹)→ 退回按指令分组,不被丢掉', () => {
    const learner = SelfLearner.getInstance() as any
    const mkLegacy = (instruction: string, ts: number) => ({
      id: `legacy-${ts}`,
      instruction,
      steps: [],
      timestamp: ts,
      occurrences: 1,
      outcome: 'ok',
      source: 'agent_loop',
    })
    const candidate = learner.selectCandidatePattern([
      mkLegacy('同样的老指令', 1),
      mkLegacy('同样的老指令', 2),
    ])
    expect(candidate).not.toBeNull()
    // 老数据按指令分组 → 支持度 2(两条各 1 次)
    expect(candidate.evidence.supportCount).toBe(2)
  })
})
