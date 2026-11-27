<!--
  ToolCallCard — agent 工具调用可视化 (M1-C)

  【为什么需要这个组件】
  审计发现: LlmAgentBrainEvents 定义了 10 种事件(含 tool_call / tool_result),
  但此前【零生产订阅者】 —— 全部 emit 进虚空。用户看到的是一个输入框,
  发一句话后不知道 agent 在读哪个文件、跑什么命令、调哪个 MCP 工具。

  对"AI 自动化助手"来说,执行过程可见性是唯一真正重要的事。
  这个组件把 agent 的工具调用变成可读、可展开的时间线。

  设计取舍:
    - 默认折叠:普通用户关心"结果是什么",不是"怎么做的"
    - 展开可见:参数 + 返回值 + 耗时,开发者能定位失败原因
    - 失败高亮:失败的工具调用必须显眼,不能混在一堆成功里
    - 参数截断:大对象(文件内容/长列表)只显示摘要 + 字节数,
      避免把整个 tool result 塞进 DOM
-->
<template>
  <div class="tool-trace">
    <button
      v-if="entries.length > 0"
      type="button"
      class="trace-toggle"
      :aria-expanded="expanded"
      :aria-label="expanded ? '折叠工具调用过程' : '展开工具调用过程'"
      @click="expanded = !expanded"
    >
      <el-icon class="trace-icon"><Tools /></el-icon>
      <span class="trace-label">
        {{ running > 0 ? '正在调用工具…' : '已调用工具' }}
      </span>
      <span class="trace-summary">
        {{ successCount }} 成功<template v-if="failCount > 0"> · {{ failCount }} 失败</template>
        · 共 {{ pairedEntries.length }} 次
      </span>
      <span class="trace-total" v-if="totalDurationMs > 0">
        · {{ formatDuration(totalDurationMs) }}
      </span>
      <el-icon class="trace-chevron">
        <ArrowUp v-if="expanded" /><ArrowDown v-else />
      </el-icon>
    </button>

    <div v-if="expanded" class="trace-body">
      <div
        v-for="(entry, idx) in pairedEntries"
        :key="`${entry.runId}-${entry.name}-${idx}`"
        class="trace-item"
        :class="entry.status"
      >
        <span class="trace-status-icon">
          <el-icon v-if="entry.status === 'ok'"><CircleCheck /></el-icon>
          <el-icon v-else-if="entry.status === 'failed'"><CircleClose /></el-icon>
          <el-icon v-else class="is-spin"><Loading /></el-icon>
        </span>

        <div class="trace-content">
          <div class="trace-head">
            <span class="trace-tool-name">{{ entry.name }}</span>
            <span v-if="entry.durationMs" class="trace-duration">
              {{ formatDuration(entry.durationMs) }}
            </span>
          </div>

          <details v-if="entry.args && Object.keys(entry.args).length > 0" class="trace-detail">
            <summary class="trace-detail-label">参数</summary>
            <pre class="trace-pre">{{ truncate(formatJson(entry.args)) }}</pre>
          </details>

          <details v-if="entry.error" class="trace-detail is-error" open>
            <summary class="trace-detail-label">错误</summary>
            <pre class="trace-pre is-error">{{ truncate(entry.error) }}</pre>
          </details>
        </div>
      </div>

      <p v-if="pairedEntries.length === 0" class="trace-empty">
        agent 正在思考,尚未调用工具。
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  Tools, ArrowDown, ArrowUp, CircleCheck, CircleClose, Loading,
} from '@element-plus/icons-vue'
import type { AgentTraceEntry } from '@/stores/chat'

const props = defineProps<{ entries: AgentTraceEntry[] }>()
const expanded = ref(false)

/** 工具调用按 name 配对 call/result —— 后端事件是先 call 后 result */
const pairedEntries = computed(() => {
  const byName = new Map<string, AgentTraceEntry[]>()
  for (const e of props.entries) {
    const key = `${e.runId}:${e.name}`
    if (!byName.has(key)) byName.set(key, [])
    byName.get(key)!.push(e)
  }
  const out: Array<AgentTraceEntry & { status: 'ok' | 'failed' | 'running' }> = []
  for (const [, list] of byName) {
    const call = list.find(e => e.type === 'tool_call')
    const result = list.find(e => e.type === 'tool_result')
    const base = call ?? result!
    out.push({
      ...base,
      status: result ? (result.ok ? 'ok' : 'failed') : 'running',
      durationMs: result?.durationMs,
      error: result?.error,
    })
  }
  return out
})

const successCount = computed(() => pairedEntries.value.filter(e => e.status === 'ok').length)
const failCount = computed(() => pairedEntries.value.filter(e => e.status === 'failed').length)
const running = computed(() => pairedEntries.value.filter(e => e.status === 'running').length)
const totalDurationMs = computed(() =>
  pairedEntries.value.reduce((sum, e) => sum + (e.durationMs ?? 0), 0),
)

function formatJson(v: unknown): string {
  try { return JSON.stringify(v, null, 2) } catch { return String(v) }
}

/** 大返回值不塞进 DOM —— 只给摘要和体积,详情可走 trace 查看器 */
function truncate(s: string, max = 800): string {
  if (s.length <= max) return s
  return `${s.slice(0, max)}\n… (共 ${s.length} 字符,已截断)`
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}
</script>

<style scoped>
.tool-trace {
  margin: 6px 0;
  border-left: 2px solid var(--border-base, #e4e7ed);
}

.trace-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  background: transparent;
  border: none;
  cursor: pointer;
  font-size: 12px;
  color: var(--fg-secondary, #909399);
  border-radius: 4px;
}
.trace-toggle:hover { background: var(--bg-hover, #f5f7fa); }
.trace-icon { font-size: 13px; }
.trace-summary, .trace-total { opacity: .75; }
.trace-chevron { font-size: 11px; }

.trace-body {
  margin-top: 4px;
  padding-left: 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.trace-item {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  font-size: 12px;
}
.trace-status-icon { flex: none; margin-top: 2px; }
.trace-item.ok .trace-status-icon { color: var(--el-color-success, #67c23a); }
.trace-item.failed .trace-status-icon { color: var(--el-color-danger, #f56c6c); }
.trace-item.running .trace-status-icon { color: var(--el-color-primary, #7c8db5); }

.is-spin { animation: nw-spin 1s linear infinite; }

.trace-content { flex: 1; min-width: 0; }
.trace-head { display: flex; align-items: baseline; gap: 8px; }
.trace-tool-name { font-family: var(--font-mono, monospace); font-weight: 600; }
.trace-duration { font-size: 11px; opacity: .6; }

.trace-detail { margin-top: 2px; }
.trace-detail-label {
  cursor: pointer;
  font-size: 11px;
  opacity: .7;
  user-select: none;
}
.trace-pre {
  margin: 4px 0 0;
  padding: 6px 8px;
  background: var(--bg-hover, #f5f7fa);
  border-radius: 4px;
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  line-height: 1.5;
  max-height: 260px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-all;
}
.trace-pre.is-error { color: var(--el-color-danger, #f56c6c); }

.trace-empty { font-size: 11px; opacity: .6; margin: 4px 0; }
</style>