/**
 * New World - Vue Router路由配置
 * 
 * 职责：
 * 1. 定义应用路由
 * 2. 配置路由守卫
 * 3. 管理路由元信息
 */

import { createRouter, createWebHashHistory, RouteRecordRaw } from 'vue-router';

const routes: RouteRecordRaw[] = [
  {
    // v4.5: 主页直接是 Chat,不再经过 Dashboard。
    // 符合 ChatGPT / Claude / Cursor / WorkBuddy 等现代 AI 客户端惯例:
    // 打开就是对话框,无需多余点击。
    path: '/',
    redirect: '/chat'
  },
  {
    path: '/chat',
    name: 'Chat',
    component: () => import('@/views/Chat.vue'),
    meta: {
      title: '对话',
      icon: 'ChatDotRound'
    }
  },
  {
    path: '/skills',
    name: 'Skills',
    component: () => import('@/views/SkillsView.vue'),
    meta: {
      title: '技能管理',
      icon: 'Box'
    }
  },
  {
    path: '/settings',
    name: 'Settings',
    component: () => import('@/views/Settings.vue'),
    meta: {
      title: '设置',
      icon: 'Setting'
    }
  },
  {
    path: '/models',
    name: 'Models',
    component: () => import('@/views/Models.vue'),
    meta: { title: '模型', icon: 'Cpu' }
  },
  {
    // v4.9：配置中心四项不再是整页 —— 统一渲染 Settings，并在其右侧面板内切换
    path: '/permissions',
    name: 'Permissions',
    component: () => import('@/views/Settings.vue'),
    props: { initialConfigPath: '/permissions' },
    meta: { title: '权限', icon: 'Lock' }
  },
  {
    path: '/search',
    name: 'Search',
    component: () => import('@/views/Search.vue'),
    meta: { title: '搜索', icon: 'Search' }
  },
  {
    path: '/voice',
    name: 'Voice',
    component: () => import('@/views/Voice.vue'),
    meta: { title: '语音', icon: 'Microphone' }
  },
  {
    // 【设计审计 #P0-4】插件市场已下架 — 原页面为假数据演示卡(下载量/评分均为编造),
    // 无真实生态前不暴露该页; 私有技能分发走 /clawhub。
    path: '/plugin-market',
    redirect: '/clawhub'
  },
  {
    path: '/remote-control',
    name: 'RemoteControl',
    component: () => import('@/views/Settings.vue'),
    props: { initialConfigPath: '/remote-control' },
    meta: { title: '远程控制', icon: 'Connection' }
  },
  {
    path: '/schedule',
    name: 'Schedule',
    component: () => import('@/views/Schedule.vue'),
    meta: { title: '计划任务', icon: 'Calendar' }
  },
  {
    // 【设计审计 #P0-3】/tasks(自动化任务)与 /schedule(定时任务)语义重叠 → 统一入口。
    // 老链接 /tasks 重定向到 /schedule; Tasks.vue 保留文件但不再注册独立页面。
    path: '/tasks',
    redirect: '/schedule'
  },
  {
    path: '/d1-demo',
    name: 'D1ScreenshotDemo',
    component: () => import('@/views/D1ScreenshotDemo.vue'),
    meta: { title: 'D1 截屏', icon: 'Camera', devOnly: true }
  },
  {
    path: '/d5-demo',
    name: 'D5RecordingToSkill',
    component: () => import('@/views/D5RecordingToSkill.vue'),
    meta: { title: 'D5 录屏', icon: 'VideoCamera', devOnly: true }
  },
  {
    path: '/d3-demo',
    name: 'D3RemoteDemo',
    component: () => import('@/views/D3RemoteDemo.vue'),
    meta: { title: 'D3 远程', icon: 'Promotion', devOnly: true }
  },
  {
    path: '/a5-demo',
    name: 'A5ComputerUseDemo',
    component: () => import('@/views/A5ComputerUseDemo.vue'),
    meta: { devOnly: true },
  },
  {
    path: '/d2-prime-demo',
    name: 'D2PrimeDemo',
    component: () => import('@/views/D2PrimeDemo.vue'),
    meta: { devOnly: true },
  },
  {
    path: '/settings/im-accounts',
    name: 'ImAccounts',
    component: () => import('@/views/Settings.vue'),
    props: { initialConfigPath: '/settings/im-accounts' },
  },
  {
    path: '/im-management',
    name: 'ImManagement',
    component: () => import('@/views/Settings.vue'),
    props: { initialConfigPath: '/im-management' },
    meta: { title: 'IM 管理', icon: 'ChatDotRound' },
  },
  {
    path: '/clawhub',
    name: 'ClawHub',
    component: () => import('@/views/ClawHub.vue'),
    // 【M4-X】本地模拟市场已删 → 这页现在是「私有技能仓库」(自建仓库,带签名)
    meta: { title: '私有技能仓库', icon: 'Goods' },
  },
  {
    // 【设计审计 #P0-3】模型配置统一入口 = /models(模型管理)。
    // /settings/llm-config 重定向过去; humanizeError 的「打开 LLM 配置」同步改指 /models。
    path: '/settings/llm-config',
    redirect: '/models'
  },
];

const router = createRouter({
  history: createWebHashHistory(),
  routes
});

// devOnly 路由:生产构建不导出 + 导航守卫拦截
const isDev = (import.meta as { env?: { DEV?: boolean } })?.env?.DEV
if (!isDev) {
  // 生产模式:把 devOnly 路由重定向到主页 /chat(原本 /dashboard 已删除)
  router.beforeEach((to, _from, next) => {
    if (to.meta?.devOnly) {
      next('/chat')
    } else {
      next()
    }
  })
}

// 路由守卫：每次路由切换时更新页面标题
router.beforeEach((to, _, next) => {
  const title = to.meta.title as string;
  if (title) {
    document.title = `${title} - New World`;
  }
  next();
});

// 大厂做法: 空闲时预载高频路由 chunk,减少路由切换白屏。
// 使用字面量动态 import 复用 routes 中相同的 chunk(基于模块路径去重)。
const PREFETCH_VIEWS = [
  () => import('@/views/Chat.vue'),
  () => import('@/views/SkillsView.vue'),
  () => import('@/views/Models.vue'),
  () => import('@/views/Settings.vue'),
  () => import('@/views/ImManagement.vue'),
  () => import('@/views/ClawHub.vue'),
];

/**
 * 应用启动后空闲预载高频路由。建议 App 根 mounted 后调用。
 * requestIdleCallback 在浏览器空闲时预载,避免与首屏渲染争抢资源;
 * 不支持时降级为 setTimeout 3s。
 */
export function prefetchRoutes() {
  if (typeof window === 'undefined') return;
  const run = () => {
    PREFETCH_VIEWS.forEach((load) => {
      try { void load(); } catch { /* ignore */ }
    });
  };
  const w = window as unknown as {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void;
  };
  if (typeof w.requestIdleCallback === 'function') {
    w.requestIdleCallback(run, { timeout: 4000 });
  } else {
    window.setTimeout(run, 3000);
  }
}

export default router;
