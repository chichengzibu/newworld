<template>
  <div class="title-bar">
    <div class="title-bar-drag">
      <div class="app-title">
        <el-icon class="app-icon"><Setting /></el-icon>
        <span class="app-name">PiPiClaw</span>
      </div>
    </div>

    <!-- 网关状态:居中显示 小圆点 + 端口号,无文字装饰 -->
    <div
      v-if="gatewayStore.status.port"
      class="gateway-indicator"
      :class="`is-${gatewayStore.status.state}`"
      :title="stateTitle"
    >
      <span class="gateway-dot"></span>
      <span class="gateway-port">{{ gatewayStore.status.port }}</span>
    </div>

    <div class="window-controls">
      <button
        class="control-btn minimize"
        @click="handleMinimize"
        title="最小化"
        aria-label="最小化"
      >
        <el-icon><Minus /></el-icon>
      </button>

      <button
        class="control-btn maximize"
        @click="handleMaximize"
        :title="isMaximized ? '还原' : '最大化'"
        :aria-label="isMaximized ? '还原' : '最大化'"
      >
        <!-- 还原:两个嵌套方块 (Windows 标准 restore-down 图标) -->
        <svg
          v-if="isMaximized"
          class="control-svg"
          viewBox="0 0 16 16"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
        >
          <rect x="5.5" y="5.5" width="8" height="8" rx="1" stroke="currentColor" stroke-width="1.2" fill="none" />
          <path d="M2.5 10.5V3.5C2.5 2.95 2.95 2.5 3.5 2.5H10.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" fill="none" />
        </svg>
        <el-icon v-else><FullScreen /></el-icon>
      </button>

      <button
        class="control-btn close"
        @click="handleClose"
        title="关闭"
        aria-label="关闭"
      >
        <el-icon><Close /></el-icon>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue';
import { Minus, FullScreen, Close, Setting } from '@element-plus/icons-vue';
import { useGatewayStore } from '@/stores/gateway';

const isMaximized = ref(false);
const gatewayStore = useGatewayStore();

// 圆点 hover 提示:仅状态语义,不额外装饰
const stateTitle = computed(() => {
  const map: Record<string, string> = {
    running: '网关运行中',
    starting: '网关启动中',
    stopping: '网关停止中',
    stopped: '网关已停止',
    failed: '网关启动失败'
  };
  return map[gatewayStore.status.state] ?? '网关';
});

const handleMinimize = async (): Promise<void> => {
  try {
    if (window.electronAPI?.window) {
      await window.electronAPI.window.minimize();
    }
  } catch (error) {
    console.error('最小化失败:', error);
  }
};

const handleMaximize = async (): Promise<void> => {
  try {
    if (window.electronAPI?.window) {
      await window.electronAPI.window.maximize();
    }
  } catch (error) {
    console.error('最大化失败:', error);
  }
};

const handleClose = async (): Promise<void> => {
  try {
    if (window.electronAPI?.window) {
      await window.electronAPI.window.close();
    }
  } catch (error) {
    console.error('关闭失败:', error);
  }
};

let unsubscribe: (() => void) | undefined;

onMounted(async () => {
  try {
    if (window.electronAPI?.window) {
      isMaximized.value = await window.electronAPI.window.isMaximized();
      unsubscribe = window.electronAPI.window.onMaximizeChange((maximized) => {
        isMaximized.value = maximized;
      });
    }
  } catch (error) {
    console.error('初始化最大化状态失败:', error);
  }
});

onUnmounted(() => {
  if (unsubscribe) {
    unsubscribe();
  }
});
</script>

<style lang="scss" scoped>
@use "@/styles/variables.scss" as *;

.title-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  height: $title-bar-height;
  flex-shrink: 0;
  background: var(--bg-base);
  border-bottom: 1px solid var(--border-base);
  -webkit-app-region: drag;
  user-select: none;
}

.title-bar-drag {
  flex: 1;
  display: flex;
  align-items: center;
  height: 100%;
  padding-left: 12px;
}

// 右上角(最小化按钮左侧)网关状态:小圆点 + 端口号,无文字装饰
.gateway-indicator {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-right: 8px;
  padding-right: 4px;
  -webkit-app-region: drag;
  user-select: none;
}

.gateway-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--fg-muted, #9ca3af);
  box-shadow: 0 0 0 0 transparent;
  transition: background-color var(--duration-fast) var(--ease-standard);
}

.gateway-port {
  font-size: 11px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.3px;
  color: var(--fg-secondary);
}

// 状态着色 (仅圆点)
.gateway-indicator.is-running .gateway-dot {
  background: #22c55e;
  box-shadow: 0 0 6px 0 rgba(34, 197, 94, 0.55);
}
.gateway-indicator.is-stopped .gateway-dot {
  background: #6b7280;
}
.gateway-indicator.is-starting .gateway-dot,
.gateway-indicator.is-stopping .gateway-dot {
  background: #f59e0b;
}
.gateway-indicator.is-failed .gateway-dot {
  background: #ef4444;
  box-shadow: 0 0 6px 0 rgba(239, 68, 68, 0.55);
}

.app-title {
  display: flex;
  align-items: center;
  gap: 8px;
}

.app-icon {
  font-size: 16px;
  color: var(--accent-base);
}

.app-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--fg-primary);
}

.window-controls {
  display: flex;
  align-items: center;
  height: 100%;
  -webkit-app-region: no-drag;
  border-left: 1px solid var(--border-base);
  margin-left: 8px;
}

.control-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 46px;
  height: 100%;
  border: none;
  background: transparent;
  color: var(--fg-secondary);
  cursor: pointer;
  transition: background-color var(--duration-fast) var(--ease-standard),
    color var(--duration-fast) var(--ease-standard);

  .el-icon {
    font-size: 16px;
  }

  // 自定义 inline SVG(还原图标)尺寸
  .control-svg {
    width: 16px;
    height: 16px;
  }
}

.control-btn:hover {
  background: var(--bg-hover);
  color: var(--fg-primary);
}

.control-btn:active {
  background: var(--bg-active);
}

// 关闭按钮:静止时就有 danger 软底,提示"危险操作"
.control-btn.close {
  color: var(--fg-secondary);

  &:hover {
    background: var(--danger);
    color: var(--fg-on-accent);
  }
}
</style>
