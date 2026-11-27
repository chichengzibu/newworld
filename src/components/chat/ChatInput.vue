<template>
  <!-- 消息输入区 (P1-3c) -->
  <div class="input-area">
    <!-- 文件/图片预览 -->
    <FilePreview
      v-if="attachedFiles.length > 0"
      :files="attachedFiles"
      @remove="(idx: number) => emit('remove-attached', idx)"
      @clear="emit('clear-attached')"
    />

    <!-- 引用消息预览 -->
    <div v-if="quotedMessage" class="quoted-message-preview">
      <div class="quoted-header">
        <span class="quoted-label">引用: {{ quotedMessage.role === 'user' ? '你' : 'AI' }}</span>
        <el-button size="small" text @click="emit('clear-quoted')">
          <el-icon><Close /></el-icon>
        </el-button>
      </div>
      <div class="quoted-content">
        {{ quotedMessage.content.substring(0, 100) }}{{ quotedMessage.content.length > 100 ? '...' : '' }}
      </div>
    </div>

    <div
      class="input-row"
      @dragover.prevent="emit('drag-over', $event)"
      @drop.prevent="emit('drop', $event)"
      @paste="emit('paste', $event)"
    >
      <el-input
        v-model="inputMessageLocal"
        type="textarea"
        :rows="2"
        placeholder="输入消息... (Ctrl+K 命令 · Shift+Enter 换行，Enter 发送)"
        @keydown.enter.exact.prevent="handleSendClick"
        @keydown.enter.shift.exact="emit('shift-enter')"
      />
    </div>

    <!-- 工具栏: 左 = 附件+ / 供应商 / 模型 · 右 = 记忆 / 执行模式 / 圆形发送键
         (排版参考 DeepSeek harness 主页: 附件+ 与状态开关都在输入卡内一层, 不用另开菜单) -->
    <div class="input-toolbar">
      <!-- 点击式附件入口: 与拖拽/粘贴同一管线(processFiles), 之前只能靠拖拽发现不了 -->
      <el-button class="attach-btn" circle size="small" title="添加附件" @click="fileInput?.click()">
        <el-icon><Plus /></el-icon>
      </el-button>
      <!-- v4.8: 联网搜索是「给模型用的能力开关」——对齐 ChatGPT/Claude/WorkBuddy。
           开启后模型可在回答时自主调用 web_search；再不是让用户自己输关键词。 -->
      <el-button
        class="input-tool-btn"
        :class="{ 'is-active': webSearchEnabled }"
        circle
        size="small"
        :title="t('chat.webSearchToggle')"
        :aria-label="t('chat.webSearchToggle')"
        :aria-pressed="webSearchEnabled"
        data-path="/search"
        data-testid="web-search-toggle"
        @click="toggleWebSearch"
      >
        <el-icon><Search /></el-icon>
      </el-button>
      <!-- v4.7: 语音属于「我怎么输入」,在输入区工具条与主输入动作同层 -->
      <el-button
        v-for="tool in voiceTools"
        :key="tool.path"
        class="input-tool-btn"
        circle
        size="small"
        :title="t(tool.descKey)"
        :aria-label="t(tool.titleKey)"
        :data-path="tool.path"
        @click="goTool(tool.path)"
      >
        <el-icon><component :is="tool.icon" /></el-icon>
      </el-button>
      <input
        ref="fileInput"
        type="file"
        multiple
        style="display: none"
        @change="onPickFiles"
      />
      <el-select
        class="provider-pill"
        size="small"
        v-model="currentProviderId"
        placeholder="供应商"
        @change="emit('provider-change', currentProviderId)"
      >
        <!-- 【报错修复】无模型的 provider 不再整体禁用 — 之前用户点菜单看到的全是
             灰项却无任何解释, 像"菜单坏了"。选中后模型 pill 会如实显示"暂无可用模型",
             两 pill 分工本就是: 供应商随便选, 模型如实反映可用性 -->
        <el-option
          v-for="provider in enabledProviders"
          :key="provider.id"
          :label="provider.name"
          :value="provider.id"
        />
      </el-select>
      <el-select
        class="model-pill"
        size="small"
        :model-value="combinedModelKey"
        placeholder="选择模型"
        :disabled="!canSelectModel"
        @change="onModelPillChange"
      >
        <el-option
          v-if="!enabledProviders.some((p) => p.models.length > 0)"
          key="empty"
          label="暂无可用模型"
          value="none"
          disabled
        />
        <el-option-group v-for="p in enabledProviders" :key="p.id" :label="p.name">
          <el-option
            v-for="m in p.models"
            :key="p.id + '::' + m.id"
            :label="m.name"
            :value="p.id + '::' + m.id"
          />
        </el-option-group>
      </el-select>

      <div class="toolbar-spacer"></div>

      <!-- 记忆开关: 状态常驻可见(DeepSeek harness 的"记忆开"同款位置), 点一下切换 -->
      <button
        class="memory-pill"
        :class="{ 'is-on': hermes.memoryEnabled }"
        :title="hermes.memoryEnabled ? '记忆已启用 — 点击关闭' : '记忆未启用 — 点击开启'"
        @click="hermes.toggleMemoryEnabled()"
      >
        <span class="pill-dot" aria-hidden="true"></span>
        记忆
      </button>

      <!-- 【M1-E】执行模式常驻可见 —— 用户必须随时知道给 agent 多大权限 -->
      <ExecutionModeSwitch class="mode-switch-slot" />
      <el-button
        v-if="isGenerating"
        type="danger"
        class="send-btn"
        circle
        @click="emit('stop-generation')"
      >
        <el-icon><VideoPause /></el-icon>
      </el-button>
      <el-button
        v-else
        type="primary"
        class="send-btn"
        circle
        :disabled="!inputMessageLocal.trim() && attachedFiles.length === 0"
        @click="handleSendClick"
      >
        <el-icon><Promotion /></el-icon>
      </el-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted } from 'vue';
