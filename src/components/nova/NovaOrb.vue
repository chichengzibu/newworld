<!--
  NovaOrb — NW 语义化生命体 (纯 SVG + CSS + 数据驱动, 零业务依赖)

  设计口径 (NW Living Systems):
    动效不是装饰, 是 AI 内部状态的可观测外显:
      · 呼吸周期 breathMs   ← 模型状态   (idle 4.2s → listening 2.4s → thinking 1.5s → speaking 1.05s)
      · 神经放电 activity   ← 思考强度   (沿轴突飞向突触, 越活跃点亮越多节点)
      · token 粒子 pulseSeq ← token 消耗 (每来一个 token, 喷射一枚粒子)
      · 上下文色 contextUsage ← 占用压力 (青 → 紫 → 橙告警)
    向后兼容: 只传 size/state 时, 呼吸/激活走 state 默认值, 无 token 粒子。

  可复用: 仅接收 props, 不 import store / ipc / 任何业务模块。
  无障碍: prefers-reduced-motion → 全部退化静态光晕。
-->
<template>
  <div
    :class="['nw-orb', 'state-' + state]"
    :style="orbStyle"
    role="img"
    :aria-label="ariaLabel"
  >
    <!-- 上下文压力环: 青→紫→橙, 填充度 = contextUsage。
         【设计审计】0% 占用时就是一个无意义的空圈(看起来像残留) → 无占用不渲染。 -->
    <div v-if="contextUsage > 0" class="orb-context-ring" aria-hidden="true"
      :style="{ '--ctx': contextColor, '--ctx-fill': Math.round(contextUsage * 360) + 'deg' }"></div>

    <!-- 呼吸光晕 (所有态共用, 周期由 breathMs 驱动) -->
    <div class="orb-core" aria-hidden="true"></div>

    <svg class="orb-svg" :width="size" :height="size" viewBox="0 0 100 100" aria-hidden="true">
      <defs>
        <linearGradient id="nwOrbGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" :stop-color="c1" />
          <stop offset="100%" :stop-color="c2" />
        </linearGradient>
        <radialGradient id="nwOrbCore" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stop-color="rgba(255,255,255,0.95)" />
          <stop offset="32%" :stop-color="c1" stop-opacity="0.9" />
          <stop offset="68%" :stop-color="c2" stop-opacity="0.5" />
          <stop offset="100%" stop-color="rgba(5,5,8,0)" />
        </radialGradient>
      </defs>

      <!-- 轴突 + 突触: 神经激活度决定点亮数量 (思考强度的映射) -->
      <g class="orb-neural" aria-hidden="true">
        <line v-for="(n, i) in synapses" :key="'ax' + i"
          class="axon" :class="{ lit: i < litSynapses }"
          x1="50" y1="50" :x2="n.x" :y2="n.y"
          :stroke="i < litSynapses ? c1 : '#9a7bff'" />
        <circle v-for="(n, i) in synapses" :key="'sy' + i"
          class="synapse" :class="{ lit: i < litSynapses }"
          :cx="n.x" :cy="n.y" r="1.8"
          :fill="i < litSynapses ? c1 : 'rgba(160,168,186,0.30)'" />
      </g>

      <!-- 核心圆 (呼吸) -->
      <circle class="orb-circle" cx="50" cy="50" r="17" fill="url(#nwOrbCore)" />

      <!-- 神经脉冲: 从核心飞向突触 (activity 驱动密度) -->
      <circle v-for="p in neuralPulses" :key="'np' + p.id" class="neural-pulse"
        :cx="p.x" :cy="p.y" r="1.9" fill="#ffffff" :style="{ '--dur': p.dur + 'ms' }" />

      <!-- token 粒子: 每来一枚 token 喷射一枚 (token 消耗的可视化) -->
      <rect v-for="p in tokenParticles" :key="'tp' + p.id" class="token-particle"
        :x="p.x" :y="p.y" width="2.6" height="2.6" rx="0.6"
        :style="{ '--dur': p.dur + 'ms' }" />

      <!-- listening: 三道青色雷达波纹 (描边走 nw-icon-stroke 标准) -->
      <g v-if="state === 'listening'" class="orb-rings radar">
        <circle class="radar-ring r1" cx="50" cy="50" r="25" fill="none" :stroke="c1" :stroke-width="1.5" />
        <circle class="radar-ring r2" cx="50" cy="50" r="25" fill="none" :stroke="c1" :stroke-width="1.5" />
        <circle class="radar-ring r3" cx="50" cy="50" r="25" fill="none" :stroke="c1" :stroke-width="1.5" />
      </g>

      <!-- speaking: 声波环 -->
      <g v-if="state === 'speaking'" class="orb-rings wave">
        <path class="wave-bar w1" d="M 35 42 Q 32 50 35 58" fill="none" stroke="url(#nwOrbGrad)" stroke-width="2.5" stroke-linecap="round" />
        <path class="wave-bar w2" d="M 65 40 Q 68 50 65 60" fill="none" stroke="url(#nwOrbGrad)" stroke-width="2.5" stroke-linecap="round" />
        <path class="wave-bar w3" d="M 50 36 Q 46 50 50 64" fill="none" stroke="url(#nwOrbGrad)" stroke-width="3" stroke-linecap="round" />
      </g>
    </svg>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from 'vue';

