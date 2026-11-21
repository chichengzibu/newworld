/**
 * PiPiClaw - 预加载脚本
 * 
 * 职责：
 * 1. 暴露安全的contextBridge API
 * 2. 隔离主进程和渲染进程
 * 3. 提供类型安全的IPC调用接口
 */

import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

// NOVA #005-B · M4 — 语音设置类型(第②笔, IPC 接线配套 import; 不新增模块)
// 【M3-F 修断链】原路径是 '../core/voice' —— 但本文件在 electron/ 下,
// '../core/voice' 指向仓库根(不存在)。正确是 './core/voice';
// 又因 tsconfig 用 moduleResolution:'bundler'(不解析目录索引),需指到 barrel 文件。
import type { VoiceSettings } from './core/voice/index';

// Sentry 渲染↔主进程桥接:必须在 preload 顶部引入,使渲染端事件能转发到主进程上报。
import '@sentry/electron/preload';

// ========== IPC通道定义 ==========

const IpcChannels = {
  // ========== NOVA #003-C · M2 — BootDirector handshake(第②笔, 纯追加) ==========
  //   命名空间 nova:* 与既有 webcontainer:* / runtime:* 不冲突
  //   交叉引用: IpcServer.ts L386-397 的 nova:renderer-ready / nova:boot-skip handler
  //   splash.html(第③笔) 在 window.nova 命名空间下消费
  NOVA_RENDERER_READY: 'nova:renderer-ready',
  NOVA_BOOT_SKIP: 'nova:boot-skip',
  NOVA_BOOT_EVENT: 'nova:boot-event',
  NOVA_SEARCH: 'nova:search',
  NOVA_VOICE_GET_SETTINGS: 'nova:voice:get-settings',
  NOVA_VOICE_SET_SETTINGS: 'nova:voice:set-settings',

  // 文件选择器
  DIALOG_OPEN_FILE: 'dialog:openFile',

  // 窗口管理
  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_MAXIMIZE: 'window:maximize',
  WINDOW_CLOSE: 'window:close',
  WINDOW_IS_MAXIMIZED: 'window:isMaximized',
  WINDOW_ON_MAXIMIZE_CHANGE: 'window:onMaximizeChange',
  WINDOW_SET_ALWAYS_ON_TOP: 'window:setAlwaysOnTop',
  WINDOW_IS_ALWAYS_ON_TOP: 'window:isAlwaysOnTop',
  WINDOW_SET_EDGE_HIDE: 'window:setEdgeHide',
  WINDOW_IS_EDGE_HIDE: 'window:isEdgeHide',
  WINDOW_SHOW_MINI: 'window:showMini',
  WINDOW_HIDE_TO_TRAY: 'window:hideToTray',



  // 网关管理
  GATEWAY_START: 'gateway:start',
  GATEWAY_STOP: 'gateway:stop',
  GATEWAY_RESTART: 'gateway:restart',
  GATEWAY_STATUS: 'gateway:status',
  GATEWAY_LOGS: 'gateway:logs',
  GATEWAY_CONFIG_GET: 'gateway:config:get',
  GATEWAY_CONFIG_SET: 'gateway:config:set',
  GATEWAY_ON_STATUS_CHANGE: 'gateway:onStatusChange',
  GATEWAY_ON_LOG: 'gateway:onLog',

  // 全局配置
  CONFIG_GET: 'config:get',
  CONFIG_SET: 'config:set',
  CONFIG_GET_ALL: 'config:getAll',

  // 模型管理
  MODELS_LIST: 'models:list',
  MODELS_GET_TEMPLATES: 'models:getTemplates',
  MODELS_GET: 'models:get',
  MODELS_ADD: 'models:add',
  MODELS_UPDATE: 'models:update',
  MODELS_DELETE: 'models:delete',
  MODELS_TOGGLE: 'models:toggle',
  MODELS_TEST: 'models:test',
  MODELS_SYNC_OLLAMA: 'models:syncOllama',
  MODELS_FETCH: 'models:fetch',

  // 权限管理
  PERMISSIONS_LIST: 'permissions:list',
  PERMISSIONS_GET: 'permissions:get',
  PERMISSIONS_ACTIVE: 'permissions:active',
  PERMISSIONS_SET_ACTIVE: 'permissions:setActive',
  PERMISSIONS_CREATE: 'permissions:create',
  PERMISSIONS_UPDATE: 'permissions:update',
  PERMISSIONS_UPDATE_RULE: 'permissions:updateRule',
  PERMISSIONS_DELETE: 'permissions:delete',
  PERMISSIONS_DUPLICATE: 'permissions:duplicate',
  PERMISSIONS_CHECK: 'permissions:check',
  PERMISSIONS_RESET: 'permissions:reset',

  // 聊天管理
  CHAT_CONVERSATIONS: 'chat:conversations',
  CHAT_CONVERSATION_GET: 'chat:conversation:get',
  CHAT_CONVERSATION_CREATE: 'chat:conversation:create',
  CHAT_CONVERSATION_UPDATE: 'chat:conversation:update',
  CHAT_CONVERSATION_DELETE: 'chat:conversation:delete',
  CHAT_CONVERSATION_ARCHIVE: 'chat:conversation:archive',
  CHAT_CONVERSATION_PIN: 'chat:conversation:pin',
  CHAT_MESSAGE_SEND: 'chat:message:send',
  CHAT_MESSAGE_STOP: 'chat:message:stop',
  CHAT_MESSAGE_CONTINUE: 'chat:message:continue',
  CHAT_LAST_MODEL_GET: 'chat:lastModel:get',
  CHAT_SETTINGS_GET: 'chat:settings:get',
  CHAT_SETTINGS_UPDATE: 'chat:settings:update',
  CHAT_ON_MESSAGE: 'chat:onMessage',
  CHAT_ON_CONVERSATION_UPDATE: 'chat:onConversationUpdate',
  CHAT_ON_STREAM_UPDATE: 'chat:streamUpdate',

  // 应用信息
  APP_VERSION: 'app:version',

  // 任务执行
  TASK_EXECUTE: 'task:execute',
  TASK_CANCEL: 'task:cancel',
  TASK_EXECUTE_TOOL: 'task:executeTool',
  TASK_TOOLS_GET: 'task:toolsGet',
  TASK_GATEWAY_CHECK: 'task:gatewayCheck',

  // 执行模式
  EXECUTION_MODE_GET: 'execution:mode:get',
  EXECUTION_MODE_SET: 'execution:mode:set',
  EXECUTION_MODE_CHECK: 'execution:mode:check',
  EXECUTION_MODE_CANCEL: 'execution:mode:cancel',

  // 【M1-D】任务计划确认 —— 主进程生成计划后 emit,渲染层弹确认框
  CHAT_ON_TASK_PLAN: 'chat:onTaskPlan',
  CHAT_ON_TASK_STEP: 'chat:onTaskStep',
  CHAT_ON_AGENT_EVENT: 'agent:onEvent',
  CHAT_TASK_CONFIRM: 'chat:task:confirm',

  // 【M4-A】技能提案通知 —— 主进程 emit,渲染层 SkillsView 订阅
  SKILLS_NEW_PROPOSAL: 'skills:new-proposal',

  // 任务日志
  TASK_LOG_GET: 'task:log:get',
  TASK_LOG_QUERY: 'task:log:query',
  TASK_LOG_DELETE: 'task:log:delete',
  TASK_LOG_DELETE_BATCH: 'task:log:deleteBatch',
  TASK_LOG_EXPORT: 'task:log:export',
  TASK_LOG_STATS: 'task:log:stats',
  TASK_LOG_RETRY: 'task:log:retry',
  TASK_LOG_CANCEL: 'task:log:cancel',

  // CrashReport 收集器 (P5-T5.4)
  CRASH_LIST: 'crash:list',
  CRASH_GET: 'crash:get',
  CRASH_CLEAR: 'crash:clear',
  CRASH_COUNT: 'crash:count',

  // 文件操作
  FILE_PARSE: 'file:parse',
  FILE_PARSE_BATCH: 'file:parseBatch',
  FILE_READ_CLIPBOARD_IMAGE: 'file:readClipboardImage',
  FILE_GET_INFO: 'file:getInfo',
  FILE_GET_ALLOWED_EXTENSIONS: 'file:getAllowedExtensions',
  FILE_UPLOAD_TO_IM: 'file:upload-to-im',
  FILE_LIST_SUPPORTED_PLATFORMS: 'file:list-supported-platforms',

  // 对话导出
  CONVERSATION_EXPORT: 'conversation:export',

  // OpenClaw 核心执行引擎
  OPENCLAW_EXECUTE: 'openclaw:execute',
  OPENCLAW_BATCH_EXECUTE: 'openclaw:batch-execute',
  OPENCLAW_CHECK_PERMISSION: 'openclaw:check-permission',
  OPENCLAW_GET_AUDIT_LOGS: 'openclaw:get-audit-logs',
  OPENCLAW_HEALTH_CHECK: 'openclaw:health-check',

  // Hermes 记忆管理
  HERMES_GET_MEMORIES: 'hermes:getMemories',
  HERMES_SAVE_CORE_MEMORY: 'hermes:saveCoreMemory',
  // 【M3-A】嵌入后端配置 —— 真向量的入口
  HERMES_EMBEDDING_GET: 'hermes:embedding:get',
  HERMES_EMBEDDING_SET: 'hermes:embedding:set',
  HERMES_EMBEDDING_DETECT: 'hermes:embedding:detect',
  HERMES_EMBEDDING_TEST: 'hermes:embedding:test',
  // 【M4-F】用户接受度信号
  LEARNING_RECORD_ACCEPTANCE: 'learning:recordAcceptance',
  LEARNING_GET_ACCEPTANCE: 'learning:getAcceptance',

  // Phase 2: 任务预览与确认
  TASK_TRACE: 'task:trace',
  TASK_CONFIRM_PREVIEW: 'task:confirm-preview',
  TASK_ON_PREVIEW: 'task:on-preview',
  // 命令确认 (v3 #5 弹窗): 主进程→渲染 请求确认; 渲染→主进程 回执
  COMMAND_CONFIRM_REQUEST: 'command:confirm-request',
  COMMAND_CONFIRM_REPLY: 'command:confirm-reply',

  // ========== 技能管理 ==========
  SKILLS_LIST: 'skills:list',
  SKILLS_TOGGLE: 'skills:toggle',
  SKILLS_GET_EFFECTIVENESS: 'skills:getEffectiveness',
  // 【M4-E】技能效用对照实验
  SKILLS_RUN_UTILITY_TRIAL: 'skills:runUtilityTrial',
  // 【M4-V】裁判放行门禁状态
  SKILLS_JUDGE_TRUST: 'skills:judgeTrust',
  // 【M4-X】开源技能库(搜索/推荐/下载安装)
  SKILLS_HUB_SEARCH: 'skills:hub:search',
  SKILLS_HUB_RECOMMEND: 'skills:hub:recommend',
  SKILLS_HUB_REFRESH: 'skills:hub:refresh',
  SKILLS_HUB_INSTALL: 'skills:hub:install',
  // 【M4-AC】安装前预览(列出包内文件/可执行脚本)
  SKILLS_HUB_PREVIEW: 'skills:hub:preview',
  SKILLS_GET_UTILITY: 'skills:getUtility',
  SKILLS_RELOAD: 'skills:reload',
  SKILLS_IMPORT_FILE: 'skills:importFile',
  SKILLS_IMPORT_URL: 'skills:importUrl',
  SKILLS_IMPORT_ZIP: 'skills:importZip',
  SKILLS_MERGE_CANDIDATES: 'skills:merge-candidates',
  SKILLS_PERFORM_MERGE: 'skills:perform-merge',
  SKILLS_IMPORT_FOLDER: 'skills:importFolder',
  SKILLS_GET_DIRECTORY_PREVIEW: 'skills:getDirectoryPreview',
  SKILLS_ADD_CUSTOM_DIR: 'skills:addCustomDir',
  SKILLS_REMOVE_CUSTOM_DIR: 'skills:removeCustomDir',
  SKILLS_GET_CUSTOM_DIRS: 'skills:getCustomDirs',
  SKILLS_GET_STORAGE_INFO: 'skills:getStorageInfo',
  SKILLS_REMOVE: 'skills:remove',

  // ========== MCP 配置管理 ==========
  MCP_LIST: 'mcp:list',
  MCP_ADD: 'mcp:add',
  MCP_UPDATE: 'mcp:update',
  MCP_REMOVE: 'mcp:remove',
  MCP_TOGGLE: 'mcp:toggle',
  MCP_TEST: 'mcp:test',

  // ========== M1: MCP 运行时 (stdio + filesystem server PoC) ==========
  MCP_START_SERVER: 'mcp:start-server',
  MCP_STOP_SERVER: 'mcp:stop-server',
  MCP_START_ALL_ENABLED: 'mcp:start-all-enabled',
  MCP_STOP_ALL: 'mcp:stop-all',
  MCP_LIST_SERVERS: 'mcp:list-servers',
  MCP_LIST_TOOLS: 'mcp:list-tools',
  MCP_LIST_TOOLS_BY_SERVER: 'mcp:list-tools-by-server',
  MCP_INVOKE: 'mcp:invoke',

  // ========== Hermes 学习统计 ==========
  LEARNING_GET_STATS: 'learning:get-stats',
  LEARNING_RESET: 'learning:reset',
  LEARNING_SAVE_SKILL_PROPOSAL: 'learning:save-skill-proposal',
  LEARNING_GET_PENDING_PROPOSAL: 'learning:get-pending-proposal',
  LEARNING_CLEAR_PENDING_PROPOSAL: 'learning:clear-pending-proposal',

  // ========== Agent 能力域 (W3 新增) ==========
  AGENT_THINK: 'agent:think',
  AGENT_SPAWN: 'agent:spawn',
  AGENT_LIST: 'agent:list',

  // ========== Channel 能力域 (W3 新增) ==========
  CHANNEL_LIST: 'channel:list',
  CHANNEL_HEALTH: 'channel:health',
  CHANNEL_SEND: 'channel:send',
  CHANNEL_MESSAGE_STATS: 'channel:message-stats',
  CHANNEL_MESSAGE_HISTORY: 'channel:message-history',

  // 路由规则
  ROUTING_LIST: 'routing:list',
  ROUTING_ADD: 'routing:add',
  ROUTING_REMOVE: 'routing:remove',

  // 权限
  PERMISSION_LIST: 'permission:list',
  PERMISSION_EXPORT: 'permission:export',
  PERMISSION_IMPORT: 'permission:import',

  // ClawHub 技能市场

  // ClawHub 远程仓库 (registry)
  CLAWHUB_REGISTRY_LIST: 'skills:clawhub:registry:list',
  CLAWHUB_REGISTRY_INSTALL: 'skills:clawhub:registry:install',

  // 模型评分
  MODEL_RATE: 'model:rate',
  MODEL_LIST_RATINGS: 'model:list-ratings',
  MODEL_GET_STATS: 'model:get-stats',

  // 模型使用量
  MODEL_USAGE_RECORD: 'model:usage-record',
  MODEL_USAGE_TOP: 'model:usage-top',
  MODEL_USAGE_TOTAL: 'model:usage-total',

  // ========== P7 Sandbox 能力域 (W3 新增) ==========
  SANDBOX_DETECT: 'sandbox:detect',
  SANDBOX_RUN: 'sandbox:run',
  SANDBOX_PREVIEW: 'sandbox:preview',
  SANDBOX_STOP: 'sandbox:stop',

  // ========== Insight 能力域 (W3 新增) ==========
  INSIGHT_TRACE_START: 'insight:trace:start',
  INSIGHT_TRACE_END: 'insight:trace:end',
  INSIGHT_COST_TODAY: 'insight:cost:today',
  // 【M4-H】模型定价(用户可维护自己的模型单价)
  INSIGHT_GET_PRICING: 'insight:getPricing',
  INSIGHT_SET_PRICING: 'insight:setPricing',

  // ========== W7.0.2: D5 录屏转技能 IPC ==========
  D5_RUN: 'd5:run',

  // ========== W12.B: IM 账号配置 IPC ==========
  CHANNEL_CONFIG_GET: 'channel-config:get',
  CHANNEL_CONFIG_SAVE: 'channel-config:save',
  CHANNEL_CONFIG_TEST: 'channel-config:test',

  // ========== W13.A: 5 demo IPC ==========
  D1_DEMO_RUN: 'd1-demo:run',
  D2_PRIME_DEMO_RUN: 'd2-prime-demo:run',
  D3_DEMO_RUN: 'd3-demo:run',
  D5_DEMO_RUN: 'd5-demo:run',
  A5_DEMO_RUN: 'a5-demo:run',

  // ========== W14.A: LLM provider config IPC ==========
  LLM_CONFIG_LIST: 'llm-config:list',
  LLM_CONFIG_UPSERT: 'llm-config:upsert',
  LLM_CONFIG_TEST: 'llm-config:test',
  LLM_CHAT: 'llm:chat',

  // ========== Phase 4 Task 4: Auto-updater IPC ==========
  AUTO_UPDATER_CHECK: 'autoUpdater:check',
  AUTO_UPDATER_DOWNLOAD: 'autoUpdater:download',
  AUTO_UPDATER_INSTALL: 'autoUpdater:install',
  AUTO_UPDATER_GET_VERSION: 'autoUpdater:getVersion',
  AUTO_UPDATER_ON_UPDATE_AVAILABLE: 'autoUpdater:onUpdateAvailable',
  AUTO_UPDATER_ON_UPDATE_DOWNLOADED: 'autoUpdater:onUpdateDownloaded',
  AUTO_UPDATER_ON_ERROR: 'autoUpdater:onError',

  // ========== 定时任务 Schedule ==========
  SCHEDULE_LIST: 'schedule:list',
  SCHEDULE_ADD: 'schedule:add',
  SCHEDULE_UPDATE: 'schedule:update',
  SCHEDULE_REMOVE: 'schedule:remove',
  SCHEDULE_SET_ENABLED: 'schedule:setEnabled',
  SCHEDULE_HISTORY: 'schedule:history'
} as const;