import { Promotion, VideoPause, Close, Plus, Search } from '@element-plus/icons-vue';
import { useI18n } from 'vue-i18n';
import { INPUT_TOOLS } from '@/components/layout/nav-config';
import FilePreview from './FilePreview.vue';
import ExecutionModeSwitch from './ExecutionModeSwitch.vue';
import { useHermesMemoryStore } from '@/stores/hermesMemory';
import type { ChatMessage } from '@/stores/chat';
import type { ProviderConfig, ModelInfo } from '@/stores/models';

interface AttachedFile {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  type: 'image' | 'document';
  url?: string;
  base64?: string;
  path?: string;
  content?: string;
}

const props = defineProps<{
  /** 当前 provider (v-model) */
  modelValueProvider: string | null;
  /** 当前 model (v-model) */
  modelValueModel: string | null;
  /** 输入框文字 (v-model) */
  modelValueInput: string;
  /** 已启用 provider 列表 */
  enabledProviders: ProviderConfig[];
  /** 当前 provider 可用模型 */
  currentModels: ModelInfo[];
  /** 是否能选模型 (默认 model 推断等) */
  canSelectModel: boolean;
  /** 附件文件列表 */
  attachedFiles: AttachedFile[];
  /** 是否正在生成 (控制"发送" vs "停止") */
  isGenerating: boolean;
  /** 引用消息 (显示引用预览条) */
  quotedMessage: ChatMessage | null;
}>();

const emit = defineEmits<{
  (e: 'update:modelValueProvider', v: string | null): void;
  (e: 'update:modelValueModel', v: string | null): void;
  (e: 'update:modelValueInput', v: string): void;
  (e: 'provider-change', v: string | null): void;
  (e: 'send', content: string): void;
  (e: 'shift-enter'): void;
  (e: 'stop-generation'): void;
  (e: 'drag-over', evt: DragEvent): void;
  (e: 'drop', evt: DragEvent): void;
  (e: 'paste', evt: ClipboardEvent): void;
  (e: 'remove-attached', idx: number): void;
  (e: 'clear-attached'): void;
  (e: 'clear-quoted'): void;
  /** 点击附件按钮选中的文件 — 交回父组件走与拖拽/粘贴相同的 processFiles 管线 */
  (e: 'files-picked', files: File[]): void;
}>();

// v-model 适配
const currentProviderId = computed({
  get: () => props.modelValueProvider,
  set: v => emit('update:modelValueProvider', v),
});
const currentModelId = computed({
  get: () => props.modelValueModel,
  set: v => emit('update:modelValueModel', v),
});
const inputMessageLocal = computed({
  get: () => props.modelValueInput,
  set: v => emit('update:modelValueInput', v),
});

const { t } = useI18n();

/** 语音是仍走独立页的输入能力；搜索已改为模型能力开关（下方 voiceTools） */
const voiceTools = computed(() => INPUT_TOOLS.filter((tool) => tool.path !== '/search'));

