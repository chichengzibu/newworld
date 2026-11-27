/**
 * New World — LLM 裁判层测试（M4-F）
 * ═══════════════════════════════════════════════════════════════
 * 【这一批在测什么】
 * 裁判层是**可选**的第四层。测三件事:
 *   ① 裁判**不参与** pass/fail(judge drift 真实存在,不能让它改结论)
 *   ② 裁判输出解析要**容错**(模型常带 ```json 包裹、也会说废话)
 *   ③ 裁判**按采样率**跑(默认 5% —— 全量跑会让评估成本翻几倍)
 *
 * 【本测试不调模型】裁判是注入的假实现。
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: vi.fn((k: string) => `/tmp/newworld-judge-${k}`) },
}))
vi.mock('electron-log', () => ({
  default: {
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
    transports: { file: { resolvePathFn: () => {}, maxSize: 0, format: '' }, console: { level: 'info' } },
  },
}))

import { gradeRun, gradeRunWithJudge, type GradableRun } from '../../electron/learning/TaskGrader'
import { parseJudgeOutput, createJudgeSampler, type RunJudge } from '../../electron/learning/RunJudge'
import { runSkillTrial, type TrialTask } from '../../electron/learning/SkillTrial'

const okRun = (over: Partial<GradableRun> = {}): GradableRun => ({
  instruction: '把桌面上的 PDF 归档到 D:/Documents/PDF',
  answer: '已完成，PDF 已归档到 D:/Documents/PDF',
  toolsUsed: ['Glob', 'Write'],
  hadToolFailure: false,
  hadError: false,
  producedAnswer: true,
  ...over,
})

describe('M4-F 裁判层', () => {
  it('裁判层**不参与** pass/fail(judge drift 不能改结论)', async () => {
    const base = gradeRun(okRun());
    expect(base.passed).toBe(true);

    // 裁判说「没达成」→ 但确定性层过了,结论仍应是「成功」
    const judge: RunJudge = async () => ({ passed: false, reason: '裁判觉得不行' });
    const withJudge = await gradeRunWithJudge(okRun(), {}, judge);
    expect(withJudge.passed).toBe(true);
    // 但裁判的结论要出现在明细里(不能被吞掉)
    const layer = withJudge.layers.find(l => l.name === 'llm_judge');
    expect(layer).toBeDefined();
    expect(layer!.detail).toContain('裁判觉得不行');
    expect(layer!.passed).toBeUndefined();   // 不作为判定依据
  });

  it('不传裁判 → 与纯确定性评分完全一致', async () => {
    const a = gradeRun(okRun());
    const b = await gradeRunWithJudge(okRun(), {}, undefined);
    expect(b.passed).toBe(a.passed);
    expect(b.layers.length).toBe(a.layers.length);
  });

  it('解析:标准 JSON', () => {
    const v = parseJudgeOutput('{"pass": true, "reason": "做完了", "score": 0.9}');
    expect(v?.passed).toBe(true);
    expect(v?.reason).toBe('做完了');
    expect(v?.score).toBe(0.9);
  });

  it('解析:带 ```json 包裹与前后废话', () => {
    const v = parseJudgeOutput('好的，我的判断是：\n```json\n{"pass": false, "reason": "没写到目标目录"}\n```\n以上。');
    expect(v?.passed).toBe(false);
    expect(v?.reason).toBe('没写到目标目录');
  });

  it('解析:pass 不是布尔 → 视为不可解析(不当成 false)', () => {
    // 关键:模型说 "pass": "yes" 时不能当成 false —— 那是把不确定当成否定
    expect(parseJudgeOutput('{"pass": "yes"}')).toBeNull();
    expect(parseJudgeOutput('完全不是 JSON')).toBeNull();
    expect(parseJudgeOutput('')).toBeNull();
  });

  it('解析:分数超界会被夹到 0~1', () => {
    expect(parseJudgeOutput('{"pass": true, "score": 5}')?.score).toBe(1);
    expect(parseJudgeOutput('{"pass": true, "score": -3}')?.score).toBe(0);
  })

  it('采样器:确定性(同样输入同样结果,便于回归对比)', () => {
    const s = createJudgeSampler(0.2);
    const first = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(s);
    const second = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(s);
    expect(first).toEqual(second);
    expect(first.filter(Boolean).length).toBeGreaterThan(0);
    expect(first.filter(Boolean).length).toBeLessThan(10);
  });

  it('采样器:0 → 永不跑;1 → 全跑', () => {
    expect(createJudgeSampler(0)(0)).toBe(false);
    expect(createJudgeSampler(1)(0)).toBe(true);
    expect(createJudgeSampler(1)(99)).toBe(true);
  });

  it('对照实验:裁判按采样率跑,不是每个任务都跑', async () => {
    let judgeCalls = 0;
    const judge: RunJudge = async () => { judgeCalls++; return { passed: true, reason: 'ok' }; };
    const tasks: TrialTask[] = Array.from({ length: 10 }, (_, i) => ({ id: `t${i}`, instruction: '任务' }));

    const r = await runSkillTrial(
      's', tasks,
      async () => okRun(),
      { judge, judgeSampleRate: 0.2 },
    );
    // 采样率 0.2 → 每 5 个跑一个 → 10 个任务里跑 2 个
    expect(judgeCalls).toBe(4);   // 每个被采样的任务跑两次(带/不带)
    expect(r.pairs.length).toBe(10);
    // 裁判样本量不足 → note 里要说明
    expect(r.summary.note).toContain('裁判');
  });

  it('对照实验:不传裁判 → 一次都不调', async () => {
    let judgeCalls = 0;
    const judge: RunJudge = async () => { judgeCalls++; return { passed: true, reason: 'ok' }; };
    const tasks: TrialTask[] = Array.from({ length: 5 }, (_, i) => ({ id: `t${i}`, instruction: '任务' }));
    await runSkillTrial('s', tasks, async () => okRun(), { judge, judgeSampleRate: 0 });
    expect(judgeCalls).toBe(0);
  });
});