type IpcCallback = (event: IpcRendererEvent, ...args: any[]) => void;

// ========== API类型定义 ==========

interface GatewayStatus {
  state: 'stopped' | 'starting' | 'running' | 'failed' | 'stopping';
  port: number;
  pid: number | null;
  startTime: number | null;
  error: string | null;
  version: string | null;
}

interface GatewayLog {
  timestamp: number;
  level: 'stdout' | 'stderr' | 'info' | 'warn' | 'error';
  message: string;
  source?: string;
}

interface GatewayConfig {
  autoStart: boolean;
  defaultPort: number;
  timeout: number;
  logLevel: string;
  customArgs: string[];
}

interface GatewayStartOptions {
  port?: number;
  timeout?: number;
  silent?: boolean;
}

interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  capabilities: string[];
  maxTokens?: number;
  contextWindow?: number;
  inputCost?: number;
  outputCost?: number;
  description?: string;
  disabled?: boolean;
}

interface ProviderConfig {
  id: string;
  name: string;
  type: 'openai' | 'anthropic' | 'deepseek' | 'azure' | 'ollama' | 'custom';
  enabled: boolean;
  baseUrl?: string;
  apiKey?: string;
  organization?: string;
  deploymentName?: string;
  apiVersion?: string;
  models: ModelInfo[];
  defaultModel?: string;
  timeout?: number;
  maxRetries?: number;
  createdAt: number;
  updatedAt: number;
}