/** 联网搜索开关（v4.8）—— 状态存主进程 ConfigStore，跨会话持久化 */
const webSearchEnabled = ref(false);
const searchApi = () =>
  (window as unknown as { electronAPI?: { nova?: {
    searchGetSettings?: () => Promise<{ success: boolean; data?: { enabled: boolean } }>
    searchSetSettings?: (p: { enabled: boolean }) => Promise<{ success: boolean; data?: { enabled: boolean } }>
  } } }).electronAPI?.nova;

onMounted(async () => {
  try {
    const r = await searchApi()?.searchGetSettings?.();
    if (r?.success && r.data) webSearchEnabled.value = r.data.enabled === true;
  } catch { /* 无桥（单测/嵌入）时保持默认关闭 */ }
});

async function toggleWebSearch(): Promise<void> {
  const next = !webSearchEnabled.value;
  webSearchEnabled.value = next; // 乐观更新
  try {
    const r = await searchApi()?.searchSetSettings?.({ enabled: next });
    if (r?.success && r.data) webSearchEnabled.value = r.data.enabled === true;
  } catch {
    webSearchEnabled.value = !next; // 失败回滚
  }
}

/** 走 hash 而非 useRouter: ChatInput 是通用组件,不依赖 router 实例,
 *  单测与嵌入式场景都能渲染;vue-router 会监听 hashchange 完成跳转。 */
function goTool(path: string): void {
  window.location.hash = path;
}

function handleSendClick(): void {
  emit('send', inputMessageLocal.value);
}

/* ===== 附件点击入口 ===== */
const hermes = useHermesMemoryStore();
const fileInput = ref<HTMLInputElement | null>(null);

function onPickFiles(evt: Event): void {
  const input = evt.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  if (files.length > 0) emit('files-picked', files);
  input.value = ''; // 允许重复选择同一文件
}

/* ===== 合并模型选择器 (provider::model 复合键) ===== */
const combinedModelKey = computed(() =>
  props.modelValueProvider && props.modelValueModel
    ? `${props.modelValueProvider}::${props.modelValueModel}`
    : ''
);

function onModelPillChange(v: string | null | undefined): void {
  if (!v || v === 'none') return;
  const sep = v.indexOf('::');
  if (sep < 0) return;
  const pid = v.slice(0, sep);
  const mid = v.slice(sep + 2);
  // 跨提供商切换: 先让父组件跑 provider-change(清空/自动选默认), 再写入用户选的模型
  if (pid !== props.modelValueProvider) {
    emit('update:modelValueProvider', pid);
    emit('provider-change', pid);
  }
  currentModelId.value = mid;
}
</script>

<style lang="scss" scoped>
/* 【排版参考 WorkBuddy/DeepSeek】输入区 = 一张圆角卡片:
   无边框 textarea 在上, 工具栏(模型 pill / 执行模式 / 圆形发送键)内嵌在下 */
.input-area {
  margin: 0 var(--space-3) var(--space-3);
  border: 1px solid var(--border-base);
  border-radius: 14px;
  background: var(--bg-elevated);
  padding: var(--space-2) var(--space-3);

  /* textarea 去边框去底色 — 成为卡片的一部分而不是嵌套的框 */
  :deep(.el-textarea__inner) {
    background: transparent;
    border: none;
    box-shadow: none !important;
    padding: 8px 4px;
    resize: none;
    font-size: 14px;
    color: var(--text-color);
  }
}

/* 工具栏: 左 = 模型选择器, 右 = 执行模式 + 圆形发送键 */
.input-toolbar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-1, 4px);
}

.toolbar-spacer {
  flex: 1;
}

.model-pill {
  width: 200px;
}

/* 供应商 pill: 比 model pill 窄一档, 二者同排紧凑并列 */
.provider-pill {
  width: 150px;
}

/* 【P0 迭代】pill 统一 chip 语言: 五颗 pill(供应商/模型/记忆/执行模式)同底(透明)/
   同描边(1px border-base)/同圆角(9999px)/同高(28px)/同字号(12px),
   状态只靠"点的颜色"表达 — 供应商/模型是 el-select, 用 :deep 收编进同一语言 */
