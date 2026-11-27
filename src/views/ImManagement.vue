<template>
  <div class="im-management" :class="{ 'is-embedded': embedded }">
    <header v-if="!embedded" class="page-header">
      <h1>IM 管理</h1>
      <p class="subtitle">配置 / 监控 / 消息 / 规则 — 一站式管理所有 IM 通道</p>
    </header>

    <el-tabs v-model="activeTab" class="im-tabs">
      <!-- Tab 1: 配置面板(P0-01) -->
      <el-tab-pane label="通道配置" name="config">
        <div class="config-header">
          <el-button type="primary" @click="openAddDialog">
            <el-icon><Plus /></el-icon>添加通道
          </el-button>
          <span class="config-meta">共 {{ channels.length }} 个通道 · 已启用 {{ enabledCount }}</span>
        </div>

        <div v-if="initialLoading" class="channel-grid">
          <Skeleton v-for="i in 6" :key="`skel-${i}`" type="card" />
        </div>

        <div v-else-if="channels.length === 0" class="empty-state">
          <!-- 视觉打磨: 空态给可操作主按钮, 不必让用户回到页首找入口 -->
          <el-empty description="还没有配置任何 IM 通道，接入后即可在应用内收发消息">
            <el-button type="primary" @click="openAddDialog">
              <el-icon><Plus /></el-icon>添加通道
            </el-button>
          </el-empty>
        </div>

        <div v-else class="channel-grid">
          <div
            v-for="ch in channels"
            :key="ch.kind"
            class="channel-card"
            :class="{ 'is-disabled': !ch.enabled, 'is-error': ch.testError }"
          >
            <div class="card-status" :class="ch.enabled ? 'on' : 'off'">
              {{ ch.enabled ? '● 在线' : '○ 离线' }}
            </div>
            <div class="card-icon">
              <el-icon :size="22"><component :is="channelIcon(ch.kind)" /></el-icon>
            </div>
            <div class="card-name">{{ ch.displayName }}</div>
            <div class="card-kind">{{ ch.kind }}</div>
            <div class="card-summary">
              <span :class="{ muted: !configSummary(ch) }">{{ configSummary(ch) || '未配置' }}</span>
            </div>
            <div v-if="ch.testError" class="card-error">
              <el-icon :size="14"><Warning /></el-icon> {{ ch.testError }}
            </div>
            <div class="card-actions">
              <el-button size="small" @click="openEditDialog(ch)">编辑</el-button>
              <el-button size="small" type="success" @click="handleTestChannel(ch)" :loading="testing === ch.kind">
                测试
              </el-button>
              <el-button size="small" type="danger" @click="handleDelete(ch)">删除</el-button>
            </div>
          </div>
        </div>
      </el-tab-pane>

      <!-- Tab 2: 状态仪表板(P0-02) -->
      <el-tab-pane label="状态仪表板" name="status">
        <div class="status-summary">
          <el-statistic title="在线" :value="statusSummary.online" />
          <el-statistic title="离线" :value="statusSummary.offline" />
          <el-statistic title="未启用" :value="statusSummary.disabled" />
          <el-statistic title="今日消息" :value="statusSummary.todayMessages" />
        </div>
        <div class="status-list">
          <div class="status-list-head">
            <h3>通道状态</h3>
            <el-button size="small" :loading="healthLoading" @click="refreshHealth">刷新健康检查</el-button>
          </div>
          <el-table :data="channels" stripe empty-text="暂无数据">
            <el-table-column label="通道" prop="displayName" />
            <el-table-column label="状态" width="100">
              <template #default="scope">
                <el-tag :type="scope.row.enabled ? 'success' : 'info'" size="small">
                  {{ scope.row.enabled ? '已启用' : '未启用' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="健康" width="140">
              <template #default="scope">
                <el-tag v-if="scope.row.healthy === true" type="success" size="small">健康</el-tag>
                <el-tag v-else-if="scope.row.healthy === false" type="danger" size="small">
                  {{ scope.row.healthError || '异常' }}
                </el-tag>
                <span v-else>—</span>
              </template>
            </el-table-column>
            <el-table-column label="最后测试" prop="lastTested" />
            <el-table-column label="更新于" prop="updatedAt" />
          </el-table>
        </div>
      </el-tab-pane>

      <!-- Tab 3: 消息查看器(P0-03) -->
      <el-tab-pane label="消息查看器" name="messages">
        <div class="message-filters">
          <el-select v-model="messageFilter.channel" placeholder="通道" clearable>
            <el-option v-for="ch in channels" :key="ch.kind" :label="ch.displayName" :value="ch.kind" />
          </el-select>
          <el-input v-model="messageFilter.keyword" placeholder="搜索关键词" clearable />
          <el-button @click="reloadMessages">刷新</el-button>
          <el-button @click="clearMessageSelection" :disabled="!selectedMessage">取消选择</el-button>
        </div>
        <el-table
          :data="filteredMessages"
          stripe
          max-height="500"
          @row-click="selectMessageForReply"
          :row-class-name="messageRowClass"
        >
          <el-table-column label="时间" prop="timestamp" width="180" />
          <el-table-column label="通道" prop="channel" width="120" />
          <el-table-column label="发送方" prop="sender" width="120" />
          <el-table-column label="内容" prop="content" show-overflow-tooltip />
          <el-table-column label="方向" width="80">
            <template #default="scope">
              <el-tag :type="scope.row.direction === 'in' ? 'success' : 'primary'" size="small">
                {{ scope.row.direction === 'in' ? '入站' : '出站' }}
              </el-tag>
            </template>
          </el-table-column>
        </el-table>
        <div class="message-pagination">
          <el-pagination
            v-model:current-page="messagePage"
            :page-size="50"
            :total="filteredMessages.length"
            layout="total, prev, pager, next"
          />
        </div>

        <!-- 快速回复面板 (P2-01) -->
        <div class="quick-reply-panel" v-if="selectedMessage">
          <h3>快速回复</h3>
          <div class="reply-target">
            <el-tag size="small" type="info">{{ selectedMessage.channel }}</el-tag>
            <span class="reply-from">来自: <strong>{{ selectedMessage.sender }}</strong></span>
            <span class="reply-content">内容: {{ selectedMessage.content }}</span>
          </div>
          <div class="reply-templates">
            <span class="reply-templates-label">模板:</span>
            <el-tag
              v-for="tpl in QUICK_REPLY_TEMPLATES"
              :key="tpl"
              class="reply-template-tag"
              @click="applyTemplate(tpl)"
              :effect="replyText === tpl ? 'dark' : 'plain'"
            >
              {{ tpl }}
            </el-tag>
          </div>
          <div class="reply-input">
            <el-input
              v-model="replyText"
              type="textarea"
              :rows="3"
              placeholder="输入回复内容,或点击上方模板"
            />
            <div class="reply-actions">
              <el-button @click="clearMessageSelection">取消</el-button>
              <el-button type="primary" :loading="replySending" :disabled="!replyText.trim()" @click="sendQuickReply">
                发送回复
              </el-button>
            </div>
          </div>
        </div>
      </el-tab-pane>

      <!-- Tab 4: 路由规则(P0-04) -->
      <el-tab-pane label="路由规则" name="rules">
        <div class="rules-header">
          <el-button type="primary" @click="openRuleDialog()">+ 新建规则</el-button>
          <span class="rules-meta">共 {{ routingRules.length }} 条规则</span>
        </div>
        <el-table :data="routingRules" stripe empty-text="暂无数据">
          <el-table-column label="优先级" prop="priority" width="80" sortable />
          <el-table-column label="触发词" prop="trigger" />
          <el-table-column label="目标通道" prop="targetChannel" width="120" />
          <el-table-column label="启用" width="80">
            <template #default="scope">
              <el-switch v-model="scope.row.enabled" @change="syncRule(scope.row)" />
            </template>
          </el-table-column>
          <el-table-column label="操作" width="180">
            <template #default="scope">
              <el-button size="small" @click="openRuleDialog(scope.row)">编辑</el-button>
              <el-button size="small" type="danger" @click="deleteRule(scope.row)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>

      <!-- Tab 5: 权限管理(P0-05) -->
      <el-tab-pane label="权限管理" name="permissions">
        <div class="permissions-header">
          <el-button type="primary" @click="openPermissionDialog()">+ 添加用户</el-button>
        </div>
        <el-table :data="permissions" stripe empty-text="暂无数据">
          <el-table-column label="用户/群组" prop="subject" />
          <el-table-column label="级别" width="100">
            <template #default="scope">
              <el-tag :type="scope.row.level === 'admin' ? 'danger' : scope.row.level === 'member' ? 'warning' : 'success'" size="small">
                {{ scope.row.level }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="作用范围" prop="scope" />
          <el-table-column label="操作" width="120">
            <template #default="scope">
              <el-button size="small" type="danger" @click="deletePermission(scope.row)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>
    </el-tabs>

    <!-- 添加 / 编辑通道 弹窗 -->
    <el-dialog v-model="dialogVisible" :title="editingChannel ? '编辑通道' : '添加通道'" width="600px">
      <el-form :model="formData" label-width="120px">
        <el-form-item label="平台类型" required>
          <el-select v-model="formData.kind" :disabled="!!editingChannel" placeholder="选择 IM 平台">
            <el-option v-for="opt in availableKinds" :key="opt.value" :label="opt.label" :value="opt.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="显示名称" required>
          <el-input v-model="formData.displayName" placeholder="例:产品群飞书 Bot" />
        </el-form-item>

        <!-- 飞书 / Lark 字段 -->
        <template v-if="formData.kind === 'im-feishu' || formData.kind === 'im-lark'">
          <el-form-item label="App ID"><el-input v-model="formData.appId" placeholder="cli_xxx" /></el-form-item>
          <el-form-item label="App Secret"><el-input v-model="formData.appSecret" type="password" show-password /></el-form-item>
          <el-form-item v-if="formData.kind === 'im-lark'" label="API Base URL">
            <el-input v-model="formData.apiBaseUrl" placeholder="https://open.larksuite.com（可选）" />
          </el-form-item>
        </template>

        <!-- 钉钉字段：appKey / appSecret 已被通道按平台原名字段读取 -->
        <template v-if="formData.kind === 'im-dingtalk'">
          <el-form-item label="App Key"><el-input v-model="formData.appKey" /></el-form-item>
          <el-form-item label="App Secret"><el-input v-model="formData.appSecret" type="password" show-password /></el-form-item>
          <el-form-item label="Webhook URL">
            <el-input v-model="formData.webhookUrl" placeholder="https://oapi.dingtalk.com/robot/send?access_token=xxx（可选）" />
          </el-form-item>
        </template>

        <!-- 企微字段：corpId / corpSecret / agentId 分别落盘、分别被读取 -->
        <template v-if="formData.kind === 'im-wechat-work'">
          <el-form-item label="Corp ID"><el-input v-model="formData.corpId" placeholder="wwxxx" /></el-form-item>
          <el-form-item label="Corp Secret"><el-input v-model="formData.corpSecret" type="password" show-password /></el-form-item>
          <el-form-item label="Agent ID"><el-input v-model="formData.agentId" placeholder="1000002" /></el-form-item>
        </template>

        <!-- 微信个人号字段 -->
        <template v-if="formData.kind === 'im-wechat'">
          <el-form-item label="App ID / WxID"><el-input v-model="formData.appId" /></el-form-item>
          <el-form-item label="App Secret"><el-input v-model="formData.appSecret" type="password" show-password /></el-form-item>
        </template>

        <!-- QQ 字段（通道读 appId + appSecret，不再是 botToken） -->
        <template v-if="formData.kind === 'im-qq'">
          <el-form-item label="App ID"><el-input v-model="formData.appId" /></el-form-item>
          <el-form-item label="App Secret"><el-input v-model="formData.appSecret" type="password" show-password /></el-form-item>
        </template>

        <!-- Telegram：apiBaseUrl 可指向自托管 / 本机 mock server，入站长轮询同样生效 -->
        <template v-if="formData.kind === 'im-telegram'">
          <el-form-item label="Bot Token">
            <el-input v-model="formData.botToken" type="password" show-password placeholder="123456:ABC-DEF..." />
          </el-form-item>
          <el-form-item label="API Base URL">
            <el-input v-model="formData.apiBaseUrl" placeholder="https://api.telegram.org（自托管 / 本机 mock 可填）" />
          </el-form-item>
        </template>

        <!-- Discord 字段 -->
        <template v-if="formData.kind === 'im-discord'">
          <el-form-item label="Bot Token">
            <el-input v-model="formData.botToken" type="password" show-password />
          </el-form-item>
        </template>

        <!-- Rocket.Chat：通道需要 apiBaseUrl + appId(X-User-Id) + botToken(X-Auth-Token) -->
        <template v-if="formData.kind === 'im-rocket'">
          <el-form-item label="Server URL"><el-input v-model="formData.apiBaseUrl" placeholder="https://chat.example.com" /></el-form-item>
          <el-form-item label="User ID"><el-input v-model="formData.appId" placeholder="X-User-Id" /></el-form-item>
          <el-form-item label="Auth Token"><el-input v-model="formData.botToken" type="password" show-password placeholder="X-Auth-Token" /></el-form-item>
        </template>

        <!-- Slack 字段 -->
        <template v-if="formData.kind === 'im-slack'">
          <el-form-item label="Bot Token">
            <el-input v-model="formData.botToken" type="password" show-password placeholder="xoxb-..." />
          </el-form-item>
          <el-form-item label="Signing Secret">
            <el-input v-model="formData.signingSecret" type="password" show-password />
          </el-form-item>
        </template>

        <!-- WhatsApp 字段 -->
        <template v-if="formData.kind === 'im-whatsapp'">
          <el-form-item label="Phone Number ID"><el-input v-model="formData.phoneNumberId" /></el-form-item>
          <el-form-item label="Access Token">
            <el-input v-model="formData.botToken" type="password" show-password />
          </el-form-item>
        </template>

        <el-form-item label="启用">
          <el-switch v-model="formData.enabled" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button @click="handleTestInDialog" :loading="testing === formData.kind">测试连接</el-button>
        <el-button type="primary" @click="handleSave" :loading="saving">保存</el-button>
      </template>
    </el-dialog>

    <!-- 路由规则 弹窗 -->
    <el-dialog v-model="ruleDialogVisible" :title="editingRule ? '编辑规则' : '新建规则'" width="500px">
      <el-form :model="ruleForm" label-width="100px">
        <el-form-item label="优先级"><el-input-number v-model="ruleForm.priority" :min="1" :max="100" /></el-form-item>
        <el-form-item label="触发词"><el-input v-model="ruleForm.trigger" placeholder="如:日程|schedule" /></el-form-item>
        <el-form-item label="目标通道">
          <el-select v-model="ruleForm.targetChannel">
            <el-option v-for="ch in channels" :key="ch.kind" :label="ch.displayName" :value="ch.kind" />
          </el-select>
        </el-form-item>
        <el-form-item label="目标接收者"><el-input v-model="ruleForm.targetUserId" placeholder="userId / chatId" /></el-form-item>
        <el-form-item label="启用"><el-switch v-model="ruleForm.enabled" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="ruleDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="handleSaveRule">保存</el-button>
      </template>
    </el-dialog>

    <!-- 权限 弹窗 -->
    <el-dialog v-model="permissionDialogVisible" title="添加权限" width="500px">
      <el-form :model="permissionForm" label-width="100px">
        <el-form-item label="用户/群组"><el-input v-model="permissionForm.subject" placeholder="用户名 / 群组名" /></el-form-item>
        <el-form-item label="权限级别">
          <el-select v-model="permissionForm.level">
            <el-option label="Admin(管理员)" value="admin" />
            <el-option label="Member(成员)" value="member" />
            <el-option label="Readonly(只读)" value="readonly" />
          </el-select>
        </el-form-item>
        <el-form-item label="作用范围">
          <el-select v-model="permissionForm.scope" multiple>
            <el-option v-for="ch in channels" :key="ch.kind" :label="ch.displayName" :value="ch.kind" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="permissionDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="handleSavePermission">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue'
import { ElMessage } from "element-plus/es/components/message/index"
import { ElMessageBox } from "element-plus/es/components/message-box/index"
import { Plus, Warning } from '@element-plus/icons-vue'
import Skeleton from '@/components/common/Skeleton.vue'

/**
 * v4.9：内嵌进「设置 → 配置中心」右侧面板时传 embedded=true，
 * 隐藏自带页头（避免与设置页标题重复），并让外层滚动接管。
 */
defineProps<{ embedded?: boolean }>()

interface ChannelInfo {
  kind: string
  displayName: string
  enabled: boolean
  config?: Record<string, any>
  testError?: string
  healthy?: boolean
  healthError?: string
  lastTested?: string
  updatedAt?: string
}

const activeTab = ref('config')
const initialLoading = ref(true) // P5-UX: 初次加载时显示 Skeleton

// 11 个支持的平台 + 元信息
const ALL_KINDS: Array<{ value: string; label: string; icon: string }> = [
  { value: 'im-feishu', label: '飞书 / Lark', icon: 'ChatDotRound' },
  { value: 'im-dingtalk', label: '钉钉', icon: 'Promotion' },
  { value: 'im-wechat-work', label: '企业微信', icon: 'OfficeBuilding' },
  { value: 'im-wechat', label: '微信个人号', icon: 'ChatDotRound' },
  { value: 'im-qq', label: 'QQ 机器人', icon: 'ChatDotRound' },
  { value: 'im-telegram', label: 'Telegram', icon: 'Promotion' },
  { value: 'im-slack', label: 'Slack', icon: 'ChatDotRound' },
  { value: 'im-discord', label: 'Discord', icon: 'ChatDotRound' },
  { value: 'im-whatsapp', label: 'WhatsApp', icon: 'ChatDotRound' },
  { value: 'im-lark', label: 'Lark(海外飞书)', icon: 'Connection' },
  { value: 'im-rocket', label: 'Rocket.Chat', icon: 'Promotion' },
]

const availableKinds = computed(() => {
  const used = new Set(channels.value.map((c) => c.kind))
  return ALL_KINDS.filter((k) => !used.has(k.value) || (editingChannel.value && k.value === editingChannel.value.kind))
})

const channels = ref<ChannelInfo[]>([])
const enabledCount = computed(() => channels.value.filter((c) => c.enabled).length)

const statusSummary = computed(() => {
  const enabled = channels.value.filter((c) => c.enabled)
  return {
    online: enabled.filter((c) => !c.testError).length,
    offline: enabled.filter((c) => !!c.testError).length,
    disabled: channels.value.filter((c) => !c.enabled).length,
    todayMessages: messageStats.total,
  }
})

const testing = ref<string | null>(null)
const saving = ref(false)
const dialogVisible = ref(false)
const editingChannel = ref<ChannelInfo | null>(null)
const formData = reactive<Record<string, any>>({})

// P0-04 路由规则
const routingRules = ref<any[]>([])
const ruleDialogVisible = ref(false)
const editingRule = ref<any | null>(null)
const ruleForm = reactive({ priority: 50, trigger: '', targetChannel: '', targetUserId: '', enabled: true })

// P0-05 权限
const permissions = ref<any[]>([])
const permissionDialogVisible = ref(false)
const permissionForm = reactive({ subject: '', level: 'member', scope: [] })

// P2-01 快速回复
const QUICK_REPLY_TEMPLATES = [
  '好的,稍等',
  '已完成',
  '需要更多信息,请补充',
  '已收到,谢谢',
  '已转交相关同事处理',
  '抱歉,这个问题我帮不了',
]
const selectedMessage = ref<any | null>(null)
const replyText = ref('')
const replySending = ref(false)

function selectMessageForReply(row: any): void {
  selectedMessage.value = row
  replyText.value = ''
}

function clearMessageSelection(): void {
  selectedMessage.value = null
  replyText.value = ''
}

function applyTemplate(tpl: string): void {
  replyText.value = tpl
}

function messageRowClass(scope: { row?: any }): string {
  // B2-Bugfix: el-table 空状态可能传 undefined scope, 防御性处理
  if (!scope || !scope.row) return ''
  return selectedMessage.value && selectedMessage.value.id === scope.row.id ? 'message-row-selected' : ''
}

async function sendQuickReply(): Promise<void> {
  if (!selectedMessage.value || !replyText.value.trim()) return
  replySending.value = true
  try {
    const m = selectedMessage.value
    const r = await (window as any).electronAPI.channel.send({
      channelId: m.channelId || m.channel,
      // 回复目标是原会话 chat_id(to)，不是发送者 —— 此前误用 sender 导致回复发错人
      to: m.to || m.sender,
      text: replyText.value.trim(),
      replyToId: m.id,
    })
    if (r?.success) {
      ElMessage.success('已发送回复')
      clearMessageSelection()
    } else {
      ElMessage.error('发送失败: ' + (r?.error || '未知错误'))
    }
  } catch (e) {
    ElMessage.error('发送失败: ' + String(e))
  } finally {
    replySending.value = false
  }
}

async function loadRoutingRules(): Promise<void> {
  try {
    const result = await (window as any).electronAPI.channel.routingList()
    if (result?.success) routingRules.value = result.data || []
  } catch (e) {
    console.warn('loadRoutingRules failed', e)
  }
}

async function loadPermissions(): Promise<void> {
  try {
    const result = await (window as any).electronAPI.channel.permissionList()
    if (result?.success) permissions.value = result.data || []
  } catch (e) {
    console.warn('loadPermissions failed', e)
  }
}

// IM 真连通：状态页「健康」列取 channel:list 的真实健康检查结果，不再恒绿
const healthLoading = ref(false)
async function refreshHealth(): Promise<void> {
  healthLoading.value = true
  try {
    const result = await (window as any).electronAPI.channel.list()
    const rows: any[] = result?.success && Array.isArray(result.data) ? result.data : []
    const byKind = new Map(rows.map((r) => [r.kind, r]))
    channels.value = channels.value.map((ch) => {
      const h: any = byKind.get(ch.kind)
      if (!h) return { ...ch, healthy: undefined, healthError: undefined }
      return {
        ...ch,
        healthy: h.healthy,
        healthError: h.healthError,
        testError: h.healthy ? undefined : (h.healthError || 'unhealthy'),
        lastTested: new Date().toLocaleString(),
      }
    })
  } catch (e) {
    ElMessage.error('健康检查失败:' + String(e))
  } finally {
    healthLoading.value = false
  }
}

/** 路由规则启用开关 → 真同步到 IMMessageRouter（addRule 现在是 upsert） */
function syncRule(rule: any): void {
  ;(window as any).electronAPI.channel.routingAdd({ ...rule }).catch((e: any) => {
    console.warn('routingAdd(sync) failed', e)
  })
}

// P0-03 消息
const messageFilter = reactive({ channel: '', keyword: '' })
const allMessages = ref<any[]>([])
const messageStats = reactive({ total: 0, byChannel: {} as Record<string, { in: number; out: number; total: number }>, sinceMs: 0 })
const messagePage = ref(1)
const filteredMessages = computed(() => {
  let list = allMessages.value
  if (messageFilter.channel) list = list.filter((m) => m.channelId === messageFilter.channel)
  if (messageFilter.keyword) {
    const kw = messageFilter.keyword.toLowerCase()
    list = list.filter((m) => {
      const text = (m.message?.text || m.content || '').toLowerCase()
      return text.includes(kw)
    })
  }
  return list
})

function channelIcon(kind: string): string {
  return ALL_KINDS.find((k) => k.value === kind)?.icon ?? 'Connection'
}

/** 各平台字段名不同，按优先级挑一个可展示的凭据摘要（只显示前缀，不暴露密钥） */
function configSummary(ch: ChannelInfo): string {
  const c = ch.config || {}
  const id = c.appId || c.appKey || c.corpId || c.phoneNumberId
  if (id) return `ID: ${String(id).slice(0, 8)}…`
  if (c.botToken) return `Token: ${String(c.botToken).slice(0, 6)}…`
  if (c.apiBaseUrl) return `Server: ${String(c.apiBaseUrl).slice(0, 24)}…`
  return ''
}

async function loadChannels(): Promise<void> {
  try {
    const result = await (window as any).electronAPI.channelConfig.get()
    const configs: any[] = result && result.success && Array.isArray(result.data) ? result.data : []
    channels.value = configs.map((c) => ({
      kind: c.channelKind || c.kind,
      displayName: ALL_KINDS.find((k) => k.value === (c.channelKind || c.kind))?.label || c.channelKind,
      enabled: c.enabled ?? false,
      config: c,
      updatedAt: c.updatedAt ? new Date(c.updatedAt).toLocaleString() : '—',
      lastTested: '—',
    }))
  } catch (e) {
    console.warn('loadChannels failed', e)
  }
}

function openAddDialog(): void {
  editingChannel.value = null
  Object.keys(formData).forEach((k) => delete formData[k])
  dialogVisible.value = true
}

function openEditDialog(ch: ChannelInfo): void {
  editingChannel.value = ch
  Object.keys(formData).forEach((k) => delete formData[k])
  Object.assign(formData, ch.config || {}, { kind: ch.kind, displayName: ch.displayName, enabled: ch.enabled })
  dialogVisible.value = true
}

async function handleSave(): Promise<void> {
  if (!formData.kind || !formData.displayName) {
    ElMessage.warning('请填写平台类型和显示名称')
    return
  }
  saving.value = true
  try {
    const cfg = { ...formData }
    delete cfg.kind
    delete cfg.displayName
    const result = await (window as any).electronAPI.channelConfig.save({
      platform: formData.kind,
      config: cfg,
    })
    if (result?.success) {
      ElMessage.success('保存成功')
      dialogVisible.value = false
      await loadChannels()
    } else {
      ElMessage.error(result?.error || '保存失败')
    }
  } catch (e) {
    ElMessage.error('保存失败:' + String(e))
  } finally {
    saving.value = false
  }
}

async function handleTestInDialog(): Promise<void> {
  if (!formData.kind) {
    ElMessage.warning('请先选择平台')
    return
  }
  testing.value = formData.kind
  try {
    const cfg = { ...formData }
    delete cfg.kind
    delete cfg.displayName
    const result = await (window as any).electronAPI.channelConfig.test({ platform: formData.kind, config: cfg })
    // handler 返回顶层 { success, message }，此前只读 result.data?.message → 永远空
    if (result?.success) {
      ElMessage.success('连接成功:' + (result.message || result.data?.message || ''))
    } else {
      ElMessage.error('连接失败:' + (result.message || result.error || result.data?.message || ''))
    }
  } catch (e) {
    ElMessage.error('连接失败:' + String(e))
  } finally {
    testing.value = null
  }
}

async function handleTestChannel(ch: ChannelInfo): Promise<void> {
  testing.value = ch.kind
  try {
    const result = await (window as any).electronAPI.channelConfig.test({ platform: ch.kind, config: ch.config || {} })
    ch.testError = result?.success ? undefined : (result?.message || result?.error || 'unknown')
    ch.lastTested = new Date().toLocaleString()
  } catch (e) {
    ch.testError = String(e)
  } finally {
    testing.value = null
  }
}

async function handleDelete(ch: ChannelInfo): Promise<void> {
  try {
    await ElMessageBox.confirm(`确定删除通道"${ch.displayName}"?`, '确认', { type: 'warning' })
  } catch {
    return
  }
  // 真删除：IMConfigStore.remove + 热重载，不再是把 enabled 置 false 的假操作
  const result = await (window as any).electronAPI.channelConfig.delete({ platform: ch.kind })
  if (result?.success) {
    ElMessage.success('已删除')
  } else {
    ElMessage.error('删除失败:' + (result?.error || '未知错误'))
  }
  await loadChannels()
}

// P0-04 路由规则
function openRuleDialog(rule?: any): void {
  editingRule.value = rule || null
  Object.assign(ruleForm, { priority: 50, trigger: '', targetChannel: '', targetUserId: '', enabled: true })
  if (rule) Object.assign(ruleForm, rule)
  ruleDialogVisible.value = true
}

function handleSaveRule(): void {
  if (!ruleForm.trigger || !ruleForm.targetChannel) {
    ElMessage.warning('触发词和目标通道必填')
    return
  }
  const rule = {
    id: editingRule.value?.id ?? `rule-${Date.now()}`,
    ...ruleForm,
  }
  if (editingRule.value) {
    Object.assign(editingRule.value, rule)
  } else {
    routingRules.value.push(rule)
  }
  // 真接 IMMessageRouter
  ;(window as any).electronAPI.channel.routingAdd(rule).catch((e: any) => {
    console.warn('routingAdd failed', e)
  })
  ruleDialogVisible.value = false
  ElMessage.success('规则已保存')
}

async function deleteRule(rule: any): Promise<void> {
  routingRules.value = routingRules.value.filter((r) => r.id !== rule.id)
  try {
    await (window as any).electronAPI.channel.routingRemove(rule.id)
  } catch (e) {
    console.warn('routingRemove failed', e)
  }
}

// P0-05 权限
function openPermissionDialog(): void {
  Object.assign(permissionForm, { subject: '', level: 'member', scope: [] })
  permissionDialogVisible.value = true
}

async function handleSavePermission(): Promise<void> {
  if (!permissionForm.subject) {
    ElMessage.warning('用户/群组必填')
    return
  }
  const scopes: string[] = permissionForm.scope || []
  if (scopes.length === 0) {
    ElMessage.warning('请至少选择一个作用范围通道')
    return
  }
  try {
    // 真授权：直接写 IMPermissionManager 白名单，入站判定立即生效
    for (const channelKind of scopes) {
      await (window as any).electronAPI.channel.permissionGrant({
        channelKind,
        userId: permissionForm.subject,
      })
    }
    await loadPermissions()
    permissionDialogVisible.value = false
    ElMessage.success('权限已添加')
  } catch (e) {
    ElMessage.error('权限添加失败:' + String(e))
  }
}

async function deletePermission(p: any): Promise<void> {
  const channelKind = Array.isArray(p.scope) ? p.scope[0] : p.scope
  if (!channelKind) {
    permissions.value = permissions.value.filter((x) => x.id !== p.id)
    return
  }
  try {
    await (window as any).electronAPI.channel.permissionRevoke({ channelKind, userId: p.subject })
    await loadPermissions()
  } catch (e) {
    ElMessage.error('权限删除失败:' + String(e))
  }
}

// P0-03 消息
async function reloadMessages(): Promise<void> {
  try {
    const opts: { channelId?: string; limit?: number } = { limit: 200 }
    if (messageFilter.channel) opts.channelId = messageFilter.channel
    const result = await (window as any).electronAPI.channel.messageHistory(opts)
    const rows: any[] = result?.success && Array.isArray(result.data) ? result.data : []
    // StoredMessage → UI 行：此前表格列用 timestamp/channel/sender/content，
    // 而后端返回 { ts, channelId, message:{to,from,text} } —— 四列全空。
    allMessages.value = rows.map((m) => {
      const body = m.message || {}
      return {
        ...m,
        timestamp: new Date(m.ts || Date.now()).toLocaleString(),
        channel: m.channelId,
        sender: body.from || body.to || '—',
        content: body.text || body.subject || '',
        to: body.to,
        from: body.from,
        direction: m.direction || 'in',
      }
    })
  } catch (e) {
    console.warn('reloadMessages failed', e)
  }
}

async function loadMessageStats(): Promise<void> {
  try {
    const result = await (window as any).electronAPI.channel.messageStats()
    if (result?.success && result.data) {
      Object.assign(messageStats, result.data)
    }
  } catch (e) {
    console.warn('loadMessageStats failed', e)
  }
}

onMounted(async () => {
  await Promise.all([
    loadChannels(),
    loadMessageStats(),
    loadRoutingRules(),
    loadPermissions(),
    reloadMessages(),
  ])
  initialLoading.value = false
})
</script>

<style lang="scss" scoped>
.im-management {
  padding: var(--content-padding, 16px);
  max-width: 1200px;
  margin: 0 auto;
}
/* v4.9 内嵌态：设置页已提供留白与滚动容器，这里去掉外层内边距与宽度限制 */
.im-management.is-embedded {
  padding: 0;
  max-width: none;
  margin: 0;
}
.page-header {
  margin-bottom: 16px;
}
.config-header,
.status-summary,
.rules-header,
.permissions-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
}
.config-meta,
.rules-meta {
  color: var(--text-secondary, #999);
  font-size: 13px;
}
.channel-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 16px;
}
.channel-card {
  position: relative;
  background: var(--card-bg, #fff);
  border: 1px solid var(--border-color, #e4e7ed);
  border-radius: 8px;
  padding: 16px;
  transition: box-shadow 0.2s;
  &:hover {
    box-shadow: 0 2px 12px rgba(0, 0, 0, 0.1);
  }
  &.is-disabled {
    opacity: 0.6;
  }
  &.is-error {
    border-color: #f56c6c;
  }
  .card-status {
    position: absolute;
    top: 8px;
    right: 8px;
    font-size: 11px;
    &.on { color: #67c23a; }
    &.off { color: #909399; }
  }
  .card-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 44px;
    height: 44px;
    border-radius: 12px;
    background: var(--accent-soft);
    color: var(--accent-base);
    margin-bottom: 8px;
  }
  .card-name {
    font-weight: 600;
    font-size: 15px;
  }
  .card-kind {
    font-size: 11px;
    color: var(--text-secondary, #999);
    margin-bottom: 8px;
  }
  .card-summary {
    font-size: 12px;
    color: var(--text-secondary, #666);
    margin-bottom: 8px;
    .muted { color: #c0c4cc; font-style: italic; }
  }
  .card-error {
    font-size: 11px;
    color: #f56c6c;
    display: flex;
    align-items: center;
    gap: 4px;
    margin-bottom: 8px;
  }
  .card-actions {
    display: flex;
    gap: 4px;
  }
}
.status-summary {
  :deep(.el-statistic) {
    background: var(--card-bg, #f8f9fa);
    padding: 12px 16px;
    border-radius: 8px;
    flex: 1;
  }
}
.status-list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
  h3 { margin: 0; font-size: 15px; font-weight: 600; }
}
.message-filters {
  display: flex;
  gap: 12px;
  margin-bottom: 16px;
}
.message-pagination {
  margin-top: 16px;
  text-align: right;
}

/* P2-01 快速回复 */
.quick-reply-panel {
  margin-top: 20px;
  padding: 16px;
  background: var(--card-bg, #f8f9fa);
  border: 1px solid var(--border-color, #ebeef5);
  border-radius: 8px;
}
.quick-reply-panel h3 {
  margin: 0 0 12px;
  font-size: 15px;
  font-weight: 600;
}
.reply-target {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  font-size: 13px;
  color: var(--text-secondary, #666);
}
.reply-content {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.reply-templates {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 12px;
  align-items: center;
}
.reply-templates-label {
  font-size: 12px;
  color: var(--text-secondary, #999);
  margin-right: 4px;
}
.reply-template-tag {
  cursor: pointer;
  user-select: none;
}
.reply-input {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.reply-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
:deep(.message-row-selected) {
  background-color: var(--el-color-primary-light-9, rgba(124, 141, 181, 0.18)) !important;
}
.empty-state {
  padding: 40px;
  text-align: center;
}
</style>
