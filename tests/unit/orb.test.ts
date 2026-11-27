/**
 * NOVA #002 · orb store 迁移矩阵与优先级测试
 *
 * 口径 (命令 #002 §2 + §5a):
 *   - 优先级: listening(3) > thinking(2) > speaking(1) > idle(0)
 *   - 升级/平级 → true; 降级 → 保持原状态 + false
 *   - hidden: 任意 → hidden 允许; hidden → 任意允许
 *   - finish(): thinking/speaking/listening → idle; idle/hidden 幂等
 *   - statusText: 返回 i18n key (orb.status.<state>)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useOrbStore, ORB_PRIORITY } from '../../src/stores/orb';

describe('NOVA #002 orb store 迁移矩阵', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('T1: 初始态 = idle, statusText = orb.status.idle', () => {
    const orb = useOrbStore();
    expect(orb.state).toBe('idle');
    expect(orb.statusText).toBe('orb.status.idle');
  });

  it('T2: idle → thinking 升级 → true, state=thinking', () => {
    const orb = useOrbStore();
    expect(orb.setState('thinking', 'test')).toBe(true);
    expect(orb.state).toBe('thinking');
    expect(orb.statusText).toBe('orb.status.thinking');
    expect(orb.lastReason).toBe('test');
  });

  it('T3: thinking → thinking 平级 → true (幂等)', () => {
    const orb = useOrbStore();
    orb.setState('thinking');
    expect(orb.setState('thinking', 'again')).toBe(true);
    expect(orb.state).toBe('thinking');
    expect(orb.lastReason).toBe('again');
  });

  it('T4: thinking → idle 降级 → false, state 保持 thinking', () => {
    const orb = useOrbStore();
    orb.setState('thinking');
    expect(orb.setState('idle', 'illegal down')).toBe(false);
    expect(orb.state).toBe('thinking');
    expect(orb.lastReason).toBe('illegal down');
  });

  it('T5: idle → speaking 升级 → true; speaking → listening 再升级 → true', () => {
    const orb = useOrbStore();
    expect(orb.setState('speaking')).toBe(true);
    expect(orb.state).toBe('speaking');
    expect(orb.setState('listening', 'voice in')).toBe(true);
    expect(orb.state).toBe('listening');
    expect(orb.statusText).toBe('orb.status.listening');
  });

  it('T6: listening → speaking 降级 → false, 保持 listening (最高优先级驻留)', () => {
    const orb = useOrbStore();
    orb.setState('listening');
    expect(orb.setState('speaking')).toBe(false);
    expect(orb.state).toBe('listening');
  });

  it('T7: 任意态 → hidden 允许 (显式隐藏意向)', () => {
    const orb = useOrbStore();
    orb.setState('listening');
    expect(orb.setState('hidden', 'ui hide')).toBe(true);
    expect(orb.state).toBe('hidden');
    expect(orb.statusText).toBe('orb.status.hidden');
  });

  it('T8: hidden → idle / thinking 恢复允许 (新信号驱动)', () => {
    const orb = useOrbStore();
    orb.setState('hidden');
    expect(orb.setState('idle', 'restore')).toBe(true);
    expect(orb.state).toBe('idle');

    const orb2 = useOrbStore();
    orb2.setState('hidden');
    expect(orb2.setState('thinking', 'new signal')).toBe(true);
    expect(orb2.state).toBe('thinking');
  });

  it('T9: finish() — thinking → idle (生命周期出口, 不走优先级判定)', () => {
    const orb = useOrbStore();
    orb.setState('thinking');
    orb.finish('reply settled');
    expect(orb.state).toBe('idle');
    expect(orb.lastReason).toBe('reply settled');
  });

  it('T10: finish() — listening/speaking → idle; idle/hidden 幂等无副作用', () => {
    const orb = useOrbStore();
    orb.setState('listening');
    orb.finish();
    expect(orb.state).toBe('idle');

    const orb2 = useOrbStore();
    orb2.setState('speaking');
    orb2.finish();
    expect(orb2.state).toBe('idle');

    const orb3 = useOrbStore();
    expect(orb3.state).toBe('idle');
    orb3.finish('noop');
    expect(orb3.state).toBe('idle');
    expect(orb3.lastReason).toBe(null); // idle 上 finish 不写 reason

    const orb4 = useOrbStore();
    orb4.setState('hidden');
    orb4.finish('noop');
    expect(orb4.state).toBe('hidden');
  });

  it('T11: 优先级常量表 = listening 3 > thinking 2 > speaking 1 > idle 0', () => {
    expect(ORB_PRIORITY.listening).toBe(3);
    expect(ORB_PRIORITY.thinking).toBe(2);
    expect(ORB_PRIORITY.speaking).toBe(1);
    expect(ORB_PRIORITY.idle).toBe(0);
  });

  it('T12: 降级后 lastReason 仍记录原因 (可审计, 状态不变)', () => {
    const orb = useOrbStore();
    orb.setState('thinking');
    orb.setState('speaking', 'denied');
    expect(orb.state).toBe('thinking');
    expect(orb.lastReason).toBe('denied');
  });
});

/**
 * NW · 语义化生命体征测试
 * 动效参数必须映射真实数据: 呼吸周期←状态, 激活←attention,
 * token 流←noteToken, 上下文←setContextUsage, finish 归零瞬态数据。
 */
