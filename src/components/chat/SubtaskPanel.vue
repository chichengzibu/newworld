<!--
  【P3】并行子任务可视化 —— 复用 agentTrace 的"过程可见"语言，
  但与 ToolCallCard 分开：子任务有独立生命周期（running/done/failed）与聚合计数。
-->
<template>
  <div class="subtask-panel" data-testid="subtask-panel">
    <div class="subtask-head">
      <span class="subtask-title">并行子任务</span>
      <span class="subtask-summary">{{ doneCount }}/{{ entries.length }} 完成<span v-if="failedCount"> · {{ failedCount }} 失败</span></span>
    </div>
    <div class="subtask-list">
      <div
        v-for="s in entries"
        :key="s.id"
        class="subtask-row"
        :class="`subtask-row--${s.status}`"
      >
        <span class="subtask-index">{{ s.index + 1 }}</span>
        <div class="subtask-body">
          <div class="subtask-instruction">{{ s.instruction }}</div>
          <div v-if="s.status === 'failed'" class="subtask-error">{{ s.error || '子任务失败' }}</div>
          <div v-else class="subtask-meta">
            {{ statusText(s.status) }}<span v-if="s.durationMs"> · {{ formatDuration(s.durationMs) }}</span><span v-if="s.status === 'done' && s.tokens"> · {{ s.tokens }} tokens</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { SubtaskTraceEntry } from '@/stores/chat'

const props = defineProps<{ entries: SubtaskTraceEntry[] }>()

const doneCount = computed(() => props.entries.filter(s => s.status === 'done').length)
const failedCount = computed(() => props.entries.filter(s => s.status === 'failed').length)

function statusText(status: SubtaskTraceEntry['status']): string {
  if (status === 'done') return '已完成'
  if (status === 'failed') return '失败'
  return '执行中'
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}
</script>

<style scoped>
.subtask-panel {
  margin: 6px 0;
  padding: 8px 12px;
  border: 1px solid var(--border-base, #e4e7ed);
  border-radius: 10px;
  background: var(--bg-secondary, transparent);
}

.subtask-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}

.subtask-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--fg-primary, #303133);
}

.subtask-summary {
  font-size: 11px;
  color: var(--fg-tertiary, #909399);
}

.subtask-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.subtask-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--fg-secondary, #606266);
}

.subtask-index {
  flex: 0 0 18px;
  height: 18px;
  border: 1px solid var(--border-base, #e4e7ed);
  border-radius: 9999px;
  text-align: center;
  line-height: 16px;
  font-size: 10px;
  color: var(--fg-tertiary, #909399);
}

.subtask-body {
  min-width: 0;
  flex: 1;
}

.subtask-instruction {
  word-break: break-word;
  color: var(--fg-primary, #303133);
}

.subtask-meta {
  color: var(--fg-tertiary, #909399);
  font-size: 11px;
}

.subtask-row--done .subtask-index {
  border-color: var(--success-color, #67c23a);
  color: var(--success-color, #67c23a);
}

.subtask-row--failed .subtask-index {
  border-color: var(--danger-color, #f56c6c);
  color: var(--danger-color, #f56c6c);
}

.subtask-error {
  color: var(--danger-color, #f56c6c);
  font-size: 11px;
  word-break: break-word;
}
</style>
