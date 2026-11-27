<template>
  <div class="app-layout">
    <TitleBar />

    <!-- 更新提示 banner(非阻塞) -->
    <UpdateBanner />

    <div class="app-content">
      <SideNav />

      <main class="main-content">
        <!-- 不用 transition 包裹,避免组件切换失败 (B1-Bugfix)
             页面进入/离开动画由各 view 内部 Transition 处理 -->
        <router-view />
      </main>
    </div>

    <!-- Floating command button (macOS Spotlight style) -->
    <button
      class="floating-cmd-btn"
      :class="{ 'floating-cmd-btn--raised': isChatRoute }"
      title="命令面板 (Ctrl+K)"
      @click="openPalette"
    >
      <el-icon><Search /></el-icon>
      <span class="cmd-label">命令</span>
      <kbd>⌘K</kbd>
    </button>

    <!-- 全局命令面板 (Cmd+K) -->
    <CommandPalette />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage } from "element-plus/es/components/message/index";
import { useAppStore } from '@/stores/app';
const route = useRoute();
/**
 * 【M4-L 修】Chat 页把悬浮命令按钮**抬到输入区之上**。
 *
 * 现象(实测,e2e 抓到的):悬浮命令按钮是 `position:fixed; bottom:24px; right:24px`,
 * 而 Chat 的输入区(input-area)高 **125px**、其「发送」按钮位于 724~784px ——
 * 两者**完全重叠** → 用户点「发送」,点到的是命令按钮(实测 elementFromPoint 命中
 * 它的 `<kbd>⌘K</kbd>`)。发送是主操作,必须能点。
 *
 * 为什么不靠"输入区让位"(padding-right):那会在输入框右侧留一条 140px 的空档,
 * 很难看。抬按钮更省事,且命令面板本来就有 Ctrl+K 快捷键。
 */
const isChatRoute = computed(() => route.path.startsWith('/chat'));
import { useGatewayStore } from '@/stores/gateway';
import TitleBar from './TitleBar.vue';
import SideNav from './SideNav.vue';
import CommandPalette from '@/components/common/CommandPalette.vue';
import UpdateBanner from '@/components/common/UpdateBanner.vue';
import { Search } from '@element-plus/icons-vue';

const appStore = useAppStore();
const gatewayStore = useGatewayStore();

function openPalette(): void {
  window.dispatchEvent(new CustomEvent('cmd:open-palette'));
}

interface ToastDetail {
  type: 'success' | 'error' | 'warning' | 'info';
  text: string;
}

function onToast(e: Event): void {
  const ce = e as CustomEvent<ToastDetail>;
  const { type, text } = ce.detail || { type: 'info', text: '' };
  if (!text) return;
  switch (type) {
    case 'success': ElMessage.success(text); break;
    case 'error': ElMessage.error(text); break;
    case 'warning': ElMessage.warning(text); break;
    default: ElMessage.info(text);
  }
}

onMounted(() => {
  appStore.initialize();
  gatewayStore.initialize();
  window.addEventListener('cmd:toast', onToast);
  window.addEventListener('keydown', onGlobalKeydown);
});

onUnmounted(() => {
  window.removeEventListener('cmd:toast', onToast);
  window.removeEventListener('keydown', onGlobalKeydown);
});

function onGlobalKeydown(e: KeyboardEvent): void {
  const candidates: (HTMLElement | null)[] = [
    e.target as HTMLElement | null,
    document.activeElement as HTMLElement | null
  ];
  for (const el of candidates) {
    if (!el) continue;
    const tag = el.tagName?.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || el.isContentEditable) {
      return;
    }
  }
  const isMod = e.metaKey || e.ctrlKey;
  if (!isMod) return;
  if (e.key === 'k' || e.key === 'K') {
    e.preventDefault();
    openPalette();
    return;
  }
  if (e.key === '/') {
    e.preventDefault();
    openPalette();
    return;
  }
}
</script>

<style lang="scss" scoped>
.app-layout {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: var(--bg-base);
  -webkit-font-smoothing: antialiased;
}

.app-content {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.main-content {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  overflow-x: hidden;
  background: var(--bg-base);
  /* padding 由各 view 自管 — 防止重复 padding */
}

/* ========== Floating command button (Spotlight style) ========== */
.floating-cmd-btn {
  position: fixed;
  bottom: 24px;
  right: 24px;
  z-index: 100;

  /* Chat 页:抬到输入区(实测高 125px)之上,别压住「发送」按钮 */
  &--raised {
    bottom: 140px;
  }
  display: flex;
  align-items: center;
  gap: 8px;
  height: 44px;
  padding: 0 16px 0 14px;
  border: none;
  border-radius: 22px;
  background: var(--bg-elevated);
  color: var(--fg-secondary);
  font-family: inherit;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  cursor: pointer;
  box-shadow: var(--shadow-md);
  /* v4.9：收敛重度毛玻璃（saturate 180% blur 20px → 轻量 blur），减少「AI 概念图」观感 */
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  border: 1px solid var(--border-base);
  transition: transform var(--duration-fast) var(--ease-spring),
    box-shadow var(--duration-fast) var(--ease-standard),
    background-color var(--duration-fast) var(--ease-standard);

  .el-icon {
    font-size: 16px;
  }

  kbd {
    font-family: var(--font-family-mono);
    font-size: 11px;
    background: var(--bg-tertiary);
    border-radius: var(--radius-xs);
    padding: 1px 6px;
    margin-left: 4px;
    color: var(--fg-tertiary);
  }

  &:hover {
    transform: translateY(-2px) scale(1.02);
    box-shadow: var(--shadow-xl);
    background: var(--bg-elevated);
  }

  &:active {
    transform: translateY(0) scale(0.97);
    transition-duration: 80ms;
  }
}
</style>