describe('NW 语义化生命体征 (Motion = Telemetry)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('N1: 呼吸周期随状态变化 (静息 4.2s → 聆听 2.4s → 思考 1.5s → 生成 1.05s)', () => {
    const orb = useOrbStore();
    expect(orb.breathDuration).toBe(4200);
    // idle → thinking 升级: 呼吸加速到 1.5s
    orb.setState('thinking');
    expect(orb.breathDuration).toBe(1500);
    // listening(3) 优先级最高, 可覆盖 thinking: 2.4s
    orb.setState('listening');
    expect(orb.breathDuration).toBe(2400);
    // listening → thinking 是降级被拒, 仍保持 listening 的 2.4s (优先级语义不破)
    expect(orb.setState('thinking')).toBe(false);
    expect(orb.breathDuration).toBe(2400);
  });

  it('N2: idle → speaking 升级后呼吸 1050ms', () => {
    const orb = useOrbStore();
    expect(orb.setState('speaking', 'token stream')).toBe(true);
    expect(orb.breathDuration).toBe(1050);
  });

  it('N3: noteAttention 提升神经激活度并发脉冲', () => {
    const orb = useOrbStore();
    expect(orb.activity).toBe(0);
    expect(orb.pulseSeq).toBe(0);
    orb.noteAttention(0.3);
    expect(orb.activity).toBeCloseTo(0.3);
    expect(orb.pulseSeq).toBe(1);
    orb.noteAttention(0.5);
    expect(orb.activity).toBeCloseTo(0.8);
    expect(orb.pulseSeq).toBe(2);
  });

  it('N4: activity 上限钳制在 1.0', () => {
    const orb = useOrbStore();
    for (let i = 0; i < 20; i++) orb.noteAttention(0.2);
    expect(orb.activity).toBe(1);
  });

  it('N5: noteToken 累加 token 计数并推进脉冲序号', () => {
    const orb = useOrbStore();
    orb.noteToken(9); // ~3 tokens
    expect(orb.tokenCount).toBe(3);
    expect(orb.pulseSeq).toBe(1);
    orb.noteToken(1);
    expect(orb.tokenCount).toBe(4); // 至少 1
    expect(orb.pulseSeq).toBe(2);
  });

  it('N6: 上下文占用钳制在 0..1', () => {
    const orb = useOrbStore();
    orb.setContextUsage(0.55);
    expect(orb.contextUsage).toBeCloseTo(0.55);
    orb.setContextUsage(5);
    expect(orb.contextUsage).toBe(1);
    orb.setContextUsage(-1);
    expect(orb.contextUsage).toBe(0);
  });

  it('N7: decayActivity 回落到状态基线, 不跨状态误判', () => {
    const orb = useOrbStore();
    orb.setState('thinking');
    orb.noteAttention(0.2);
    for (let i = 0; i < 100; i++) orb.decayActivity(0.9);
    expect(orb.activity).toBeCloseTo(0.72); // thinking 基线
  });

  it('N8: finish() 归零瞬态体征 (activity/rate), 保留累计 token', () => {
    const orb = useOrbStore();
    orb.setState('speaking', 'stream');
    orb.noteToken(30);
    orb.noteAttention(0.5);
    expect(orb.tokenRate).toBeGreaterThan(0);
    orb.finish('done');
    expect(orb.state).toBe('idle');
    expect(orb.activity).toBe(0);
    expect(orb.tokenRate).toBe(0);
    expect(orb.tokenCount).toBeGreaterThan(0); // 会话累计保留
  });
});

/**
 * NW · 精确 usage 测试 (主进程 CostTracker 同源真实 token 计数)
 */
