/**
 * NOVA #002 · 生命体 Orb 状态机 (pinia store)
 *
 * 口径 (命令 #002 §2):
 *   - state: 'idle' | 'listening' | 'thinking' | 'speaking' | 'hidden'
 *   - 迁移优先级: listening > thinking > speaking > idle
 *     · 升级/平级 = 允许 (返回 true)
 *     · 非法降级 (向低优先级迁移) = 保持高优先级状态, 返回 false
 *   - 'hidden' = 显式隐藏意向, 视为"退出态": 任意状态 → hidden 允许;
 *     hidden → 任意状态 允许 (恢复生命感由新信号驱动)
 *   - statusText: i18n key (orb.status.<state>) — 文案在 zh-CN/en-US 维护
 *   - M4 预留: listening / speaking 由语音链路驱动, 本版 Chat 只走 thinking/idle
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

export type OrbState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'hidden';

/** 优先级序 (数值越大越高); hidden 不参与序, 走独立分支 */
const PRIORITY: Record<Exclude<OrbState, 'hidden'>, number> = {
  listening: 3,
  thinking: 2,
  speaking: 1,
  idle: 0,
};

export const ORB_PRIORITY = PRIORITY;

export const useOrbStore = defineStore('nova-orb', () => {
  const state = ref<OrbState>('idle');
  const lastReason = ref<string | null>(null);

  function setState(next: OrbState, reason?: string): boolean {
    const from = state.value;
    if (from === next) {
      if (reason !== undefined) lastReason.value = reason;
      return true; // 平级: 幂等
    }
    // hidden 独立分支: 任意 → hidden 允许; hidden → 任意允许
    if (from === 'hidden' || next === 'hidden') {
      state.value = next;
      lastReason.value = reason ?? null;
      return true;
    }
    if (PRIORITY[next] < PRIORITY[from]) {
      // 非法降级: 保持高优先级状态
      lastReason.value = reason ?? null;
      return false;
    }
    state.value = next;
    lastReason.value = reason ?? null;
    return true;
  }

  const statusText = computed<string>(() => `orb.status.${state.value}`);

  /**
   * M1 生命周期出口: 一次交互结束 → 归位 idle。
   * 与 setState 优先级语义区分: thinking/speaking/listening 是"进行中"态,
   * finish() 是"会话轮结束"信号 — 允许它们回 idle (非非法降级)。
   * idle/hidden 调 finish = 幂等空操作。
   */
  function finish(reason?: string): void {
    if (state.value === 'thinking' || state.value === 'speaking' || state.value === 'listening') {
      state.value = 'idle';
      lastReason.value = reason ?? null;
    }
  }

  return {
    state,
    lastReason,
    statusText,
    setState,
    finish,
  };
});