export type OrbVisualState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'hidden';

interface NovaOrbProps {
  /** 组件宽高(px), 默认 64 */
  size?: number;
  /** 当前状态 */
  state: OrbVisualState;
  /** 呼吸周期(ms) — 状态驱动; 不传则按 state 取默认值 */
  breathMs?: number;
  /** 神经激活度 0..1 — 思考强度; 不传则按 state 取默认值 */
  activity?: number;
  /** token 速率 tok/s (仅用于 aria 文案) */
  tokenRate?: number;
  /** 上下文占用 0..1 — 青→紫→橙 */
  contextUsage?: number;
  /** 脉冲序号: 每次数据事件自增, 每次自增喷射一枚 token 粒子 */
  pulseSeq?: number;
}

const props = withDefaults(defineProps<NovaOrbProps>(), {
  size: 64,
  breathMs: undefined,
  activity: undefined,
  tokenRate: 0,
  contextUsage: 0,
  pulseSeq: 0,
});

/* ---------- 状态 → 默认视觉参数 (向后兼容) ---------- */
const DEFAULT_BREATH: Record<OrbVisualState, number> = {
  idle: 4200, listening: 2400, thinking: 1500, speaking: 1050, hidden: 0,
};
const DEFAULT_ACTIVITY: Record<OrbVisualState, number> = {
  idle: 0.06, listening: 0.22, thinking: 0.78, speaking: 0.92, hidden: 0,
};

const breath = computed(() => props.breathMs ?? DEFAULT_BREATH[props.state]);
const activation = computed(() => props.activity ?? DEFAULT_ACTIVITY[props.state]);

const orbStyle = computed(() => ({
  width: props.size + 'px',
  height: props.size + 'px',
  '--breath': breath.value + 'ms',
  '--orb-scale': String(1 + activation.value * 0.06),
}));

/* 状态配色（v4.9 中性化）: 静息/聆听中性银灰, 思考冷灰, 生成柔和琥珀。
   保留「状态可区分」的语义，但去掉高饱和霓虹撞色与蓝调。 */
const c1 = computed(() => props.state === 'speaking' ? '#bfa07a' : props.state === 'thinking' ? '#9a9fab' : '#a8aebb');
const c2 = computed(() => props.state === 'thinking' ? '#7d8290' : props.state === 'speaking' ? '#a89480' : '#8b9199');

const contextColor = computed(() =>
  props.contextUsage > 0.8 ? '#bfa07a' : props.contextUsage > 0.5 ? '#9a9fab' : '#a8aebb');

const ariaLabel = computed(() => {
  const desc: Record<OrbVisualState, string> = {
    idle: 'NW 待命', listening: 'NW 聆听中', thinking: 'NW 思考中',
    speaking: `NW 生成中, ${props.tokenRate} tokens 每秒`, hidden: 'NW 隐藏',
  };
  return desc[props.state];
});