describe('NW 精确 usage (接主进程真实 token 计数)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('U1: 初始来源为 estimate', () => {
    const orb = useOrbStore();
    expect(orb.usageSource).toBe('estimate');
    expect(orb.exactPromptTokens).toBe(0);
    expect(orb.exactCompletionTokens).toBe(0);
  });

  it('U2: setExactUsage 用真实值覆盖估算计数, 标记来源 exact', () => {
    const orb = useOrbStore();
    orb.noteToken(300); // 估算 ~100 tokens
    expect(orb.usageSource).toBe('estimate');
    orb.setExactUsage({ promptTokens: 1200, completionTokens: 87, totalTokens: 1287, model: 'gpt-4o' });
    expect(orb.usageSource).toBe('exact');
    expect(orb.tokenCount).toBe(87); // 用 completionTokens 替换估算, 不累加
    expect(orb.exactPromptTokens).toBe(1200);
    expect(orb.exactCompletionTokens).toBe(87);
    expect(orb.usageModel).toBe('gpt-4o');
  });

  it('U3: 同轮内精确值到达后, 迟到的 delta 不再被估算累加污染', () => {
    const orb = useOrbStore();
    orb.noteToken(30); // 本轮首 token, 开轮 (估算 ~10)
    orb.setExactUsage({ promptTokens: 500, completionTokens: 40, totalTokens: 540 }); // 精确 40 覆盖
    orb.noteToken(999); // 同轮迟到的 delta: 精确值已到, 不应累加
    expect(orb.tokenCount).toBe(40);
    expect(orb.usageSource).toBe('exact');
  });

  it('U4: contextWindow 提供时用真实 promptTokens 更新上下文占用', () => {
    const orb = useOrbStore();
    orb.setExactUsage({ promptTokens: 64000, completionTokens: 100, totalTokens: 64100, contextWindow: 128000 });
    expect(orb.contextUsage).toBeCloseTo(0.5);
    orb.setExactUsage({ promptTokens: 115200, completionTokens: 100, totalTokens: 115300, contextWindow: 128000 });
    expect(orb.contextUsage).toBeCloseTo(0.9);
  });

  it('U5: 新一轮首个 token 重置来源回 estimate 且清零计数', () => {
    const orb = useOrbStore();
    orb.setExactUsage({ promptTokens: 500, completionTokens: 40, totalTokens: 540 });
    expect(orb.usageSource).toBe('exact');
    orb.noteToken(9); // 新一轮首 token
    expect(orb.usageSource).toBe('estimate');
    expect(orb.tokenCount).toBe(3); // 从 0 开始估算
  });

  it('U6: markGenerationStart + setExactUsage 用真实耗时算 tok/s', () => {
    const orb = useOrbStore();
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValue(1000);
    orb.markGenerationStart();
    nowSpy.mockReturnValue(4000); // 3 秒后 usage 到达
    orb.setExactUsage({ promptTokens: 10, completionTokens: 60, totalTokens: 70 });
    expect(orb.tokenRate).toBe(20); // 60 tokens / 3s = 20 tok/s
    nowSpy.mockRestore();
  });
});

/**
 * NW · 呼吸周期根级广播 (--nw-breath)
 * 环境呼吸层契约: orb store 是呼吸周期唯一数据源,
 * 广播为根级 CSS 变量供氛围层 (body::after) 与 orb 光晕 (.orb-core) 同频引用。
 */
describe('NW 呼吸周期根级广播 (--nw-breath)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    // 清掉上一用例残留的根级变量, 保证断言来自本次 watch 触发
    document.documentElement.style.removeProperty('--nw-breath');
  });

  it('B1: store 创建后广播 idle 呼吸周期 4200ms (immediate watch)', () => {
    useOrbStore();
    expect(document.documentElement.style.getPropertyValue('--nw-breath')).toBe('4200ms');
  });

  it('B2: 状态迁移同步广播 — thinking → 1500ms, listening → 2400ms', () => {
    const orb = useOrbStore();
    orb.setState('thinking');
    expect(document.documentElement.style.getPropertyValue('--nw-breath')).toBe('1500ms');
    orb.setState('listening');
    expect(document.documentElement.style.getPropertyValue('--nw-breath')).toBe('2400ms');
  });

  it('B3: finish() 回 idle → 广播回 4200ms', () => {
    const orb = useOrbStore();
    orb.setState('speaking');
    expect(document.documentElement.style.getPropertyValue('--nw-breath')).toBe('1050ms');
    orb.finish('settled');
    expect(document.documentElement.style.getPropertyValue('--nw-breath')).toBe('4200ms');
  });

  it('B4: hidden 态 breathDuration=0 不覆盖根级变量 (保留上一有效周期)', () => {
    const orb = useOrbStore();
    orb.setState('thinking');
    expect(document.documentElement.style.getPropertyValue('--nw-breath')).toBe('1500ms');
    orb.setState('hidden');
    expect(orb.breathDuration).toBe(0);
    // 周期为 0 时禁止写入 — 氛围层保持上一有效周期, 不会出现 0ms 异常动画
    expect(document.documentElement.style.getPropertyValue('--nw-breath')).toBe('1500ms');
  });
});
