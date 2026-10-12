<template>
  <el-dialog
    v-model="visible"
    title="命令执行确认"
    width="520px"
    :close-on-click-modal="false"
    :close-on-press-escape="false"
    :show-close="true"
    destroy-on-close
  >
    <el-alert
      type="warning"
      :closable="false"
      show-icon
      title="以下命令需要人工审批"
      description="允许后立即执行,拒绝则终止本次操作。30 秒未操作将自动拒绝。"
      style="margin-bottom: 12px"
    />
    <div class="cmd-line">
      <span class="cmd-label">$</span>
      <code>{{ prettyCommand }}</code>
    </div>
    <div v-if="current?.cwd" class="cwd-line">
      <span class="cmd-label">cwd</span>
      <code>{{ current.cwd }}</code>
    </div>

    <template #footer>
      <el-button @click="respond(false)">拒绝</el-button>
      <el-button type="primary" @click="respond(true)">允许</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus/es/components/message/index'

interface ConfirmRequest {
  opId: string
  command: string
  args: string[]
  cwd?: string
}

/** 渲染端命令确认对话框 (v3 #5 弹窗, #002-v3 步骤 2.7)
 *  主进程经 BrowserWindow.webContents.send('command:confirm-request') 推送,
 *  本组件订阅 → 弹窗 → 用户按 允许/拒绝 → 主进程 ipcMain.on('command:confirm-reply') 收。
 *
 *  弹窗不关闭 (不自动 dismiss), 超时由主进程 30s 兜底拒, 回执后主进程 pending.resolve(false) 释放。
 */
const visible = ref(false)
const current = ref<ConfirmRequest | null>(null)
let unsubscribe: (() => void) | null = null
let responded = false

const prettyCommand = computed(() => {
  if (!current.value) return ''
  const base = current.value.command
  const args = (current.value.args ?? []).map((a) => (a.includes(' ') ? `"${a}"` : a))
  return [base, ...args].join(' ')
})

function respond(ok: boolean): void {
  if (responded) return
  responded = true
  try {
    const api = (window as any).electronAPI
    if (!api?.command?.replyConfirm) {
      throw new Error('electronAPI.command.replyConfirm 未注入')
    }
    api.command.replyConfirm(current.value!.opId, ok)
    ElMessage[ok ? 'success' : 'warning'](`已${ok ? '允许' : '拒绝'}此命令`)
  } catch (e: any) {
    ElMessage.error(`确认回执失败: ${e?.message ?? e}`)
    // 回执失败时重置 responded, 让用户可重按
    responded = false
  } finally {
    visible.value = false
    current.value = null
    // 下一请求来时需要能重新 respond
    setTimeout(() => { responded = false }, 0)
  }
}

onMounted(() => {
  const api = (window as any).electronAPI
  if (!api?.command?.onConfirmRequest) return
  unsubscribe = api.command.onConfirmRequest((req: ConfirmRequest) => {
    if (!req?.opId) return
    current.value = req
    visible.value = true
    responded = false
  })
})

onBeforeUnmount(() => {
  unsubscribe?.()
  unsubscribe = null
})
</script>

<style lang="scss" scoped>
.cmd-line, .cwd-line {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-bottom: 8px;
  font-family: Consolas, Menlo, monospace;
  font-size: 13px;
  code {
    white-space: pre-wrap;
    word-break: break-all;
    flex: 1;
  }
  .cmd-label {
    color: var(--muted-foreground, #888);
    font-weight: 600;
    min-width: 28px;
  }
}
</style>