/* ---------- 突触布局: 12 个节点, 交替内外环 ---------- */
const synapses = (() => {
  const arr: Array<{ x: number; y: number; a: number }> = [];
  for (let i = 0; i < 12; i++) {
    const a = ((360 / 12) * i) * Math.PI / 180;
    const d = i % 2 === 0 ? 34 : 27;
    arr.push({ x: 50 + Math.cos(a) * d, y: 50 + Math.sin(a) * d, a });
  }
  return arr;
})();
const litSynapses = computed(() => Math.round(activation.value * synapses.length));

/* ---------- 神经脉冲: activity 越高, 发射越频繁 ---------- */
interface Pulse { id: number; x: number; y: number; dur: number }
const neuralPulses = ref<Pulse[]>([]);
let pulseId = 0;
let neuralTimer: ReturnType<typeof setInterval> | undefined;

function fireNeural(): void {
  const lit = synapses.slice(0, Math.max(1, litSynapses.value));
  const target = lit[Math.floor(Math.random() * lit.length)];
  const id = ++pulseId;
  neuralPulses.value.push({ id, x: target.x, y: target.y, dur: 500 + Math.random() * 250 });
  setTimeout(() => { neuralPulses.value = neuralPulses.value.filter(p => p.id !== id); }, 800);
}

function scheduleNeural(): void {
  if (neuralTimer) clearInterval(neuralTimer);
  if (props.state === 'hidden' || activation.value < 0.1) return;
  const interval = Math.round(1100 - activation.value * 840);
  neuralTimer = setInterval(fireNeural, Math.max(220, interval));
}

/* ---------- token 粒子: pulseSeq 每次自增 = 一枚 token 到达 → 喷射一枚 ---------- */
interface TParticle { id: number; x: number; y: number; dur: number }
const tokenParticles = ref<TParticle[]>([]);
let tId = 0;

function emitTokenParticle(): void {
  const a = Math.random() * 360 * Math.PI / 180;
  const d = 22 + Math.random() * 16;
  const id = ++tId;
  tokenParticles.value.push({
    id,
    x: 50 + Math.cos(a) * d,
    y: 50 + Math.sin(a) * d,
    dur: 700 + Math.random() * 400,
  });
  setTimeout(() => { tokenParticles.value = tokenParticles.value.filter(p => p.id !== id); }, 1200);
}

watch(() => props.pulseSeq, (nv, ov) => {
  if (nv > ov && props.state === 'speaking') emitTokenParticle();
});

watch([() => props.state, () => activation.value], scheduleNeural, { immediate: true });
onBeforeUnmount(() => { if (neuralTimer) clearInterval(neuralTimer); });
</script>

<style scoped>
.nw-orb {
  position: relative;
  display: inline-block;
  flex: 0 0 auto;
  isolation: isolate;
}

/* 上下文压力环 */
.orb-context-ring {
  position: absolute;
  inset: -4%;
  border-radius: 50%;
  background: conic-gradient(var(--ctx) var(--ctx-fill), rgba(255,255,255,0.06) 0);
  -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 2px));
          mask: radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 2px));
  opacity: 0.55;
  z-index: 0;
  transition: opacity 200ms ease;
}

/* 核心呼吸光晕 — 与 orb-circle 同周期: 光随呼吸"吸入呼出" */
/* v4.9：核心光晕中性化 —— 单色低饱和、无青紫双色霓虹。
   保留极轻的呼吸缩放（状态可感知），但去掉「科技概念图」外发光。 */
.orb-core {
  position: absolute;
  inset: 8%;
  border-radius: 50%;
  background: radial-gradient(circle at 50% 50%,
    rgba(160, 168, 186, 0.16) 0%, rgba(160, 168, 186, 0.06) 45%, transparent 72%);
  box-shadow: 0 0 8px rgba(160, 168, 186, 0.22);
  z-index: 0;
  animation: nw-glow var(--breath, 3s) ease-in-out infinite;
  will-change: transform, opacity;
}
@keyframes nw-glow {
  0%, 100% { transform: scale(0.92); opacity: 0.62; }
  50%      { transform: scale(1.06); opacity: 0.9; }
}
/* 状态差异靠灰度与极轻色偏表达，不外发光 */
.state-thinking .orb-core { box-shadow: 0 0 8px rgba(150, 155, 175, 0.26); }
.state-speaking .orb-core { box-shadow: 0 0 9px rgba(190, 165, 130, 0.26); }
.state-listening .orb-core { box-shadow: 0 0 9px rgba(150, 165, 195, 0.28); }

