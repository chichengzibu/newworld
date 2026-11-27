<!--
  SideNav - 60px icon-only rail（v4.7 信息架构语义重组）

  设计:
  - rail 只常驻 3 个「工作对象」(对话 / 技能 / 定时任务),不再有配置类页面
  - 输入能力(搜索 / 语音)已下沉到 ChatInput 工具条
  - 配置类页面(模型 / IM / 权限 / 远程 / 账号)已收编进设置页的「配置中心」
  - 「更多」现在只放同质的「内容浏览」(私有技能仓库 / 模型对比 / 帮助)
  - 设置固定底部(大厂惯例:配置与工作视图分层)
  - 命令面板 Ctrl+K 是所有页面的兜底入口
  - 不删除任何路由,只把入口放回它该在的容器

  本组件完全由 nav-config.ts 驱动,四层分组的增删改都在那个文件里。

  兼容性(重要):
  - `nav.sidenav > a.nav-icon[href$="#/xxx"]` 仍是核心入口与设置的选择器,
    既有 e2e 的 gotoBySideNav 无需改动即可继续工作
  - 收进「更多」的入口是 `a.nav-more-item[href$="#/xxx"]`
  - 配置入口在设置页 `a.settings-link[href$="#/xxx"]`,由 helper 的兜底分支访问
-->
<template>
  <nav class="sidenav" data-testid="side-nav">
    <div class="nav-primary">
      <router-link
        v-for="item in primaryFirst"
        :key="item.path"
        :to="item.path"
        class="nav-icon"
        :class="{ active: isActive(item.path) }"
        :aria-label="t(item.titleKey)"
        :title="t(item.titleKey)"
      >
        <el-icon :size="18"><component :is="item.icon" /></el-icon>
      </router-link>

      <div class="nav-divider" role="separator" aria-orientation="horizontal" />

      <router-link
        v-for="item in primarySecond"
        :key="item.path"
        :to="item.path"
        class="nav-icon"
        :class="{ active: isActive(item.path) }"
        :aria-label="t(item.titleKey)"
        :title="t(item.titleKey)"
      >
        <el-icon :size="18"><component :is="item.icon" /></el-icon>
      </router-link>
    </div>

    <div class="nav-more-wrap">
      <button
        type="button"
        class="nav-icon nav-more-trigger"
        :class="{ active: isMoreActive, 'is-open': moreOpen }"
        :aria-label="t('nav.more')"
        :title="t('nav.more')"
        :aria-expanded="moreOpen"
        aria-haspopup="menu"
        data-testid="nav-more-trigger"
        @click.stop="toggleMore"
      >
        <el-icon :size="18"><MoreFilled /></el-icon>
      </button>

      <Transition name="more-pop">
        <div
          v-if="moreOpen"
          class="nav-more-panel"
          role="menu"
          :aria-label="t('nav.more')"
          data-testid="nav-more-panel"
          @click.stop
        >
          <div class="nav-more-head">
            <span class="nav-more-title">{{ t('nav.more') }}</span>
            <span class="nav-more-hint">{{ t('nav.moreHint') }}</span>
          </div>

          <div v-for="group in MORE_GROUPS" :key="group.key" class="nav-more-group">
            <div class="nav-more-group-label">{{ t(group.labelKey) }}</div>
            <router-link
              v-for="item in group.items"
              :key="item.path"
              :to="item.path"
              class="nav-more-item"
              :class="{ active: isExactActive(item.path) }"
              role="menuitem"
              :data-path="item.path"
              @click="closeMore"
            >
              <span class="nav-more-item-icon">
                <el-icon :size="16"><component :is="item.icon" /></el-icon>
              </span>
              <span class="nav-more-item-body">
                <span class="nav-more-item-title">{{ t(item.titleKey) }}</span>
                <span class="nav-more-item-desc">{{ t(item.descKey) }}</span>
              </span>
            </router-link>
          </div>
        </div>
      </Transition>
    </div>

    <div class="nav-spacer" />

    <router-link
      :to="SETTINGS_PATH"
      class="nav-icon"
      :class="{ active: isExactActive(SETTINGS_PATH) }"
      :aria-label="t('nav.settings')"
      :title="t('nav.settings')"
    >
      <el-icon :size="18"><Setting /></el-icon>
    </router-link>
  </nav>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { Setting, MoreFilled } from '@element-plus/icons-vue'
import {
  PRIMARY_NAV, PRIMARY_DIVIDER_AFTER, MORE_GROUPS, MORE_ITEMS, SETTINGS_PATH,
} from './nav-config'

const { t } = useI18n()
const route = useRoute()

const primaryFirst = PRIMARY_NAV.slice(0, PRIMARY_DIVIDER_AFTER)
const primarySecond = PRIMARY_NAV.slice(PRIMARY_DIVIDER_AFTER)

const moreOpen = ref(false)

const isActive = (path: string): boolean =>
  route.path === path || route.path.startsWith(path + '/')

