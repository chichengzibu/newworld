/**
 * 性能监控 Store (零依赖,大厂可观测性做法)
 *
 * 指标来源:
 * - FPS: requestAnimationFrame 计时 (每 ~1s 计算一次帧率)
 * - 内存: performance.memory.usedJSHeapSize (Chrome/Electron 支持)
 * - Web Vitals: PerformanceObserver 收集 LCP / CLS / INP / FCP, navigation 取 TTFB
 *
 * 数据仅在前端聚合,开发者面板 (DevPanel) 读取展示。
 * 如需上报,可在此 start() 内额外把指标通过 IPC 发往主进程日志。
 */
import { defineStore } from 'pinia';
import { reactive, ref } from 'vue';

// 由 vite define 注入的构建信息 (替换裸标识符 __APP_VERSION__ / __BUILD_TIME__)。
// 注意: 不要用 `declare const`,esbuild 的 define 可能误替换类型层标识符导致语法损坏;
// 直接在值位置赋值最稳。
// 声明文件 src/types/vite-defines.d.ts 提供 ambient 类型给 vue-tsc。
const APP_VERSION: string = __APP_VERSION__;
const BUILD_TIME: string = __BUILD_TIME__;

interface Vitals {
  LCP: number;
  CLS: number;
  INP: number;
  FCP: number;
  TTFB: number;
}

interface BuildInfo {
  version: string;
  time: string;
}

export const usePerfStore = defineStore('perf', () => {
  const fps = ref(0);
  const memUsedMB = ref(0);
  const vitals = reactive<Vitals>({ LCP: 0, CLS: 0, INP: 0, FCP: 0, TTFB: 0 });
  const build = reactive<BuildInfo>({
    version: APP_VERSION,
    time: BUILD_TIME,
  });

  let started = false;
  let rafId = 0;
  let lastTs = 0;
  let frames = 0;

  function loop(t: number) {
    if (!lastTs) lastTs = t;
    frames++;
    const elapsed = t - lastTs;
    if (elapsed >= 1000) {
      fps.value = Math.round((frames * 1000) / elapsed);
      frames = 0;
      lastTs = t;
    }
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    if (mem) memUsedMB.value = Math.round(mem.usedJSHeapSize / 1048576);
    rafId = requestAnimationFrame(loop);
  }

  function observeVitals() {
    try {
      if (!('PerformanceObserver' in window)) return;

      // LCP: 取最后一条 LCP 记录
      new PerformanceObserver((list) => {
        const entries = list.getEntries();
        const lastEntry = entries[entries.length - 1] as PerformanceEntry & { startTime: number };
        vitals.LCP = lastEntry.startTime;
      }).observe({ type: 'largest-contentful-paint', buffered: true });

      // CLS: 累计非用户输入触发的布局偏移
      let cls = 0;
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean })[]) {
          if (!entry.hadRecentInput) cls += entry.value;
        }
        vitals.CLS = cls;
      }).observe({ type: 'layout-shift', buffered: true });

      // INP: 取交互事件最大耗时 (durationThreshold 16ms 起算)
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as (PerformanceEntry & { duration: number })[]) {
          if (entry.duration > vitals.INP) vitals.INP = entry.duration;
        }
      }).observe({ type: 'event', buffered: true, durationThreshold: 16 } as PerformanceObserverInit & { durationThreshold: number });

      // FCP: 首条 paint 记录
      new PerformanceObserver((list) => {
        const entry = list.getEntries()[0] as PerformanceEntry & { startTime: number };
        if (entry) vitals.FCP = entry.startTime;
      }).observe({ type: 'paint', buffered: true });

      // TTFB: 从 navigation timing 取 responseStart
      const nav = performance.getEntriesByType('navigation')[0] as PerformanceEntry & { responseStart: number };
      if (nav) vitals.TTFB = nav.responseStart;
    } catch {
      /* ignore: 某些环境不支持全部指标 */
    }
  }

  function start() {
    if (started) return;
    started = true;
    rafId = requestAnimationFrame(loop);
    observeVitals();
  }

  function stop() {
    if (!started) return;
    cancelAnimationFrame(rafId);
    started = false;
  }

  return { fps, memUsedMB, vitals, build, start, stop };
});
