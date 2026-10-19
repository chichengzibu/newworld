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
import { describe, it, expect, beforeEach } from 'vitest';
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