/** 精确匹配:/settings/im-accounts 不应把底部「设置」也点亮(那里由「更多」负责) */
const isExactActive = (path: string): boolean => route.path === path

const isMoreActive = computed<boolean>(() =>
  MORE_ITEMS.some((item) => route.path === item.path),
)

function toggleMore(): void {
  moreOpen.value = !moreOpen.value
}

function closeMore(): void {
  moreOpen.value = false
}

function onDocumentClick(e: MouseEvent): void {
  if (!moreOpen.value) return
  const target = e.target as HTMLElement | null
  if (!target?.closest('.nav-more-wrap')) closeMore()
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && moreOpen.value) closeMore()
}

onMounted(() => {
  document.addEventListener('click', onDocumentClick)
  document.addEventListener('keydown', onKeyDown)
})

onUnmounted(() => {
  document.removeEventListener('click', onDocumentClick)
  document.removeEventListener('keydown', onKeyDown)
})

// 程序化跳转(命令面板 / 页面内链接)也要收起面板,避免残留浮层
watch(() => route.fullPath, () => closeMore())
</script>

<style lang="scss" scoped>
.sidenav {
  width: 60px;
  flex-shrink: 0;
  /* 「更多」面板要浮在 main-content 之上;不抬层级会被会话栏的「新建」
     按钮等后渲染元素盖住(实测深色/浅色截图都出现半截青色按钮压在面板上) */
  position: relative;
  z-index: 20;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 12px 0;
  background: var(--bg-base);
  border-right: 1px solid var(--border-subtle);
}

.nav-primary {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  width: 100%;
}

.nav-divider {
  width: 22px;
  height: 1px;
  margin: 6px 0;
  background: var(--border-subtle);
  flex-shrink: 0;
}

.nav-icon {
  width: 36px;
  height: 36px;
  flex-shrink: 0;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--fg-tertiary);
  background: transparent;
  text-decoration: none;
  position: relative;
  transition: background-color 120ms var(--ease-standard),
    color 120ms var(--ease-standard);

  /* 作为 <button> 使用时抹掉原生样式,与 <a> 完全一致 */
  appearance: none;
  border: 0;
  padding: 0;
  font: inherit;
  cursor: pointer;

  &:hover {
    background: var(--bg-hover);
    color: var(--fg-primary);
  }

  &.active {
    color: var(--accent-base);
    background: var(--accent-soft);
  }
}

.nav-more-wrap {
  position: relative;
  width: 100%;
  display: flex;
  justify-content: center;
  margin-top: 6px;
}

.nav-more-trigger.is-open {
  color: var(--accent-base);
  background: var(--accent-soft);
}

/* ===== 「更多」弹出面板 ===== */
.nav-more-panel {
  position: absolute;
  left: 52px;
  /* 垂直居中于触发器:从按钮向下展开会把「帮助」组挤到屏幕外(实测 8 个入口
     需要滚动才能看到最后一项),居中后上下都有空间 */
  top: calc(50% + 60px);
  transform: translateY(-50%);
  z-index: var(--z-popover, 300);
  width: 264px;
  max-height: min(84vh, 560px);
  overflow-y: auto;
  padding: 8px 8px 6px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-base);
  border-radius: 12px;
  box-shadow: var(--shadow-xl);
  font-family: var(--font-family-system);
}

.nav-more-head {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 2px 10px 8px;
  border-bottom: 1px solid var(--border-subtle);
  margin-bottom: 2px;
}

.nav-more-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--fg-primary);
}

.nav-more-hint {
  font-size: 11px;
  line-height: 1.4;
  color: var(--fg-tertiary);
}

.nav-more-group + .nav-more-group {
  margin-top: 5px;
  padding-top: 5px;
  border-top: 1px solid var(--border-subtle);
}

.nav-more-group-label {
  padding: 3px 10px 4px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--fg-tertiary);
}

.nav-more-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 4px 10px;
  border-radius: 8px;
  text-decoration: none;
  color: var(--fg-primary);
  transition: background-color 120ms var(--ease-standard);

  &:hover {
    background: var(--bg-hover);
  }

  &.active {
    background: var(--accent-soft);
  }
}

.nav-more-item-icon {
  width: 28px;
  height: 28px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 7px;
  background: var(--bg-tertiary);
  color: var(--fg-secondary);

  .nav-more-item.active & {
    color: var(--accent-base);
    background: var(--accent-soft);
  }
}

.nav-more-item-body {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.nav-more-item-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--fg-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.nav-more-item-desc {
  font-size: 11px;
  color: var(--fg-tertiary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.nav-spacer {
  flex: 1;
  min-height: 8px;
}

/* 面板进出:淡入 + 轻微缩放;transform 必须保留 translateY(-50%),否则居中会跳 */
.more-pop-enter-active,
.more-pop-leave-active {
  transition: opacity 160ms var(--ease-standard),
    transform 160ms var(--ease-standard);
}

.more-pop-enter-from,
.more-pop-leave-to {
  opacity: 0;
  transform: translateY(-50%) scale(0.97);
}
</style>