interface ModelTestResult {
  success: boolean;
  latency?: number;
  response?: string;
  error?: string;
}

type PermissionCategory = 'filesystem' | 'network' | 'process' | 'system' | 'clipboard' | 'shell' | 'environment';
type PermissionLevel = 'none' | 'read' | 'write' | 'execute' | 'all';
type PermissionTemplate = 'safe' | 'standard' | 'permissive' | 'custom';

interface PermissionRule {
  id: string;
  category: PermissionCategory;
  name: string;
  description: string;
  level: PermissionLevel;
  allowedPaths?: string[];
  deniedPaths?: string[];
  allowedDomains?: string[];
  deniedDomains?: string[];
}

interface PermissionSet {
  id: string;
  name: string;
  template: PermissionTemplate;
  description: string;
  rules: PermissionRule[];
  createdAt: number;
  updatedAt: number;
}

interface PermissionCheckRequest {
  category: PermissionCategory;
  action: string;
  resource?: string;
}

interface PermissionCheckResult {
  allowed: boolean;
  reason?: string;
  requiresConfirmation?: boolean;
}

type MessageRole = 'user' | 'assistant' | 'system';
type MessageStatus = 'sending' | 'streaming' | 'sent' | 'error';

interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  thinking?: string;
  timestamp: number;
  status: MessageStatus;
  modelId?: string;
  providerId?: string;
  error?: string;
  metadata?: Record<string, any>;
}

interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  modelId?: string;
  providerId?: string;
  createdAt: number;
  updatedAt: number;
  status: 'active' | 'archived';
  pinned: boolean;
}

interface ChatSettings {
  temperature: number;
  maxTokens: number;
  topP: number;
  frequencyPenalty: number;
  presencePenalty: number;
}

interface IpcResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
}

// ========== 任务类型 ==========

type TaskStatus = 'pending' | 'running' | 'success' | 'failed' | 'cancelled';
type StepStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped';
type StepType = 'permission_check' | 'filesystem' | 'network' | 'process' | 'shell' | 'clipboard' | 'system' | 'user_confirm' | 'result';

interface TaskStepParams {
  operation?: string;
  path?: string;
  content?: string;
  encoding?: string;
  command?: string;
  cwd?: string;
  value?: string;
  url?: string;
  text?: string;
  [key: string]: any;
}

interface TaskStep {
  id: string;
  order: number;
  type: StepType;
  description: string;
  params: TaskStepParams;
  requiredPermission?: string;
  requiredAction?: string;
  requiredResource?: string;
  status: StepStatus;
  result?: any;
  error?: string;
  startTime?: number;
  endTime?: number;
}

interface Task {
  id: string;
  conversationId: string;
  messageId: string;
  instruction: string;
  steps: TaskStep[];
  status: TaskStatus;
  result?: any;
  error?: string;
  createdAt: number;
  startTime?: number;
  endTime?: number;
}

interface TaskResult {
  success: boolean;
  taskId: string;
  status: TaskStatus;
  summary: string;
  result?: any;
  error?: string;
  totalSteps: number;
  successSteps: number;
  failedSteps: number;
  duration: number;
}

interface ToolCallRequest {
  name: string;
  arguments: Record<string, any>;
}

interface ToolCallResult {
  success: boolean;
  content: string;
  error?: string;
}

// ========== 执行模式类型 ==========

type ExecutionMode = 'safe' | 'plan' | 'craft';

interface ExecutionCheckResult {
  allowed: boolean;
  checkLevel: 'passed' | 'requires_confirmation' | 'blocked';
  reason?: string;
  guidance?: string;
}

// ========== 任务日志类型 ==========

type TaskLogStatus = 'pending' | 'running' | 'success' | 'failed' | 'cancelled';

interface TaskLogStep {
  order: number;
  operation: string;
  description: string;
  params: Record<string, any>;
  status: 'pending' | 'running' | 'success' | 'failed' | 'skipped' | 'blocked';
  permissionCheck?: {
    category: string;
    action: string;
    resource?: string;
    allowed: boolean;
    reason?: string;
  };
  result?: string;
  error?: string;
  startTime?: number;
  endTime?: number;
  duration?: number;
}

interface TaskLogEntry {
  id: string;
  conversationId: string;
  instruction: string;
  mode: ExecutionMode;
  status: TaskLogStatus;
  steps: TaskLogStep[];
  summary: string;
  error?: string;
  duration?: number;
  createdAt: number;
  startTime?: number;
  endTime?: number;
  retryCount: number;
  parentTaskId?: string;
}

interface TaskLogQuery {
  status?: TaskLogStatus;
  mode?: ExecutionMode;
  startDate?: number;
  endDate?: number;
  keyword?: string;
  limit?: number;
  offset?: number;
}

interface TaskLogStats {
  total: number;
  success: number;
  failed: number;
  cancelled: number;
  byMode: Record<string, number>;
}

interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: string;
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

// ========== API对象 ==========

