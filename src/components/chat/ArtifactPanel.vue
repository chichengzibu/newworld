<!--
  成品交付可视化 —— 展示 agent 真实落盘的 docx/xlsx/pptx。
  关键纪律：只显示主进程 stat 过的文件（路径/大小都是真实值），不显示模型口头的"已生成"。
-->
<template>
  <div class="artifact-panel" data-testid="artifact-panel">
    <div class="artifact-head">
      <span class="artifact-title">成品文件</span>
      <span class="artifact-count">{{ artifacts.length }} 份</span>
    </div>
    <div class="artifact-list">
      <div
        v-for="(a, i) in artifacts"
        :key="a.path || i"
        class="artifact-row"
        :data-testid="`artifact-row-${i}`"
      >
        <span class="artifact-kind" :class="`artifact-kind--${a.kind}`">{{ kindLabel(a.kind) }}</span>
        <div class="artifact-body">
          <div class="artifact-name" :title="a.path">{{ a.name }}</div>
          <div class="artifact-meta">{{ formatSize(a.size) }}</div>
        </div>
        <div class="artifact-actions">
          <el-button size="small" text @click="openFile(a)">打开</el-button>
          <el-button size="small" text @click="showInFolder(a)">所在文件夹</el-button>
        </div>
      </div>
    </div>
    <div v-if="error" class="artifact-error" data-testid="artifact-error">{{ error }}</div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import type { ProducedArtifact } from '@/types/electron-api'

const props = defineProps<{ artifacts: ProducedArtifact[] }>()

const error = ref('')

function kindLabel(kind: ProducedArtifact['kind']): string {
  if (kind === 'document') return '文档'
  if (kind === 'spreadsheet') return '表格'
  if (kind === 'presentation') return '演示'
  return '文件'
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

async function openFile(a: ProducedArtifact): Promise<void> {
  error.value = ''
  try {
    const res = await window.electronAPI.file.open(a.path)
    if (!res?.success) error.value = res?.error || '打开文件失败'
  } catch (e) {
    error.value = e instanceof Error ? e.message : '打开文件失败'
  }
}

async function showInFolder(a: ProducedArtifact): Promise<void> {
  error.value = ''
  try {
    const res = await window.electronAPI.file.showInFolder(a.path)
    if (!res?.success) error.value = res?.error || '定位文件失败'
  } catch (e) {
    error.value = e instanceof Error ? e.message : '定位文件失败'
  }
}
</script>

<style scoped>
.artifact-panel {
  margin: 6px 0;
  padding: 8px 12px;
  border: 1px solid var(--border-base, #e4e7ed);
  border-radius: 10px;
  background: var(--bg-secondary, transparent);
}

.artifact-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 6px;
}

.artifact-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--fg-primary, #303133);
}

.artifact-count {
  font-size: 11px;
  color: var(--fg-tertiary, #909399);
}

.artifact-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.artifact-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  border-top: 1px solid var(--border-light, transparent);
}

.artifact-kind {
  flex: none;
  padding: 1px 6px;
  border-radius: 6px;
  font-size: 10px;
  background: var(--accent-soft, rgba(124, 141, 181, 0.14));
  color: var(--accent-base, #7c8db5);
}

.artifact-body {
  flex: 1;
  min-width: 0;
}

.artifact-name {
  font-size: 12px;
  color: var(--fg-primary, #303133);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.artifact-meta {
  font-size: 10px;
  color: var(--fg-tertiary, #909399);
}

.artifact-actions {
  flex: none;
}

.artifact-error {
  margin-top: 4px;
  font-size: 11px;
  color: var(--danger-base, #f56c6c);
}
</style>