/* display:block 消除 inline SVG 的基线空隙; .orb-core 不参与 width/height 100% —
   它的尺寸必须完全由 inset: 8% 驱动, 否则与 inset 过约束(left+width 优先)会
   把光晕盒子推出右下边界 8%, 造成光点与光晕肉眼可见的对角偏移 */
.orb-svg { display: block; width: 100%; height: 100%; overflow: visible; }
.orb-core { display: block; overflow: visible; }

.orb-circle {
  transform-box: view-box;
  transform-origin: 50% 50%;
  animation: nw-breathe var(--breath, 3s) ease-in-out infinite;
}
@keyframes nw-breathe {
  0%, 100% { transform: scale(calc(0.9 * var(--orb-scale, 1))); }
  50%      { transform: scale(var(--orb-scale, 1.06)); }
}
.state-hidden .orb-circle { opacity: 0.35; animation: none; }

/* 神经轴突 / 突触 */
.axon { stroke-width: 0.6; opacity: 0.28; transition: opacity 240ms ease, stroke-width 240ms ease; }
.axon.lit { stroke-width: 0.9; opacity: 0.6; }
.synapse { opacity: 0.4; transition: opacity 240ms ease, filter 240ms ease; }
.synapse.lit { opacity: 1; filter: drop-shadow(0 0 2px currentColor); }

/* 神经脉冲: 在突触位置放大淡出 */
.neural-pulse {
  transform-box: view-box;
  transform-origin: 50% 50%;
  animation: nw-fire var(--dur, 700ms) ease-out forwards;
  filter: drop-shadow(0 0 3px rgba(255,255,255,0.9));
}
@keyframes nw-fire {
  0%   { transform: scale(0.3); opacity: 0; }
  20%  { opacity: 1; }
  100% { transform: scale(1.8); opacity: 0; }
}

/* token 粒子: 向外扩散淡出 */
.token-particle {
  transform-box: view-box;
  transform-origin: 50% 50%;
  fill: #ffb454;
  animation: nw-token var(--dur, 900ms) ease-out forwards;
  filter: drop-shadow(0 0 3px rgba(255,180,84,0.9));
}
@keyframes nw-token {
  0%   { transform: scale(0.4); opacity: 0; }
  20%  { opacity: 1; }
  100% { transform: scale(1.6); opacity: 0; }
}

/* listening: 雷达波纹 */
.orb-rings, .orb-rings g, .radar .radar-ring, .wave-bar {
  transform-box: view-box;
  transform-origin: 50% 50%;
}
.radar .radar-ring { opacity: 0; }
.radar .r1 { animation: nw-radar 1.8s ease-out infinite; }
.radar .r2 { animation: nw-radar 1.8s ease-out infinite 0.6s; }
.radar .r3 { animation: nw-radar 1.8s ease-out infinite 1.2s; }
@keyframes nw-radar {
  0%   { transform: scale(1); opacity: 0.9; }
  100% { transform: scale(2.2); opacity: 0; }
}

/* speaking: 声波 */
.wave-bar { opacity: 0.9; }
.wave-bar.w1 { animation: nw-w1 0.7s ease-in-out infinite alternate; }
.wave-bar.w2 { animation: nw-w2 0.8s ease-in-out 0.15s infinite alternate; }
.wave-bar.w3 { animation: nw-w3 0.9s ease-in-out 0.3s infinite alternate; }
@keyframes nw-w1 { 0% { transform: scaleY(0.55); opacity: 0.6; } 100% { transform: scaleY(1.4); opacity: 1; } }
@keyframes nw-w2 { 0% { transform: scaleY(1.2); opacity: 0.9; } 100% { transform: scaleY(0.5); opacity: 0.55; } }
@keyframes nw-w3 { 0% { transform: scaleY(0.7); opacity: 0.7; } 100% { transform: scaleY(1.6); opacity: 1; } }

/* 无障碍 */
@media (prefers-reduced-motion: reduce) {
  .orb-circle, .orb-core, .neural-pulse, .token-particle,
  .radar .radar-ring, .wave-bar { animation: none !important; }
  .neural-pulse, .token-particle { display: none; }
  .orb-circle { transform: scale(1); }
}
</style>
