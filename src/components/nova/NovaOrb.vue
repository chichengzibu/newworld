<!--
  NOVA #002 · 生命体 Orb (纯 SVG + CSS, 零业务依赖)
  口径 (命令 #002 §3):
    idle     = 呼吸辉光 3s 循环
    listening = 青色雷达波纹外扩
    thinking = 双粒子细环反向旋转 0.9s/圈 (紫)
    speaking = 声波环随机振幅抖动 (双色渐变)
    prefers-reduced-motion → 全部退化为静态光晕
  可复用: 只接收 size/state props, 不 import store / ipc / 任何业务模块
-->
<template>
  <!--
    class 动态绑定到根 div: .nova-orb / .state-{state}
    根元素 width/height 用 inline style 绑定 size
  -->
  <div
    :class="['nova-orb', 'state-' + state]"
    :style="{ width: size + 'px', height: size + 'px' }"
    role="img"
    :aria-label="state"
  >
    <!-- 底层辉光 (所有态共用, 状态控制强度) -->
    <div class="orb-core" aria-hidden="true"></div>

    <!-- SVG 层: 状态专属图形 -->
    <svg
      class="orb-svg"
      :width="size"
      :height="size"
      viewBox="0 0 100 100"
      aria-hidden="true"
    >
      <defs>
        <!-- 双色渐变 (speaking 声波环 / 通用描边) -->
        <linearGradient id="novaOrbGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#22d3ee"></stop>
          <stop offset="100%" stop-color="#a78bfa"></stop>
        </linearGradient>
        <!-- 核心高斯模糊 (所有态共用) -->
        <radialGradient id="novaOrbCore" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stop-color="rgba(34,211,238,0.9)"></stop>
          <stop offset="60%" stop-color="rgba(167,139,250,0.5)"></stop>
          <stop offset="100%" stop-color="rgba(5,5,8,0)"></stop>
        </radialGradient>
      </defs>

      <!-- 核心圆 (所有态都在, 状态控制辉光强度/动效) -->
      <circle class="orb-circle" cx="50" cy="50" r="18" fill="url(#novaOrbCore)"></circle>

      <!-- listening: 三道青色雷达波纹 (外扩, CSS 控制 animation delay) -->
      <g v-if="state === 'listening'" class="orb-rings radar">
        <circle class="radar-ring r1" cx="50" cy="50" r="25" fill="none" stroke="#22d3ee" stroke-width="1.5"></circle>
        <circle class="radar-ring r2" cx="50" cy="50" r="25" fill="none" stroke="#22d3ee" stroke-width="1.5"></circle>
        <circle class="radar-ring r3" cx="50" cy="50" r="25" fill="none" stroke="#22d3ee" stroke-width="1.5"></circle>
      </g>

      <!-- thinking: 双粒子细环反向旋转 (紫) -->
      <g v-if="state === 'thinking'" class="orb-rings think">
        <!-- 外环: 顺时针 0.9s/圈, 带 1 个粒子 -->
        <g class="think-ring clockwise">
          <circle cx="50" cy="50" r="30" fill="none" stroke="#a78bfa" stroke-width="1" opacity="0.5"></circle>
          <circle class="think-particle" cx="80" cy="50" r="2.5" fill="url(#novaOrbGrad)"></circle>
        </g>
        <!-- 内环: 逆时针 0.9s/圈, 带 1 个粒子 (偏相 180°) -->
        <g class="think-ring ccw">
          <circle cx="50" cy="50" r="22" fill="none" stroke="#a78bfa" stroke-width="0.8" opacity="0.5"></circle>
          <circle class="think-particle" cx="28" cy="50" r="2" fill="url(#novaOrbGrad)"></circle>
        </g>
      </g>

      <!-- speaking: 声波环 (双色渐变描边, 随机振幅抖动 = 3 条非对称弧线) -->
      <g v-if="state === 'speaking'" class="orb-rings wave">
        <path class="wave-bar w1" d="M 35 42 Q 32 50 35 58" fill="none" stroke="url(#novaOrbGrad)" stroke-width="2.5" stroke-linecap="round"></path>
        <path class="wave-bar w2" d="M 65 40 Q 68 50 65 60" fill="none" stroke="url(#novaOrbGrad)" stroke-width="2.5" stroke-linecap="round"></path>
        <path class="wave-bar w3" d="M 50 36 Q 46 50 50 64" fill="none" stroke="url(#novaOrbGrad)" stroke-width="3" stroke-linecap="round"></path>
      </g>
    </svg>
  </div>
</template>

<script setup lang="ts">
interface NovaOrbProps {
  /** 组件宽高 (px), 默认 64 */
  size?: number;
  /** 当前状态 (外部 store 注入, 组件不 import store) */
  state: 'idle' | 'listening' | 'thinking' | 'speaking' | 'hidden';
}

withDefaults(defineProps<NovaOrbProps>(), {
  size: 64,
});
</script>

<style scoped>
.nova-orb {
  position: relative;
  display: inline-block;
  flex: 0 0 auto;
  isolation: isolate;
}

/* === 核心 (所有态) === */
/* SVG 内元素以 viewBox 中心为变换基准 */
.orb-circle {
  animation: nova-breathe 3s ease-in-out infinite;
}
/* idle 态核心更柔和 (呼吸慢) */
.state-idle .orb-circle {
  animation-duration: 3s;
}
.state-thinking .orb-circle {
  /* thinking 时核心略小, 粒子在动 */
  opacity: 0.8;
  animation-duration: 2s;
}
.state-speaking .orb-circle {
  opacity: 1;
}
.state-listening .orb-circle {
  opacity: 0.9;
}
.state-hidden .orb-circle {
  opacity: 0.4;
  animation: none;
}
.orb-svg, .orb-core {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
}
/* SVG 变换基准: 所有态的环/粒子围绕 viewBox 中心 (50,50) 变换 */
.orb-rings,
.orb-rings g,
.orb-circle,
.radar .radar-ring,
.think-ring,
.think-ring circle,
.wave-bar {
  transform-box: view-box;
  transform-origin: 50% 50%;
}
/* 底层辉光层 (CSS box-shadow 控制, 与 orb-circle 叠加出 3D 光效) */
.orb-core {
  border-radius: 50%;
  background: radial-gradient(circle at 50% 50%,
    rgba(34, 211, 238, 0.18) 0%,
    rgba(167, 139, 250, 0.08) 40%,
    transparent 70%);
  box-shadow: var(--nova-glow-cyan, 0 0 12px rgba(34, 211, 238, 0.55));
  animation: nova-glow-pulse 3s ease-in-out infinite;
}
.state-thinking .orb-core {
  box-shadow: var(--nova-glow-violet, 0 0 12px rgba(167, 139, 250, 0.55));
}
.state-listening .orb-core {
  box-shadow: var(--nova-glow-cyan, 0 0 16px rgba(34, 211, 238, 0.7));
}
.orb-rings {
  transform-origin: 50px 50px;
}

/* === idle: 呼吸辉光 3s 循环 (orb-circle + orb-core 同步) === */
@keyframes nova-breathe {
  0%, 100% { transform: scale(1); }
  50%      { transform: scale(1.08); }
}
@keyframes nova-glow-pulse {
  0%, 100% { opacity: 0.7; }
  50%       { opacity: 1; }
}

/* === listening: 青雷达波纹外扩 (1.2s 循环, 3 道波错时) === */
.radar .radar-ring {
  transform-origin: 50px 50px;
  opacity: 0;
}
.radar .r1 { animation: nova-radar 1.8s ease-out infinite; }
.radar .r2 { animation: nova-radar 1.8s ease-out infinite 0.6s; }
.radar .r3 { animation: nova-radar 1.8s ease-out infinite 1.2s; }
@keyframes nova-radar {
  0%   { transform: scale(1);    opacity: 0.9; }
  100% { transform: scale(2.2);  opacity: 0; }
}
.state-listening .orb-circle {
  animation: nova-breathe 1.5s ease-in-out infinite; /* 听时呼吸加速 */
}

/* === thinking: 双粒子环反向旋转 0.9s/圈 (紫) === */
.think-ring { transform-origin: 50px 50px; }
.think-ring.clockwise { animation: nova-think-cw 0.9s linear infinite; }
.think-ring.ccw       { animation: nova-think-ccw 0.9s linear infinite; }
@keyframes nova-think-cw  { to { transform: rotate(360deg);  } }
@keyframes nova-think-ccw { to { transform: rotate(-360deg); } }
.think-particle {
  filter: drop-shadow(0 0 4px rgba(167, 139, 250, 0.9));
}

/* === speaking: 声波环随机振幅抖动 (双色渐变描边) === */
.wave-bar {
  transform-origin: 50px 50px;
  opacity: 0.9;
}
.wave-bar.w1 { animation: nova-wave-1 0.7s ease-in-out infinite alternate; }
.wave-bar.w2 { animation: nova-wave-2 0.8s ease-in-out 0.15s infinite alternate; }
.wave-bar.w3 { animation: nova-wave-3 0.9s ease-in-out 0.3s infinite alternate; }
@keyframes nova-wave-1 {
  0%   { transform: scaleY(0.55); opacity: 0.6; }
  100% { transform: scaleY(1.4);  opacity: 1; }
}
@keyframes nova-wave-2 {
  0%   { transform: scaleY(1.2);  opacity: 0.9; }
  100% { transform: scaleY(0.50); opacity: 0.55; }
}
@keyframes nova-wave-3 {
  0%   { transform: scaleY(0.70); opacity: 0.7; }
  100% { transform: scaleY(1.6);  opacity: 1; }
}
.state-speaking .orb-circle {
  animation: nova-breathe 1.2s ease-in-out infinite; /* 说话时呼吸加速 */
}

/* === 动效无障碍: prefers-reduced-motion → 全部退化为静态光晕 === */
@media (prefers-reduced-motion: reduce) {
  .orb-circle,
  .orb-core,
  .radar .radar-ring,
  .think-ring.clockwise,
  .think-ring.ccw,
  .wave-bar.w1, .wave-bar.w2, .wave-bar.w3 {
    animation: none !important;
  }
  /* 静态光晕版: 保留视觉焦点, 去掉动效 */
  .radar .radar-ring { opacity: 0.5; }
  .think-ring { opacity: 0.7; }
  .wave-bar { opacity: 0.7; transform: none; }
  .orb-core {
    opacity: 0.95;
    box-shadow: var(--nova-glow-cyan, 0 0 14px rgba(34, 211, 238, 0.6));
  }
}
</style>