const electronAPI = {
  // ========== 文件选择器 ==========
  dialog: {
    openFile: (options: any) => ipcRenderer.invoke(IpcChannels.DIALOG_OPEN_FILE, options)
  },

  // ========== 窗口管理 ==========
  window: {
    minimize: () => ipcRenderer.invoke(IpcChannels.WINDOW_MINIMIZE),
    maximize: () => ipcRenderer.invoke(IpcChannels.WINDOW_MAXIMIZE),
    close: () => ipcRenderer.invoke(IpcChannels.WINDOW_CLOSE),
    isMaximized: () => ipcRenderer.invoke(IpcChannels.WINDOW_IS_MAXIMIZED),
    setAlwaysOnTop: (value: boolean) => ipcRenderer.invoke(IpcChannels.WINDOW_SET_ALWAYS_ON_TOP, value),
    isAlwaysOnTop: () => ipcRenderer.invoke(IpcChannels.WINDOW_IS_ALWAYS_ON_TOP),
    setEdgeHide: (value: boolean) => ipcRenderer.invoke(IpcChannels.WINDOW_SET_EDGE_HIDE, value),
    isEdgeHide: () => ipcRenderer.invoke(IpcChannels.WINDOW_IS_EDGE_HIDE),
    showMini: () => ipcRenderer.invoke(IpcChannels.WINDOW_SHOW_MINI),
    hideToTray: () => ipcRenderer.invoke(IpcChannels.WINDOW_HIDE_TO_TRAY),
    onMaximizeChange: (callback: (isMaximized: boolean) => void) => {
      const handler: IpcCallback = (_, isMaximized: boolean) => callback(isMaximized);
      ipcRenderer.on(IpcChannels.WINDOW_ON_MAXIMIZE_CHANGE, handler);
      return () => ipcRenderer.removeListener(IpcChannels.WINDOW_ON_MAXIMIZE_CHANGE, handler);
    }
  },
  


  // ========== 应用信息 ==========
  app: {
    getVersion: () => ipcRenderer.invoke(IpcChannels.APP_VERSION),
    getPlatform: () => process.platform
  },
  
  // ========== 全局配置 ==========
  config: {
    get: (key: string) => ipcRenderer.invoke(IpcChannels.CONFIG_GET, key),
    set: (key: string, value: any) => ipcRenderer.invoke(IpcChannels.CONFIG_SET, key, value),
    getAll: () => ipcRenderer.invoke(IpcChannels.CONFIG_GET_ALL)
  },
  
  // ========== 网关管理 ==========
  gateway: {
    // 启动网关
    start: (options?: GatewayStartOptions): Promise<IpcResponse<GatewayStatus>> => 
      ipcRenderer.invoke(IpcChannels.GATEWAY_START, options),
    
    // 停止网关
    stop: (): Promise<IpcResponse<void>> => 
      ipcRenderer.invoke(IpcChannels.GATEWAY_STOP),
    
    // 重启网关
    restart: (): Promise<IpcResponse<GatewayStatus>> => 
      ipcRenderer.invoke(IpcChannels.GATEWAY_RESTART),
    
    // 获取状态
    status: (): Promise<IpcResponse<GatewayStatus>> => 
      ipcRenderer.invoke(IpcChannels.GATEWAY_STATUS),
    
    // 获取日志
    logs: (): Promise<IpcResponse<GatewayLog[]>> => 
      ipcRenderer.invoke(IpcChannels.GATEWAY_LOGS),
    
    // 获取配置
    config: {
      get: (): Promise<IpcResponse<GatewayConfig>> => 
        ipcRenderer.invoke(IpcChannels.GATEWAY_CONFIG_GET),
      set: (config: Partial<GatewayConfig>): Promise<IpcResponse<void>> => 
        ipcRenderer.invoke(IpcChannels.GATEWAY_CONFIG_SET, config)
    },
    
    // 监听状态变更
    onStatusChange: (callback: (data: { oldState: string; newState: string; info: GatewayStatus }) => void) => {
      const handler: IpcCallback = (_, data) => callback(data);
      ipcRenderer.on(IpcChannels.GATEWAY_ON_STATUS_CHANGE, handler);
      return () => ipcRenderer.removeListener(IpcChannels.GATEWAY_ON_STATUS_CHANGE, handler);
    },
    
    // 监听日志
    onLog: (callback: (entry: GatewayLog) => void) => {
      const handler: IpcCallback = (_, entry: GatewayLog) => callback(entry);
      ipcRenderer.on(IpcChannels.GATEWAY_ON_LOG, handler);
      return () => ipcRenderer.removeListener(IpcChannels.GATEWAY_ON_LOG, handler);
    }
  },

  // ========== 模型管理 ==========
  models: {
    list: (): Promise<IpcResponse<ProviderConfig[]>> =>
      ipcRenderer.invoke(IpcChannels.MODELS_LIST),

    getTemplates: (): Promise<IpcResponse<Array<{ name: string; type: string; defaultConfig: Partial<ProviderConfig> }>>> =>
      ipcRenderer.invoke(IpcChannels.MODELS_GET_TEMPLATES),

    get: (id: string): Promise<IpcResponse<ProviderConfig>> =>
      ipcRenderer.invoke(IpcChannels.MODELS_GET, id),

    add: (data: Omit<ProviderConfig, 'id' | 'createdAt' | 'updatedAt'>): Promise<IpcResponse<ProviderConfig>> =>
      ipcRenderer.invoke(IpcChannels.MODELS_ADD, data),

    update: (id: string, updates: Partial<ProviderConfig>): Promise<IpcResponse<ProviderConfig>> =>
      ipcRenderer.invoke(IpcChannels.MODELS_UPDATE, id, updates),

    delete: (id: string): Promise<IpcResponse<boolean>> =>
      ipcRenderer.invoke(IpcChannels.MODELS_DELETE, id),

    toggle: (id: string, enabled: boolean): Promise<IpcResponse<boolean>> =>
      ipcRenderer.invoke(IpcChannels.MODELS_TOGGLE, id, enabled),

    test: (providerId: string, modelId?: string): Promise<IpcResponse<ModelTestResult>> =>
      ipcRenderer.invoke(IpcChannels.MODELS_TEST, providerId, modelId),

    syncOllama: (providerId: string): Promise<IpcResponse<ModelInfo[]>> =>
      ipcRenderer.invoke(IpcChannels.MODELS_SYNC_OLLAMA, providerId),

    fetch: (providerId: string): Promise<IpcResponse<{ models: ModelInfo[]; error?: string }>> =>
      ipcRenderer.invoke(IpcChannels.MODELS_FETCH, providerId)
  },

  // ========== 权限管理 ==========
  permissions: {
    list: (): Promise<IpcResponse<PermissionSet[]>> =>
      ipcRenderer.invoke(IpcChannels.PERMISSIONS_LIST),

    get: (id: string): Promise<IpcResponse<PermissionSet>> =>
      ipcRenderer.invoke(IpcChannels.PERMISSIONS_GET, id),

    active: (): Promise<IpcResponse<PermissionSet>> =>
      ipcRenderer.invoke(IpcChannels.PERMISSIONS_ACTIVE),

    setActive: (id: string): Promise<IpcResponse<boolean>> =>
      ipcRenderer.invoke(IpcChannels.PERMISSIONS_SET_ACTIVE, id),

    create: (data: { name: string; template: PermissionTemplate; description: string; rules?: PermissionRule[] }): Promise<IpcResponse<PermissionSet>> =>
      ipcRenderer.invoke(IpcChannels.PERMISSIONS_CREATE, data),

    update: (id: string, updates: Partial<PermissionSet>): Promise<IpcResponse<PermissionSet>> =>
      ipcRenderer.invoke(IpcChannels.PERMISSIONS_UPDATE, id, updates),

    updateRule: (setId: string, ruleId: string, updates: Partial<PermissionRule>): Promise<IpcResponse<PermissionRule>> =>
      ipcRenderer.invoke(IpcChannels.PERMISSIONS_UPDATE_RULE, setId, ruleId, updates),

    delete: (id: string): Promise<IpcResponse<boolean>> =>
      ipcRenderer.invoke(IpcChannels.PERMISSIONS_DELETE, id),

    duplicate: (id: string, newName: string): Promise<IpcResponse<PermissionSet>> =>
      ipcRenderer.invoke(IpcChannels.PERMISSIONS_DUPLICATE, id, newName),

    check: (request: PermissionCheckRequest): Promise<IpcResponse<PermissionCheckResult>> =>
      ipcRenderer.invoke(IpcChannels.PERMISSIONS_CHECK, request),

    /** M1 P0-1: 显式 force reset 到 unrestricted (UI 重置按钮 / 用户主动) */
    reset: (): Promise<IpcResponse<boolean>> =>
      ipcRenderer.invoke(IpcChannels.PERMISSIONS_RESET),
  },

  // ========== 聊天管理 ==========
  chat: {
    conversations: (): Promise<IpcResponse<Conversation[]>> =>
      ipcRenderer.invoke(IpcChannels.CHAT_CONVERSATIONS),

    getConversation: (id: string): Promise<IpcResponse<Conversation>> =>
      ipcRenderer.invoke(IpcChannels.CHAT_CONVERSATION_GET, id),

    createConversation: (data?: { title?: string; providerId?: string; modelId?: string }): Promise<IpcResponse<Conversation>> =>
      ipcRenderer.invoke(IpcChannels.CHAT_CONVERSATION_CREATE, data),

    updateConversation: (id: string, updates: Partial<Conversation>): Promise<IpcResponse<Conversation>> =>
      ipcRenderer.invoke(IpcChannels.CHAT_CONVERSATION_UPDATE, id, updates),

    deleteConversation: (id: string): Promise<IpcResponse<boolean>> =>
      ipcRenderer.invoke(IpcChannels.CHAT_CONVERSATION_DELETE, id),

    archiveConversation: (id: string): Promise<IpcResponse<Conversation>> =>
      ipcRenderer.invoke(IpcChannels.CHAT_CONVERSATION_ARCHIVE, id),

    pinConversation: (id: string, pinned: boolean): Promise<IpcResponse<Conversation>> =>
      ipcRenderer.invoke(IpcChannels.CHAT_CONVERSATION_PIN, id, pinned),

    sendMessage: (conversationId: string, content: string, providerId?: string, modelId?: string): Promise<IpcResponse<ChatMessage>> =>
      ipcRenderer.invoke(IpcChannels.CHAT_MESSAGE_SEND, conversationId, content, providerId, modelId),

    stopGeneration: (conversationId: string): Promise<IpcResponse<void>> =>
      ipcRenderer.invoke(IpcChannels.CHAT_MESSAGE_STOP, conversationId),

    continueGeneration: (conversationId: string): Promise<IpcResponse<void>> =>
      ipcRenderer.invoke(IpcChannels.CHAT_MESSAGE_CONTINUE, conversationId),

    getLastModel: (): Promise<IpcResponse<{ providerId: string | null; modelId: string | null }>> =>
      ipcRenderer.invoke(IpcChannels.CHAT_LAST_MODEL_GET),

    getSettings: (): Promise<IpcResponse<ChatSettings>> =>
      ipcRenderer.invoke(IpcChannels.CHAT_SETTINGS_GET),

    updateSettings: (settings: Partial<ChatSettings>): Promise<IpcResponse<ChatSettings>> =>
      ipcRenderer.invoke(IpcChannels.CHAT_SETTINGS_UPDATE, settings),

    onMessage: (callback: (data: { conversationId: string; message: ChatMessage }) => void) => {
      const handler: IpcCallback = (_, data) => callback(data);
      ipcRenderer.on(IpcChannels.CHAT_ON_MESSAGE, handler);
      return () => ipcRenderer.removeListener(IpcChannels.CHAT_ON_MESSAGE, handler);
    },

    /**
     * 【M1-D】订阅任务执行计划 —— 主进程在执行前 emit,渲染层弹确认框。
     * 这条通道此前完全不存在,导致 Chat.vue 的确认弹窗成为死代码:
     * showTaskConfirmDialog 从未被置 true,用户永远看不到。
     */
    onTaskPlan: (callback: (plan: any) => void) => {
      const handler: IpcCallback = (_, plan) => callback(plan);
      ipcRenderer.on(IpcChannels.CHAT_ON_TASK_PLAN, handler);
      return () => ipcRenderer.removeListener(IpcChannels.CHAT_ON_TASK_PLAN, handler);
    },

    /** 【M1-D】订阅单步状态流 —— 让执行过程实时可见(而非一行静态文字挂到结束) */
    onTaskStep: (callback: (data: any) => void) => {
      const handler: IpcCallback = (_, data) => callback(data);
      ipcRenderer.on(IpcChannels.CHAT_ON_TASK_STEP, handler);
      return () => ipcRenderer.removeListener(IpcChannels.CHAT_ON_TASK_STEP, handler);
    },

    /** 【M1-C】订阅 agent 运行事件(tool_call / tool_result)—— 工具调用可视化 */
    onAgentEvent: (callback: (data: any) => void) => {
      const handler: IpcCallback = (_, data) => callback(data);
      ipcRenderer.on(IpcChannels.CHAT_ON_AGENT_EVENT, handler);
      return () => ipcRenderer.removeListener(IpcChannels.CHAT_ON_AGENT_EVENT, handler);
    },

    /**
     * 【M1-D】回传用户对执行计划的确认/拒绝。
     * 执行权在主进程 —— 这里只是把用户的决定送回去,绝不自己执行。
     */
    confirmTaskPlan: (planId: string, confirmed: boolean): Promise<IpcResponse<boolean>> =>
      ipcRenderer.invoke(IpcChannels.CHAT_TASK_CONFIRM, { planId, confirmed }),

    onConversationUpdate: (callback: (data: { conversation: Conversation }) => void) => {
      const handler: IpcCallback = (_, data) => callback(data);
      ipcRenderer.on(IpcChannels.CHAT_ON_CONVERSATION_UPDATE, handler);
      return () => ipcRenderer.removeListener(IpcChannels.CHAT_ON_CONVERSATION_UPDATE, handler);
    },

    onStreamUpdate: (callback: (data: { conversationId: string; messageId: string; delta: string; type: 'content' | 'thinking' }) => void) => {
      const handler: IpcCallback = (_, data) => callback(data);
      ipcRenderer.on(IpcChannels.CHAT_ON_STREAM_UPDATE, handler);
      return () => ipcRenderer.removeListener(IpcChannels.CHAT_ON_STREAM_UPDATE, handler);
    }
  },

  // ========== 任务执行 ==========
  task: {
    execute: (task: Task): Promise<IpcResponse<TaskResult>> =>
      ipcRenderer.invoke(IpcChannels.TASK_EXECUTE, task),

    cancelExecution: (taskId: string): Promise<IpcResponse<boolean>> =>
      ipcRenderer.invoke(IpcChannels.TASK_CANCEL, taskId),

    executeTool: (request: ToolCallRequest): Promise<IpcResponse<ToolCallResult>> =>
      ipcRenderer.invoke(IpcChannels.TASK_EXECUTE_TOOL, request),

    getTools: (): Promise<IpcResponse<ToolDefinition[]>> =>
      ipcRenderer.invoke(IpcChannels.TASK_TOOLS_GET),

    isGatewayRunning: (): Promise<IpcResponse<boolean>> =>
      ipcRenderer.invoke(IpcChannels.TASK_GATEWAY_CHECK),

    // 任务日志
    getLog: (taskId: string): Promise<IpcResponse<TaskLogEntry>> =>
      ipcRenderer.invoke(IpcChannels.TASK_LOG_GET, taskId),

    queryLogs: (query: TaskLogQuery): Promise<IpcResponse<TaskLogEntry[]>> =>
      ipcRenderer.invoke(IpcChannels.TASK_LOG_QUERY, query),

    deleteLog: (taskId: string): Promise<IpcResponse<boolean>> =>
      ipcRenderer.invoke(IpcChannels.TASK_LOG_DELETE, taskId),

    deleteLogs: (taskIds: string[]): Promise<IpcResponse<number>> =>
      ipcRenderer.invoke(IpcChannels.TASK_LOG_DELETE_BATCH, taskIds),

    exportLog: (taskId: string, format: 'json' | 'txt'): Promise<IpcResponse<string>> =>
      ipcRenderer.invoke(IpcChannels.TASK_LOG_EXPORT, taskId, format),

    getStats: (): Promise<IpcResponse<TaskLogStats>> =>
      ipcRenderer.invoke(IpcChannels.TASK_LOG_STATS),

    retry: (taskId: string): Promise<IpcResponse<TaskResult>> =>
      ipcRenderer.invoke(IpcChannels.TASK_LOG_RETRY, taskId),

    cancel: (taskId: string): Promise<IpcResponse<boolean>> =>
      ipcRenderer.invoke(IpcChannels.TASK_LOG_CANCEL, taskId),

    // P5-T5.4: CrashReport 收集器
    crashList: (): Promise<IpcResponse<Array<{ id: string; data: any }>>> =>
      ipcRenderer.invoke(IpcChannels.CRASH_LIST),
    crashGet: (id: string): Promise<IpcResponse<any>> =>
      ipcRenderer.invoke(IpcChannels.CRASH_GET, id),
    crashClear: (): Promise<IpcResponse<{ cleared: number }>> =>
      ipcRenderer.invoke(IpcChannels.CRASH_CLEAR),
    crashCount: (): Promise<IpcResponse<{ count: number }>> =>
      ipcRenderer.invoke(IpcChannels.CRASH_COUNT),

    // Phase 2: 任务追踪与预览
    trace: (data: any): Promise<IpcResponse<void>> =>
      ipcRenderer.invoke(IpcChannels.TASK_TRACE, data),

    confirmPreview: (taskId: string, confirmed: boolean, editedContent?: string): Promise<IpcResponse<any>> =>
      ipcRenderer.invoke(IpcChannels.TASK_CONFIRM_PREVIEW, taskId, confirmed, editedContent),

    onPreview: (callback: (previewData: any) => void) => {
      const handler: IpcCallback = (_, previewData) => callback(previewData);
      ipcRenderer.on(IpcChannels.TASK_ON_PREVIEW, handler);
      return () => ipcRenderer.removeListener(IpcChannels.TASK_ON_PREVIEW, handler);
    }
  },

  // ========== 执行模式 ==========
  execution: {
    getMode: (): Promise<IpcResponse<ExecutionMode>> =>
      ipcRenderer.invoke(IpcChannels.EXECUTION_MODE_GET),

    setMode: (mode: ExecutionMode): Promise<IpcResponse<boolean>> =>
      ipcRenderer.invoke(IpcChannels.EXECUTION_MODE_SET, mode),

    checkOperation: (operation: string, params: Record<string, any>): Promise<IpcResponse<ExecutionCheckResult>> =>
      ipcRenderer.invoke(IpcChannels.EXECUTION_MODE_CHECK, operation, params),

    cancelExecution: (): Promise<IpcResponse<boolean>> =>
      ipcRenderer.invoke(IpcChannels.EXECUTION_MODE_CANCEL)
  },

  // ========== 文件操作 ==========
  file: {
    parse: (filePath: string): Promise<IpcResponse<any>> =>
      ipcRenderer.invoke(IpcChannels.FILE_PARSE, filePath),

    parseBatch: (filePaths: string[]): Promise<IpcResponse<any[]>> =>
      ipcRenderer.invoke(IpcChannels.FILE_PARSE_BATCH, filePaths),

    readClipboardImage: (): Promise<IpcResponse<{ base64?: string; error?: string }>> =>
      ipcRenderer.invoke(IpcChannels.FILE_READ_CLIPBOARD_IMAGE),

    getInfo: (filePath: string): Promise<IpcResponse<any>> =>
      ipcRenderer.invoke(IpcChannels.FILE_GET_INFO, filePath),

    getAllowedExtensions: (): Promise<IpcResponse<string[]>> =>
      ipcRenderer.invoke(IpcChannels.FILE_GET_ALLOWED_EXTENSIONS),

    // P0-06: 文件上传到 IM 平台
    uploadToIM: (args: { platform: string; filePath: string; channelId: string; targetUserId: string; accessToken?: string }): Promise<IpcResponse<any>> =>
      ipcRenderer.invoke(IpcChannels.FILE_UPLOAD_TO_IM, args),
    listSupportedPlatforms: (): Promise<IpcResponse<string[]>> =>
      ipcRenderer.invoke(IpcChannels.FILE_LIST_SUPPORTED_PLATFORMS)
  },

  // ========== 对话导出 ==========
  conversation: {
    export: (conversation: any, format: 'markdown' | 'pdf' | 'word', outputPath?: string): Promise<IpcResponse<{ filePath: string }>> =>
      ipcRenderer.invoke(IpcChannels.CONVERSATION_EXPORT, conversation, format, outputPath)
  },

  // ========== OpenClaw 核心执行引擎 ==========
  openclaw: {
    // 健康检查
    healthCheck: (): Promise<IpcResponse<{ healthy: boolean; status: string; version?: string; timestamp: number; error?: string }>> =>
      ipcRenderer.invoke(IpcChannels.OPENCLAW_HEALTH_CHECK),
    
    // 执行操作
    execute: (request: any): Promise<IpcResponse<any>> =>
      ipcRenderer.invoke(IpcChannels.OPENCLAW_EXECUTE, request),

    // 批量执行
    batchExecute: (request: any): Promise<IpcResponse<any>> =>
      ipcRenderer.invoke(IpcChannels.OPENCLAW_BATCH_EXECUTE, request),

    // 权限检查
    checkPermission: (request: any): Promise<IpcResponse<any>> =>
      ipcRenderer.invoke(IpcChannels.OPENCLAW_CHECK_PERMISSION, request),

    // 获取审计日志
    getAuditLogs: (limit?: number): Promise<IpcResponse<any[]>> =>
      ipcRenderer.invoke(IpcChannels.OPENCLAW_GET_AUDIT_LOGS, limit)
  },

  // ========== Hermes 记忆管理 ==========
  hermes: {
    getMemories: (): Promise<IpcResponse<any>> =>
      ipcRenderer.invoke(IpcChannels.HERMES_GET_MEMORIES),

    saveCoreMemory: (content: string): Promise<IpcResponse<void>> =>
      ipcRenderer.invoke(IpcChannels.HERMES_SAVE_CORE_MEMORY, content),

    /** 【M3-A】嵌入后端配置 —— 此前真后端代码在,但没有任何配置入口 */
    embedding: {
      get: (): Promise<IpcResponse<{ config: any; model: string; realVectors: boolean }>> =>
        ipcRenderer.invoke(IpcChannels.HERMES_EMBEDDING_GET),

      set: (cfg: { provider?: string; apiKey?: string; baseUrl?: string; model?: string }): Promise<IpcResponse<any>> =>
        ipcRenderer.invoke(IpcChannels.HERMES_EMBEDDING_SET, cfg),

      /** 探测本地 ollama:可达吗?装了哪些嵌入模型? */
      detect: (baseUrl?: string): Promise<IpcResponse<{ available: boolean; models: string[]; error?: string }>> =>
        ipcRenderer.invoke(IpcChannels.HERMES_EMBEDDING_DETECT, baseUrl),

      /** 探测后端可用性 + 语义是否成立(伪向量也"连得上",但召回是噪声) */
      test: (opts?: { provider?: string; baseUrl?: string; apiKey?: string; modelName?: string }): Promise<IpcResponse<any>> =>
        ipcRenderer.invoke(IpcChannels.HERMES_EMBEDDING_TEST, opts),
    }
  },

  // ========== 技能管理 ==========
  skills: {
      list: (): Promise<IpcResponse<any[]>> =>
        ipcRenderer.invoke(IpcChannels.SKILLS_LIST),

      toggle: (id: string, enabled: boolean): Promise<IpcResponse<boolean>> =>
        ipcRenderer.invoke(IpcChannels.SKILLS_TOGGLE, id, enabled),

      /** 【M4-B】效果判定列表(工具/技能的调用成败结论) */
      getEffectiveness: (): Promise<IpcResponse<any[]>> =>
        ipcRenderer.invoke(IpcChannels.SKILLS_GET_EFFECTIVENESS),

      /**
       * 【M4-E】跑一次技能效用对照实验(每个任务跑两遍:带/不带技能)。
       * **token 成本翻倍** —— 调用前须向用户说明。
       */
      runUtilityTrial: (payload: { skillId: string; tasks: Array<{ id: string; instruction: string; expectation?: any }>; enableJudge?: boolean }): Promise<IpcResponse<any>> =>
        ipcRenderer.invoke(IpcChannels.SKILLS_RUN_UTILITY_TRIAL, payload),

      /**
       * 【M4-X】在开源技能库里搜索。
       * 索引是本地缓存的 → **断网也能搜**(只有下载安装需要网络)。
       */
      hubSearch: (opts: { q?: string; sourceId?: string; category?: string; limit?: number }): Promise<IpcResponse<any[]>> =>
        ipcRenderer.invoke(IpcChannels.SKILLS_HUB_SEARCH, opts),

      /** 【M4-X】推荐可下载的技能(已装的不会重复推荐) */
      hubRecommend: (opts?: { limit?: number }): Promise<IpcResponse<{ items: any[]; index: any }>> =>
        ipcRenderer.invoke(IpcChannels.SKILLS_HUB_RECOMMEND, opts ?? {}),

      /** 【M4-X】刷新索引(联网抓取开源技能库) */
      hubRefresh: (): Promise<IpcResponse<any>> =>
        ipcRenderer.invoke(IpcChannels.SKILLS_HUB_REFRESH),

      /** 【M4-AC】安装前预览:列出包内文件与可执行脚本 */
      hubPreview: (id: string): Promise<IpcResponse<{ files: string[]; executables: string[] }>> =>
        ipcRenderer.invoke(IpcChannels.SKILLS_HUB_PREVIEW, { id }),

      /** 【M4-X】下载并安装一个技能 */
      hubInstall: (id: string): Promise<IpcResponse<any>> =>
        ipcRenderer.invoke(IpcChannels.SKILLS_HUB_INSTALL, { id }),

      /**
       * 【M4-V】查当前裁判能不能用(校准门禁)。
       * 界面用它决定"启用裁判对照"的勾选框能不能勾 —— 不通过时禁用并说明原因。
       */
      judgeTrust: (): Promise<IpcResponse<{ trusted: boolean; model: string; reason: string; basis?: string }>> =>
        ipcRenderer.invoke(IpcChannels.SKILLS_JUDGE_TRUST),

      /** 【M4-D】技能的边际效用(同类别任务下,带它 vs 不带它的成功率差) */
      getUtility: (): Promise<IpcResponse<any[]>> =>
        ipcRenderer.invoke(IpcChannels.SKILLS_GET_UTILITY),

      reload: (): Promise<IpcResponse<void>> =>
        ipcRenderer.invoke(IpcChannels.SKILLS_RELOAD),

      importFile: (filePath: string): Promise<IpcResponse<any>> =>
        ipcRenderer.invoke(IpcChannels.SKILLS_IMPORT_FILE, filePath),

      importUrl: (url: string): Promise<IpcResponse<any>> =>
        ipcRenderer.invoke(IpcChannels.SKILLS_IMPORT_URL, url),

      importZip: (zipPath: string): Promise<IpcResponse<any>> =>
        ipcRenderer.invoke(IpcChannels.SKILLS_IMPORT_ZIP, zipPath),

      importFolder: (sourcePath: string): Promise<IpcResponse<any>> =>
        ipcRenderer.invoke(IpcChannels.SKILLS_IMPORT_FOLDER, sourcePath),

      getDirectoryPreview: (dirPath: string): Promise<IpcResponse<any>> =>
        ipcRenderer.invoke(IpcChannels.SKILLS_GET_DIRECTORY_PREVIEW, dirPath),

      addCustomDir: (dirPath: string): Promise<IpcResponse<any>> =>
        ipcRenderer.invoke(IpcChannels.SKILLS_ADD_CUSTOM_DIR, dirPath),

      removeCustomDir: (dirPath: string): Promise<IpcResponse<any>> =>
        ipcRenderer.invoke(IpcChannels.SKILLS_REMOVE_CUSTOM_DIR, dirPath),

      getCustomDirs: (): Promise<IpcResponse<string[]>> =>
        ipcRenderer.invoke(IpcChannels.SKILLS_GET_CUSTOM_DIRS),

      getStorageInfo: (): Promise<IpcResponse<any>> =>
        ipcRenderer.invoke(IpcChannels.SKILLS_GET_STORAGE_INFO),

      mergeCandidates: (): Promise<IpcResponse<any[]>> =>
        ipcRenderer.invoke(IpcChannels.SKILLS_MERGE_CANDIDATES),

      performMerge: (skillId1: string, skillId2: string): Promise<IpcResponse<any>> =>
        ipcRenderer.invoke(IpcChannels.SKILLS_PERFORM_MERGE, skillId1, skillId2),

      remove: (skillId: string): Promise<IpcResponse<any>> =>
        ipcRenderer.invoke(IpcChannels.SKILLS_REMOVE, skillId)
    },

  // ========== MCP 配置管理 ==========
  mcp: {
    list: (): Promise<IpcResponse<any[]>> =>
      ipcRenderer.invoke(IpcChannels.MCP_LIST),

    add: (data: any): Promise<IpcResponse<any>> =>
      ipcRenderer.invoke(IpcChannels.MCP_ADD, data),

    update: (data: any): Promise<IpcResponse<any>> =>
      ipcRenderer.invoke(IpcChannels.MCP_UPDATE, data),

    remove: (name: string): Promise<IpcResponse<void>> =>
      ipcRenderer.invoke(IpcChannels.MCP_REMOVE, name),

    toggle: (name: string, enabled: boolean): Promise<IpcResponse<void>> =>
      ipcRenderer.invoke(IpcChannels.MCP_TOGGLE, name, enabled),

    test: (name: string): Promise<IpcResponse<void>> =>
      ipcRenderer.invoke(IpcChannels.MCP_TEST, name),

    // M1: 运行时
    startServer: (config: any): Promise<IpcResponse<any>> =>
      ipcRenderer.invoke(IpcChannels.MCP_START_SERVER, config),

    stopServer: (name: string): Promise<IpcResponse<void>> =>
      ipcRenderer.invoke(IpcChannels.MCP_STOP_SERVER, name),

    startAllEnabled: (): Promise<IpcResponse<any[]>> =>
      ipcRenderer.invoke(IpcChannels.MCP_START_ALL_ENABLED),

    stopAll: (): Promise<IpcResponse<void>> =>
      ipcRenderer.invoke(IpcChannels.MCP_STOP_ALL),

    listServers: (): Promise<IpcResponse<any[]>> =>
      ipcRenderer.invoke(IpcChannels.MCP_LIST_SERVERS),

    listTools: (): Promise<IpcResponse<Array<{ name: string; description: string; inputSchema: any; server: string }>>> =>
      ipcRenderer.invoke(IpcChannels.MCP_LIST_TOOLS),

    listToolsByServer: (): Promise<IpcResponse<Record<string, Array<{ name: string; description: string; inputSchema: any }>>>> =>
      ipcRenderer.invoke(IpcChannels.MCP_LIST_TOOLS_BY_SERVER),

    invoke: (payload: {
      server?: string;
      toolName?: string;
      qualifiedName?: string;
      args?: Record<string, unknown>;
    }): Promise<IpcResponse<{
      success: boolean;
      result?: any;
      error?: string;
      errorCode?: number;
      durationMs: number;
    }>> => ipcRenderer.invoke(IpcChannels.MCP_INVOKE, payload)
  },

  // ========== Hermes 学习统计 ==========
  learning: {
    /**
     * 【M4-F】上报用户对某条助手答复的接受度。
     * 用户点了「重新生成」= 明确不要;下一条消息含纠正词 = 不满意;
     * 含认可词 = 满意;都没命中 = unknown(**不猜**)。
     */
    recordAcceptance: (payload: { conversationId: string; messageId: string; verdict: 'accepted' | 'rejected' | 'unknown'; reason?: string }): Promise<IpcResponse<any>> =>
      ipcRenderer.invoke(IpcChannels.LEARNING_RECORD_ACCEPTANCE, payload),

    /** 【M4-F】按技能查接受度 */
    getAcceptance: (skillId?: string): Promise<IpcResponse<any>> =>
      ipcRenderer.invoke(IpcChannels.LEARNING_GET_ACCEPTANCE, skillId),

    getStats: (): Promise<IpcResponse<Record<string, number>>> =>
      ipcRenderer.invoke(IpcChannels.LEARNING_GET_STATS),

    reset: (): Promise<IpcResponse<void>> =>
      ipcRenderer.invoke(IpcChannels.LEARNING_RESET),

    saveSkillProposal: (proposal: any): Promise<IpcResponse<boolean>> =>
      ipcRenderer.invoke(IpcChannels.LEARNING_SAVE_SKILL_PROPOSAL, proposal),

    getPendingProposal: (): Promise<IpcResponse<any>> =>
      ipcRenderer.invoke(IpcChannels.LEARNING_GET_PENDING_PROPOSAL),

    clearPendingProposal: (): Promise<IpcResponse<void>> =>
      ipcRenderer.invoke(IpcChannels.LEARNING_CLEAR_PENDING_PROPOSAL),

    /**
     * 【M4-A 修复】订阅新技能提案。
     *
     * 此前 SkillsView 用 `window.require('electron').ipcRenderer` 订阅
     * 'skills:new-proposal',但渲染窗口是 contextIsolation: true +
     * nodeIntegration: false —— window.require 是 undefined,订阅永远注册不上,
     * 提案横幅永远不会出现。必须经 preload 暴露。
     */
    onNewProposal: (callback: (proposal: any) => void) => {
      const handler: IpcCallback = (_, proposal) => callback(proposal);
      ipcRenderer.on(IpcChannels.SKILLS_NEW_PROPOSAL, handler);
      return () => ipcRenderer.removeListener(IpcChannels.SKILLS_NEW_PROPOSAL, handler);
    }
  },

  // ========== Agent 能力域 (W3 新增) ==========
  agent: {
    think: (ctx: Record<string, unknown>): Promise<IpcResponse<{ action: string; payload: unknown; stub: boolean }>> =>
      ipcRenderer.invoke(IpcChannels.AGENT_THINK, ctx),
    spawn: (subtask: { instruction: string; parentTaskId?: string }): Promise<IpcResponse<{ id: string; stub: boolean }>> =>
      ipcRenderer.invoke(IpcChannels.AGENT_SPAWN, subtask),
    list: (): Promise<IpcResponse<any[]>> =>
      ipcRenderer.invoke(IpcChannels.AGENT_LIST)
  },

  // ========== Channel 能力域 (W3 新增) ==========
  channel: {
    list: (): Promise<IpcResponse<Array<{ id: string; name: string; healthy: boolean }>>> =>
      ipcRenderer.invoke(IpcChannels.CHANNEL_LIST),
    messageStats: (): Promise<IpcResponse<{
      total: number
      byChannel: Record<string, { in: number; out: number; total: number }>
      sinceMs: number
    }>> => ipcRenderer.invoke(IpcChannels.CHANNEL_MESSAGE_STATS),
    messageHistory: (opts?: { channelId?: string; limit?: number }): Promise<IpcResponse<any[]>> =>
      ipcRenderer.invoke(IpcChannels.CHANNEL_MESSAGE_HISTORY, opts || {}),

    // P0-04 路由规则
    routingList: (): Promise<IpcResponse<any[]>> => ipcRenderer.invoke(IpcChannels.ROUTING_LIST),
    routingAdd: (rule: any): Promise<IpcResponse<void>> => ipcRenderer.invoke(IpcChannels.ROUTING_ADD, rule),
    routingRemove: (id: string): Promise<IpcResponse<{ removed: boolean }>> =>
      ipcRenderer.invoke(IpcChannels.ROUTING_REMOVE, id),

    // P0-05 权限
    permissionList: (): Promise<IpcResponse<any[]>> => ipcRenderer.invoke(IpcChannels.PERMISSION_LIST),
    // P2-04 权限导入导出
    permissionExport: (): Promise<IpcResponse<string>> => ipcRenderer.invoke(IpcChannels.PERMISSION_EXPORT),
    permissionImport: (args: { json: string; mode?: 'merge' | 'replace' }): Promise<IpcResponse<any>> =>
      ipcRenderer.invoke(IpcChannels.PERMISSION_IMPORT, args),

    // ClawHub 远程仓库 (registry): 检查更新 / 一键安装
    clawhubRegistryList: (baseUrl?: string): Promise<IpcResponse<any[]>> =>
      ipcRenderer.invoke(IpcChannels.CLAWHUB_REGISTRY_LIST, baseUrl),
    clawhubRegistryInstall: (entryId: string, baseUrl?: string): Promise<IpcResponse<any>> =>
      ipcRenderer.invoke(IpcChannels.CLAWHUB_REGISTRY_INSTALL, entryId, baseUrl),

    // P1-08 模型评分
    modelRate: (args: any): Promise<IpcResponse<any>> => ipcRenderer.invoke(IpcChannels.MODEL_RATE, args),
    modelListRatings: (opts?: { modelId?: string }): Promise<IpcResponse<any[]>> =>
      ipcRenderer.invoke(IpcChannels.MODEL_LIST_RATINGS, opts || {}),
    modelGetStats: (): Promise<IpcResponse<any[]>> => ipcRenderer.invoke(IpcChannels.MODEL_GET_STATS),

    // P2-02 模型使用量
    modelUsageRecord: (args: { modelId: string; provider: string; tokens: number; cost: number }): Promise<IpcResponse<void>> =>
      ipcRenderer.invoke(IpcChannels.MODEL_USAGE_RECORD, args),
    modelUsageTop: (opts?: { n?: number; sortBy?: 'tokens' | 'cost' | 'calls' }): Promise<IpcResponse<any[]>> =>
      ipcRenderer.invoke(IpcChannels.MODEL_USAGE_TOP, opts || {}),
    modelUsageTotal: (): Promise<IpcResponse<any>> => ipcRenderer.invoke(IpcChannels.MODEL_USAGE_TOTAL),
    health: (channelId: string): Promise<IpcResponse<{ healthy: boolean; latencyMs: number; stub: boolean; channelId: string }>> =>
      ipcRenderer.invoke(IpcChannels.CHANNEL_HEALTH, channelId),
    send: (msg: { channelId: string; to: string; text?: string }): Promise<IpcResponse<{ messageId: string; stub: boolean }>> =>
      ipcRenderer.invoke(IpcChannels.CHANNEL_SEND, msg)
  },

  // ========== P7 Sandbox 能力域 (W3 新增) ==========
  sandbox: {
    detect: (): Promise<IpcResponse<{ platform: NodeJS.Platform; arch: string; dockerAvailable: boolean; sandboxRoot: string; stub: boolean }>> =>
      ipcRenderer.invoke(IpcChannels.SANDBOX_DETECT),
    run: (cmd: string, opts?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number }): Promise<IpcResponse<{ exitCode: number; stdout: string; stderr: string; durationMs: number; stub: boolean }>> =>
      ipcRenderer.invoke(IpcChannels.SANDBOX_RUN, cmd, opts),
    preview: (): Promise<IpcResponse<{ url: string; port: number; expiresAt: number; stub: boolean }>> =>
      ipcRenderer.invoke(IpcChannels.SANDBOX_PREVIEW),
    stop: (): Promise<IpcResponse<{ stub: boolean }>> =>
      ipcRenderer.invoke(IpcChannels.SANDBOX_STOP)
  },

  // ========== Insight 能力域 (W3 新增) ==========
  insight: {
    traceStart: (name: string, attrs?: Record<string, unknown>): Promise<IpcResponse<{ spanId: string; name: string; startMs: number; attrs: Record<string, unknown>; stub: boolean }>> =>
      ipcRenderer.invoke(IpcChannels.INSIGHT_TRACE_START, name, attrs),
    traceEnd: (spanId: string): Promise<IpcResponse<{ spanId: string; endMs: number; stub: boolean }>> =>
      ipcRenderer.invoke(IpcChannels.INSIGHT_TRACE_END, spanId),
    /**
     * 【M3-E】今日成本 —— 此前 handler 是**硬编码 0 的 stub**,
     * 而 CostTracker 一直在真实记账。现返回真数据。
     */
    costToday: (): Promise<IpcResponse<{
      totalCostUsd: number
      totalTokens: number
      totalInputTokens: number
      totalOutputTokens: number
      byModel: Record<string, number>
      recent: any[]
      stub: boolean
    }>> =>
      ipcRenderer.invoke(IpcChannels.INSIGHT_COST_TODAY),

    /** 【M4-H】已知定价(默认表 + 用户自定义) */
    getPricing: (): Promise<IpcResponse<any[]>> =>
      ipcRenderer.invoke(IpcChannels.INSIGHT_GET_PRICING),

    /** 【M4-H】给自己用的模型配单价(每 1k token 的美元价) */
    setPricing: (payload: { model: string; inputPer1kUsd: number; outputPer1kUsd: number }): Promise<IpcResponse<any>> =>
      ipcRenderer.invoke(IpcChannels.INSIGHT_SET_PRICING, payload),
  },

  // ========== W7.0.2: D5 录屏转技能 IPC ==========
  d5: {
    run: (input: { triggerPhrase: string; description?: string }): Promise<IpcResponse<{ ok: boolean; skillName?: string; frameCount?: number; durationMs?: number; error?: string }>> =>
      ipcRenderer.invoke(IpcChannels.D5_RUN, input)
  },

  // ========== W12.B: IM 账号配置 IPC ==========
  channelConfig: {
    get: (): Promise<IpcResponse<any[]>> => ipcRenderer.invoke(IpcChannels.CHANNEL_CONFIG_GET),
    save: (args: { platform: string; config: any }): Promise<IpcResponse<void>> => ipcRenderer.invoke(IpcChannels.CHANNEL_CONFIG_SAVE, args),
    test: (args: { platform: string; config: any }): Promise<IpcResponse<{ message: string }>> => ipcRenderer.invoke(IpcChannels.CHANNEL_CONFIG_TEST, args)
  },

  // ========== W13.A: 5 demo IPC ==========
  demo: {
    runD1: (args: { question: string; imageBase64?: string }): Promise<IpcResponse<any>> =>
      ipcRenderer.invoke(IpcChannels.D1_DEMO_RUN, args),
    runD2Prime: (args: { prompt: string; useWebContainer?: boolean }): Promise<IpcResponse<any>> =>
      ipcRenderer.invoke(IpcChannels.D2_PRIME_DEMO_RUN, args),
    runD3: (args: { userMessage: string; userId: string; channelId: string }): Promise<IpcResponse<any>> =>
      ipcRenderer.invoke(IpcChannels.D3_DEMO_RUN, args),
    runD5: (args: { triggerPhrase: string; description?: string }): Promise<IpcResponse<any>> =>
      ipcRenderer.invoke(IpcChannels.D5_DEMO_RUN, args),
    runA5: (args: { instruction: string; maxSteps?: number; autoExecute?: boolean }): Promise<IpcResponse<any>> =>
      ipcRenderer.invoke(IpcChannels.A5_DEMO_RUN, args)
  },

  // ========== W14.A: LLM provider config ==========
  llmConfig: {
    list: (): Promise<IpcResponse<Array<{ provider: string; apiKey?: string; enabled: boolean; defaultModel?: string; apiBaseUrl?: string; updatedAt: number }>>> =>
      ipcRenderer.invoke(IpcChannels.LLM_CONFIG_LIST),
    upsert: (args: { provider: 'openai' | 'anthropic' | 'zhipu'; apiKey?: string; defaultModel?: string; apiBaseUrl?: string; enabled: boolean }): Promise<IpcResponse<any>> =>
      ipcRenderer.invoke(IpcChannels.LLM_CONFIG_UPSERT, args),
    test: (args: { provider: 'openai' | 'anthropic' | 'zhipu'; prompt?: string }): Promise<IpcResponse<any>> =>
      ipcRenderer.invoke(IpcChannels.LLM_CONFIG_TEST, args),
    chat: (args: { messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>; model?: string; maxTokens?: number; provider?: 'openai' | 'anthropic' | 'zhipu' }): Promise<IpcResponse<any>> =>
      ipcRenderer.invoke(IpcChannels.LLM_CHAT, args)
  },

  // ========== W13: WebContainerRunner renderer bridge ==========
  webcontainer: {
    notifyRendererReady: () => ipcRenderer.invoke('webcontainer:renderer-ready')
  },

  // ========== NOVA #003-C · M2 — Boot handshake(第②笔, 纯追加) ==========
  //   渲染端 Chat 壳首帧后 → window.electronAPI.nova.notifyRendererReady()
  //   splash 内 click/keydown → window.electronAPI.nova.skip()
  nova: {
    notifyRendererReady: () => ipcRenderer.invoke(IpcChannels.NOVA_RENDERER_READY),
    skip: () => ipcRenderer.send(IpcChannels.NOVA_BOOT_SKIP),
    onBootEvent: (handler: (ev: Record<string, unknown>) => void) => {
      const wrapped = (_e: IpcRendererEvent, payload: Record<string, unknown>) => handler(payload);
      ipcRenderer.on(IpcChannels.NOVA_BOOT_EVENT, wrapped);
      return () => ipcRenderer.removeListener(IpcChannels.NOVA_BOOT_EVENT, wrapped);
    },
    // ========== NOVA #004-B · M3 — 联网搜索(第②笔, 纯追加) ==========
    // 入参: { query: string, count?: number, locale?: string }
    // 出参: { success: boolean, data?: SearchResult[], error?: string, code?: string, elapsedMs?: number }
    search: (q: { query: string; count?: number; locale?: string }) =>
      ipcRenderer.invoke(IpcChannels.NOVA_SEARCH, q),
    // ========== NOVA #005-B · M4 — 语音设置(第②笔, 纯追加) ==========
    // 入参: getSettings 无; setSettings(patch) patch = Partial<{ enabled / autoRead / rate / pitch / volume }>
    // 出参: { success: boolean, data?: VoiceSettings, error?: string }
    getSettings: (): Promise<IpcResponse<VoiceSettings>> =>
      ipcRenderer.invoke(IpcChannels.NOVA_VOICE_GET_SETTINGS),
    setSettings: (patch: Partial<VoiceSettings>): Promise<IpcResponse<VoiceSettings>> =>
      ipcRenderer.invoke(IpcChannels.NOVA_VOICE_SET_SETTINGS, patch),
  },

  // ========== Phase 4 Task 4: Auto-updater API ==========
  autoUpdater: {
    check: (): Promise<IpcResponse<{ version: string | null }>> =>
      ipcRenderer.invoke(IpcChannels.AUTO_UPDATER_CHECK),

    download: (): Promise<IpcResponse<void>> =>
      ipcRenderer.invoke(IpcChannels.AUTO_UPDATER_DOWNLOAD),

    install: (): Promise<IpcResponse<void>> =>
      ipcRenderer.invoke(IpcChannels.AUTO_UPDATER_INSTALL),

    getVersion: (): Promise<IpcResponse<string>> =>
      ipcRenderer.invoke(IpcChannels.AUTO_UPDATER_GET_VERSION),

    onUpdateAvailable: (callback: (data: { version: string; releaseDate?: string; releaseNotes?: string | null }) => void) => {
      const handler: IpcCallback = (_, data) => callback(data);
      ipcRenderer.on(IpcChannels.AUTO_UPDATER_ON_UPDATE_AVAILABLE, handler);
      return () => ipcRenderer.removeListener(IpcChannels.AUTO_UPDATER_ON_UPDATE_AVAILABLE, handler);
    },

    onUpdateDownloaded: (callback: (data: { version: string }) => void) => {
      const handler: IpcCallback = (_, data) => callback(data);
      ipcRenderer.on(IpcChannels.AUTO_UPDATER_ON_UPDATE_DOWNLOADED, handler);
      return () => ipcRenderer.removeListener(IpcChannels.AUTO_UPDATER_ON_UPDATE_DOWNLOADED, handler);
    },

    onError: (callback: (data: { message: string }) => void) => {
      const handler: IpcCallback = (_, data) => callback(data);
      ipcRenderer.on(IpcChannels.AUTO_UPDATER_ON_ERROR, handler);
      return () => ipcRenderer.removeListener(IpcChannels.AUTO_UPDATER_ON_ERROR, handler);
    }
  },

  // ========== 定时任务 Schedule ==========
  schedule: {
    list: (): Promise<IpcResponse<any[]>> => ipcRenderer.invoke(IpcChannels.SCHEDULE_LIST),
    add: (payload: any): Promise<IpcResponse<any>> => ipcRenderer.invoke(IpcChannels.SCHEDULE_ADD, payload),
    update: (payload: any): Promise<IpcResponse<any>> => ipcRenderer.invoke(IpcChannels.SCHEDULE_UPDATE, payload),
    remove: (id: string): Promise<IpcResponse<boolean>> => ipcRenderer.invoke(IpcChannels.SCHEDULE_REMOVE, id),
    setEnabled: (id: string, enabled: boolean): Promise<IpcResponse<boolean>> =>
      ipcRenderer.invoke(IpcChannels.SCHEDULE_SET_ENABLED, { id, enabled }),
    history: (taskId?: string): Promise<IpcResponse<any[]>> => ipcRenderer.invoke(IpcChannels.SCHEDULE_HISTORY, taskId)
  },

  // ========== 命令确认 (v3 #5 弹窗, #002-v3 步骤 2.6/2.7) ==========
  // 主进程经 BrowserWindow.webContents.send('command:confirm-request') 推送,
  // 渲染端 (Chat.vue 弹窗组件) 监听并回执。此处只暴露 IPC, 不暴露 UI 细节。
  command: {
    /** 订阅确认请求; 返回 unsubscribe。 */
    onConfirmRequest: (callback: (req: { opId: string; command: string; args: string[]; cwd?: string }) => void) => {
      const handler: IpcCallback = (_e, req) => callback(req);
      ipcRenderer.on(IpcChannels.COMMAND_CONFIRM_REQUEST, handler);
      return () => ipcRenderer.removeListener(IpcChannels.COMMAND_CONFIRM_REQUEST, handler);
    },
    /** 回执确认结果 (允许/拒绝)。 */
    replyConfirm: (opId: string, ok: boolean): void => {
      ipcRenderer.send(IpcChannels.COMMAND_CONFIRM_REPLY, { opId, ok });
    }
  }
};

// ========== 暴露API ==========

contextBridge.exposeInMainWorld('electronAPI', electronAPI);

// 类型声明
declare global {
  interface Window {
    electronAPI: typeof electronAPI;
  }
}