.provider-pill,
.model-pill {
  :deep(.el-select__wrapper),
  :deep(.el-input__wrapper) {
    background: transparent;
    box-shadow: 0 0 0 1px var(--border-base) inset;
    border-radius: 9999px;
    min-height: 28px;
    padding: 2px 12px;
    font-size: 12px;
  }
  :deep(.el-select__wrapper.is-hovering),
  :deep(.el-select__wrapper.is-focused),
  :deep(.el-input__wrapper.is-focus) {
    box-shadow: 0 0 0 1px var(--accent-base) inset;
  }
  :deep(.el-select__placeholder),
  :deep(.el-select__selected-item),
  :deep(.el-input__inner) {
    font-size: 12px;
  }
}

/* 附件 + 按钮 / 输入能力按钮: 与发送键同款圆形语言, 次要态(非 accent 实心) */
.attach-btn,
.input-tool-btn {
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  background: var(--bg-hover);
  border-color: var(--border-base);
  color: var(--fg-secondary);

  /* 全局规则给 .el-button .el-icon 加了 margin-right:4px(为文字按钮排版),
     icon-only 圆钮会被推离圆心 — 圆钮一律归零 */
  .el-icon {
    margin-right: 0;
  }

  &:hover {
    background: var(--accent-soft);
    border-color: var(--accent-base);
    color: var(--accent-base);
  }
}

/* 联网搜索开启态：实心高亮，状态一眼可见（对齐其它产品搜索开关） */
.input-tool-btn.is-active {
  background: var(--accent-base);
  border-color: var(--accent-base);
  color: var(--bg-base);
  &:hover { opacity: 0.85; }
}

/* 记忆开关 pill: 状态常驻可见 — 点=启用, 灰=关闭 (chip 语言: 同上注释) */
.memory-pill {
  appearance: none;
  font-family: inherit;
  font-size: 12px;
  line-height: 18px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 12px;
  border-radius: 9999px;
  cursor: pointer;
  background: transparent;
  border: 1px solid var(--border-base);
  color: var(--fg-tertiary);
  flex-shrink: 0;
  white-space: nowrap;
  transition: color var(--duration-fast, 120ms) var(--ease-standard, ease),
    border-color var(--duration-fast, 120ms) var(--ease-standard, ease);

  .pill-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--fg-quaternary);
    transition: background var(--duration-fast, 120ms) var(--ease-standard, ease);
  }

  &.is-on {
    color: var(--accent-base);
    border-color: var(--accent-soft);

    .pill-dot {
      background: var(--accent-base);
    }
  }

  &:hover {
    border-color: var(--accent-base);
  }
}

.quoted-message-preview {
  margin-bottom: 8px;
  padding: 8px 12px;
  background: var(--bg-hover);
  border-left: 3px solid var(--accent-base);
  border-radius: 4px;

  .quoted-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 4px;

    .quoted-label {
      font-size: 11px;
      color: var(--fg-secondary);
      font-weight: 500;
    }
  }

  .quoted-content {
    font-size: 12px;
    color: var(--fg-secondary);
    line-height: 1.5;
  }
}

.input-row {
  display: block;
}

/* 【设计审计】发送键统一到品牌 accent 家族(圆形 icon 键):
   - 启用态: accent-base 底 + accent-fg 图标(暗色主题=亮青底深色图标)
   - 禁用态: 退成 accent-soft 暗表面 + 灰图标
   - 微交互: hover 轻抬 / active 按压 scale, 状态切换 150ms 过渡 */
.send-btn {
  width: 40px;
  height: 40px;
  flex-shrink: 0;
  transition: background var(--duration-fast, 150ms) var(--ease-standard, ease),
    color var(--duration-fast, 150ms) var(--ease-standard, ease),
    transform var(--duration-fast, 120ms) var(--ease-standard, ease);

  &:hover:not(.is-disabled) {
    transform: scale(1.06);
  }
  &:active:not(.is-disabled) {
    transform: scale(0.94);
  }

  /* icon-only 圆钮: 归零全局 margin-right, 否则图标偏离圆心 */
  .el-icon {
    margin-right: 0;
  }
  &.el-button--primary:not(.is-disabled) {
    background: var(--accent-base);
    border-color: var(--accent-base);
    color: var(--accent-fg, #fff);

    &:hover,
    &:focus {
      background: var(--accent-hover);
      border-color: var(--accent-hover);
      color: var(--accent-fg, #fff);
    }
    &:active {
      background: var(--accent-base);
      border-color: var(--accent-base);
      color: var(--accent-fg, #fff);
    }
  }

  &.el-button--primary.is-disabled {
    background: var(--accent-soft);
    border-color: var(--accent-soft);
    color: var(--el-text-color-disabled);
  }
}
</style>