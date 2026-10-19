/**
 * NOVA #003-C · BootDirector 纯逻辑单测(第①笔)
 *
 * 口径(设计稿 F3/F5/F7 + 命令 #003-C 第①笔验收):
 *   - 阶段顺序 / progress 单调不减 / 2.8s 下限 / 跳过立即放行 / 10s 超时兜底 ≥6 例
 *   - 三"无信号"子系统经 stageFactories 注入触发 .getInstance()(验证被调用且幂等)
 *   - 乱序 → throw + 转入 aborted(显式暴露接线错误)
 *
 * 纯逻辑: 不 import electron 任何模块; 时间经 now() 注入冻结, 无真实 setTimeout/sleep。
 */
import { describe, it, expect } from 'vitest';
import {
  BootDirector,
  BOOT_STAGE_ORDER,
  type BootStage,
  type LogSink,
} from '../../electron/core/BootDirector';

/** 收集型 LogSink — 断言关键路径日志在场(不吞错, 只读) */
function makeLogSink() {
  const lines: { level: string; msg: string; extra?: unknown }[] = [];
  const sink: LogSink = {
    info: (msg, extra) => void lines.push({ level: 'info', msg, extra }),
    warn: (msg, extra) => void lines.push({ level: 'warn', msg, extra }),
    error: (msg, extra) => void lines.push({ level: 'error', msg, extra }),
  };
  return { sink, lines };
}

function bootAll(bd: BootDirector): void {
  for (const s of BOOT_STAGE_ORDER) bd.markStage(s);
}

describe('NOVA #003-C BootDirector 纯逻辑', () => {
  it('T1: 初始态 progress=0, stagesComplete=false, 事件流空', () => {
    const bd = new BootDirector();
    expect(bd.progress).toBe(0);
    expect(bd.stagesComplete).toBe(false);
    expect(bd.events).toHaveLength(0);
    expect(bd.rendererReady).toBe(false);
    expect(bd.skipped).toBe(false);
    expect(bd.aborted).toBe(false);
  });

  it('T2: 按序推进 7 阶段后 progress=1, stagesComplete=true, 事件流长度=7 且序正确', () => {
    const bd = new BootDirector();
    bootAll(bd);
    expect(bd.stagesComplete).toBe(true);
    expect(bd.progress).toBe(1);
    expect(bd.events).toHaveLength(7);
    expect(bd.events.map((e) => e.stage)).toEqual([...BOOT_STAGE_ORDER]);
    // 事件 progress 每步单调不减
    const ps = bd.events.map((e) => e.progress);
    for (let i = 1; i < ps.length; i++) expect(ps[i]).toBeGreaterThanOrEqual(ps[i - 1]);
  });

  it('T2b: progress 单调不减 — 重复 markStage 同阶段幂等, 不重复推事件, progress 不回退', () => {
    const bd = new BootDirector();
    bd.markStage('config');
    const after1 = bd.progress;
    bd.markStage('config', 'again'); // 幂等
    expect(bd.progress).toBeGreaterThanOrEqual(after1);
    expect(bd.events.filter((e) => e.stage === 'config')).toHaveLength(1);
  });

  it('T3: progress 数值 = 已完成/总数(7 级), 第 1 步 = 1/7', () => {
    const bd = new BootDirector();
    bd.markStage(BOOT_STAGE_ORDER[0]);
    expect(bd.progress).toBeCloseTo(1 / BOOT_STAGE_ORDER.length, 10);
  });

  it('T4: 乱序/跳序 → throw 且转入 aborted(显式暴露接线错误)', () => {
    const { sink, lines } = makeLogSink();
    const bd = new BootDirector({ log: sink });
    bd.markStage('config');
    // 跳过 ipc 直接 memory → 期望 ipc, 实收 memory
    expect(() => bd.markStage('memory')).toThrow(/阶段乱序/);
    expect(bd.aborted).toBe(true);
    // aborted 后 markStage 幂等空操作且不抛
    expect(() => bd.markStage('ipc')).not.toThrow();
    expect(lines.some((l) => l.level === 'error' && /aborted/.test(l.msg))).toBe(true);
  });

  it('T5: 2.8s 下限 — rendererReady 但 elapsed<minShow 时 canClose 仍 false; >=minShow 时点亮', () => {
    let t = 0;
    const bd = new BootDirector({ now: () => t, minShowMs: 2800 });
    bd.markSplashShown(); // t=0
    bd.markRendererReady();
    expect(bd.decide()).toEqual({ close: false, reason: 'pending' });

    t = 2799;
    expect(bd.canCloseSplash()).toBe(false);

    t = 2800;
    expect(bd.decide()).toEqual({ close: true, reason: 'light-up' });
  });

  it('T6: 跳过 — markSkipped 后无视下限/renderer-ready, reason=skip 立即放行', () => {
    let t = 0;
    const bd = new BootDirector({ now: () => t });
    bd.markSplashShown(); // t=0
    bd.markSkipped('user-interaction');
    const d = bd.decide();
    expect(d.close).toBe(true);
    expect(d.reason).toBe('skip');
    // 即便 renderer 未 ready、时钟未到下限, 仍放行
    expect(bd.rendererReady).toBe(false);
  });

  it('T7: 10s 超时兜底 — renderer 始终未 ready 且 elapsed>=timeout 时强切 reason=timeout', () => {
    let t = 0;
    const bd = new BootDirector({ now: () => t, rendererReadyTimeoutMs: 10_000 });
    bd.markSplashShown();
    t = 9999;
    expect(bd.canCloseSplash()).toBe(false);
    t = 10_000;
    expect(bd.decide()).toEqual({ close: true, reason: 'timeout' });
    // 兜底不是失败: aborted 保持 false
    expect(bd.aborted).toBe(false);
  });

  it('T8: 失败路径 — markAborted 优先级最高, 即便 skip/ready 也 reason=aborted', () => {
    let t = 0;
    const bd = new BootDirector({ now: () => t });
    bd.markSplashShown();
    bd.markRendererReady();
    bd.markSkipped('user-interaction');
    bd.markAborted('memory factory 抛错');
    expect(bd.decide().reason).toBe('aborted');
  });

  it('T9: 无信号子系统经 stageFactories 触发 .getInstance()(llm-config/memory/skills 各调 1 次)', () => {
    const calls: string[] = [];
    const bd = new BootDirector({
      stageFactories: {
        'llm-config': () => calls.push('llm-config'),
        'memory': () => calls.push('memory'),
        'skills': () => calls.push('skills'),
      },
    });
    bootAll(bd);
    // 每个 factory 恰被调用 1 次(按序, 不重复)
    expect(calls).toEqual(['llm-config', 'memory', 'skills']);
    // 工厂返回值不进入事件流(纯触发, 不污染载荷)
    for (const e of bd.events) expect(e).not.toHaveProperty('instance');
  });

  it('T10: 事件载荷 shape — 每事件含 stage/label/progress/detail?/timestamp, progress∈[0,1]', () => {
    let t = 1000;
    const bd = new BootDirector({ now: () => t++, labelFor: (s) => `LABEL_${s}` });
    bootAll(bd);
    for (const e of bd.events) {
      expect(e).toHaveProperty('stage');
      expect(e).toHaveProperty('label');
      expect(e.label).toBe(`LABEL_${e.stage}`);
      expect(e.progress).toBeGreaterThanOrEqual(0);
      expect(e.progress).toBeLessThanOrEqual(1);
      expect(typeof e.timestamp).toBe('number');
    }
    // detail 未提供时为 undefined(可选字段, 显式不造假默认)
    expect(bd.events[0].detail).toBeUndefined();
  });
});
