/**
 * PiPiClaw - 执行模式切换器 (M1-E)
 *
 * 【为什么必须有这个组件】
 * 审计发现: executionMode store 定义了 safe/plan/craft 三档,
 * 但 UI 上没有任何地方显示当前模式、更没有切换控件。
 * 而默认值是 'craft'(权限内自动执行) —— 等于用户在整个产品里
 * 看不到"我现在处于自动执行模式"这个事实。
 *
 * 对自动化助手来说这是安全底线问题: 用户必须随时知道自己给 agent
 * 多大的权限。本组件把模式变成【常驻可见 + 一键可切】,并对高危档
 * (craft) 做二次确认 —— 因为"放开限制"本身就是一个需要慎重的事。
 */
<template>
  <div class="mode-switch">
    <el-tooltip
      :content="tooltipText"
      placement="top"
      :show-after="200"
    >
      <button
        class="mode-badge"
        :class="[`mode-${currentMode}`, { 'is-high-risk': currentMode === 'craft' }]"
        :aria-label="`执行模式:${config?.name ?? currentMode}`"
        @click="dropdownVisible = !dropdownVisible"
      >
        <span class="mode-dot" aria-hidden="true"></span>
        <span class="mode-name">{{ config?.name ?? currentMode }}</span>
        <el-icon class="mode-caret"><ArrowDown /></el-icon>
      </button>
    </el-tooltip>

    <el-dropdown
      v-model:visible="dropdownVisible"
      trigger="click"
      placement="top-start"
      @command="onSelect"
    >
      <template #dropdown>
        <el-dropdown-menu>
          <el-dropdown-item
            v-for="m in modes"
            :key="m.mode"
            :command="m.mode"
            :class="{ 'is-active': m.mode === currentMode }"
          >
            <div class="mode-option">
              <div class="mode-option-head">
                <span class="mode-option-name">{{ t(m.nameKey) }}</span>
                <el-tag
                  v-if="m.mode === 'craft'"
                  size="small"
                  type="danger"
                  effect="dark"
                >{{ t('executionMode.riskTag') }}</el-tag>
              </div>
              <div class="mode-option-desc">{{ t(m.descKey) }}</div>
            </div>
          </el-dropdown-item>
          <el-dropdown-item divided command="__about__">
            <span class="mode-about">{{ t('executionMode.about') }}</span>
          </el-dropdown-item>
        </el-dropdown-menu>
      </template>
    </el-dropdown>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage, ElMessageBox } from 'element-plus'
import { ArrowDown } from '@element-plus/icons-vue'
import { useExecutionModeStore, type ExecutionMode } from '@/stores/executionMode'

const { t } = useI18n()
const store = useExecutionModeStore()
const dropdownVisible = ref(false)

const modes = [
  { mode: 'safe' as ExecutionMode, nameKey: 'executionMode.safe', descKey: 'executionMode.safeDesc' },
  { mode: 'plan' as ExecutionMode, nameKey: 'executionMode.plan', descKey: 'executionMode.planDesc' },
  { mode: 'craft' as ExecutionMode, nameKey: 'executionMode.craft', descKey: 'executionMode.craftDesc' },
]

const currentMode = computed(() => store.currentMode)
const config = computed(() => store.currentModeConfig)

const tooltipText = computed(() => {
  const name = config.value?.name ?? currentMode.value
  const desc = config.value?.description ?? ''
  return `${t('executionMode.tooltipPrefix')}:${name} — ${desc}`
})

async function onSelect(cmd: string): Promise<void> {
  dropdownVisible.value = false
  if (cmd === '__about__') {
    ElMessageBox.alert(
      t('executionMode.aboutDetail'),
      t('executionMode.about'),
      { confirmButtonText: t('common.ok') ?? '知道了' },
    )
    return
  }
  const mode = cmd as ExecutionMode
  if (mode === currentMode.value) return

  // 【安全设计】切到全量模式 = 放开大部分执行限制,这本身需要用户明确知情
  if (mode === 'craft') {
    try {
      await ElMessageBox.confirm(
        t('executionMode.craftConfirm'),
        t('executionMode.craftConfirmTitle'),
        {
          type: 'warning',
          confirmButtonText: t('executionMode.craftConfirmOk'),
          cancelButtonText: t('common.cancel') ?? '取消',
        },
      )
    } catch {
      return // 用户取消,模式不变
    }
  }

  const ok = await store.setMode(mode)
  if (ok) {
    ElMessage.success(t('executionMode.switched'))
  } else {
    ElMessage.error(t('executionMode.switchFailed'))
  }
}

onMounted(() => { void store.fetchMode() })
</script>

<style scoped>
.mode-switch { position: relative; display: inline-flex; }

.mode-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border: 1px solid var(--el-border-color, #dcdfe6);
  border-radius: 14px;
  background: transparent;
  cursor: pointer;
  font-size: 12px;
  line-height: 1.6;
  color: var(--el-text-color-regular, #606266);
  transition: border-color .15s, background .15s;
}
.mode-badge:hover { background: var(--el-fill-color-light, #f5f7fa); }

.mode-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
.mode-safe .mode-dot  { background: #67c23a; }  /* 绿:不执行 */
.mode-plan  .mode-dot  { background: #e6a23c; }  /* 橙:确认后执行 */
.mode-craft .mode-dot  { background: #f56c6c; }  /* 红:自动执行 */

.mode-craft.is-high-risk {
  border-color: var(--el-color-danger, #f56c6c);
  color: var(--el-color-danger, #f56c6c);
}
.mode-caret { font-size: 11px; opacity: .6; }

.mode-option { max-width: 300px; padding: 2px 0; }
.mode-option-head { display: flex; align-items: center; gap: 6px; }
.mode-option-name { font-weight: 600; }
.mode-option-desc { font-size: 11px; color: var(--el-text-color-secondary, #909399); margin-top: 2px; }
.mode-about { font-size: 11px; opacity: .7; }
.is-active { font-weight: 600; }
</style>