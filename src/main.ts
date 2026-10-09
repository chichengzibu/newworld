/**
 * PiPiClaw - Vue应用入口
 *
 * 性能优化 (v4.5):
 * - JS: 不再 app.use(ElementPlus) 全量注册, 改为 unplugin-vue-components 按需注入组件;
 *   ElMessage/ElMessageBox 改为深层导入 element-plus/es/components/<name>/index,
 *   使 vendor-framework 从 ~1.1MB 降到 137KB。
 * - CSS: 仍保留全量 element-plus/dist/index.css (355KB, gzip ~50KB),
 *   原因: 全局注册的图标、v-for 动态渲染的 <el-*> 组件无法被静态分析捕获样式,
 *   去掉会导致图标大小/位置错乱、部分组件不显示。CSS 不阻塞 JS 执行, 流畅度由上述 JS 优化保障。
 * - 国际化 locale 由 App.vue 的 <el-config-provider> 注入。
 */

import { createApp } from 'vue';
import { createPinia } from 'pinia';
import * as ElementPlusIcons from '@element-plus/icons-vue';
import zhCn from 'element-plus/dist/locale/zh-cn.mjs';
import enUs from 'element-plus/dist/locale/en.mjs';

import App from './App.vue';
import router from './router';
import i18n, { setLocale } from './locales';
import './styles/reset.scss';
import './styles/global.scss';
// 启动骨架屏(从 main.ts 引入,确保 vite build 把 css 打进 vendor 而非 <link>)
import './styles/boot-splash.css';

// ============ 真实用户监控 (Sentry / Electron) ============
// 渲染端只初始化一次,事件经 preload 桥接转发到主进程统一上报。
// DSN 来自 VITE_SENTRY_DSN;未配置则不初始化(dev/内网零上报)。
import * as SentryRenderer from '@sentry/electron/renderer';
const SENTRY_DSN = (import.meta as { env?: { VITE_SENTRY_DSN?: string } }).env?.VITE_SENTRY_DSN;
if (SENTRY_DSN) {
  SentryRenderer.init({
    dsn: SENTRY_DSN,
    environment: (import.meta as { env?: { DEV?: boolean } }).env?.DEV ? 'development' : 'production',
    tracesSampleRate: 0.1,
    sampleRate: 1.0,
  });
}

// P0 修复: 全量 Element Plus CSS (组件样式 + 图标尺寸 base 变量)
// 背景: 移除全量 css 后, 通过 app.component() 全局注册的图标、以及 v-for 动态渲染的
// <el-*> 组件无法被 unplugin-vue-components 静态分析捕获, 导致样式缺失 → 图标大小/位置错乱、部分不显示。
// 全量 css 虽 383KB, 但 CSS 不阻塞 JS 执行 (运行时流畅度由已优化的 JS 保障), 且 gzip 后 ~50KB 一次性下载有缓存。
import 'element-plus/dist/index.css';
// 暗色主题变量
import 'element-plus/theme-chalk/dark/css-vars.css';

const app = createApp(App);

// 全局注册 Element Plus 图标
// SideNav.vue 使用 <component :is="item.icon" /> 配合字符串名('House' 等),
// 必须通过 app.component() 全局注册才能解析。
for (const [name, comp] of Object.entries(ElementPlusIcons)) {
  app.component(name, comp as never);
}

app.use(createPinia());
app.use(router);
app.use(i18n);
app.mount('#app');

// ============ 渲染错误兜底:把 Vue / 资源错误写到 DOM 上 ============
// 背景: 白屏问题排查时,普通用户开 DevTools 门槛高,直接挂屏显错更直观。
// 三种来源都覆盖: Vue render error / 资源加载失败 / unhandledrejection。
function paintFatalError(source: string, payload: unknown) {
  try {
    const root = document.getElementById('app') || document.body;
    const text = (() => {
      try { return typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2); }
      catch { return String(payload); }
    })();
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#1a0f0f;color:#ffb4b4;font-family:monospace;padding:24px;overflow:auto;white-space:pre-wrap;line-height:1.5;border:2px solid #ff5252;';
    box.innerText = `[PiPiClaw render error]\nsource: ${source}\n\n${text}\n\n— 截图给开发者定位 —`;
    root.appendChild(box);
  } catch { /* swallow */ }
}

app.config.errorHandler = (err, _instance, info) => {
  // eslint-disable-next-line no-console
  console.error('[PiPiClaw] Vue error:', err, info);
  // 真实用户监控:Vue 渲染/逻辑错误上报到 Sentry(未配置 DSN 时 no-op)
  SentryRenderer.captureException(err instanceof Error ? err : new Error(String(err)), {
    contexts: { vue: { info } },
  });
  paintFatalError(`Vue ${info}`, err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err));
};

window.addEventListener('error', (e) => {
  if (e?.error || e?.message) {
    paintFatalError('window.error', e.error?.stack ?? `${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`);
  }
});

window.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason instanceof Error ? `${e.reason.message}\n${e.reason.stack ?? ''}` : String(e.reason);
  paintFatalError('unhandledrejection', reason);
});

// 暴露 setLocale 给浏览器调试或 electron preload（不导出 main 包）
(window as unknown as { __setLocale?: typeof setLocale }).__setLocale = setLocale;