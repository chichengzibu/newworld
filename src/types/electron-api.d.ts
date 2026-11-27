/**
 * New World — window.electronAPI 全局类型声明(P0 工程规范批次)
 *
 * 【为什么存在】
 * 渲染端此前到处 `(window as any).electronAPI` —— IPC 面完全脱离类型检查。
 * 本文件把高频命名空间按 electron/preload.ts 的真实签名收编(e2e 里也用
 * 同名 mock, 签名一致), 其余低频命名空间由索引签名兜底, 允许渐进迁移:
 *   - 新代码: 直接 window.electronAPI.models.list() 拿到完整类型
 *   - 旧代码: (window as any) 的写法仍可用, 迁移一个删一个
 *
 * 【同步纪律】preload.ts 改签名时同步本文件 —— 由 PR 模板"涉及 IPC 的改动"项提醒。
 *   类型来源: electron/preload.ts(真源), 本文件是其渲染端投影。
 */

/** IPC 统一响应壳(与主进程 IpcServer 约定一致) */
export interface IpcResponse<T> {
  success: boolean
  data?: T
  error?: string
}

export interface ProviderConfig {
  id: string
  name: string
  type: string
  baseUrl?: string
  apiKey?: string
  enabled?: boolean
  timeout?: number
  models?: ModelInfo[]
  createdAt?: number
  updatedAt?: number
}

export interface ModelInfo {
  id: string
  name: string
  capabilities?: string[]
}

export interface ModelTestResult {
  ok: boolean
  latencyMs?: number
  error?: string
  model?: string
}

export interface Conversation {
  id: string
  title: string
  providerId?: string
  modelId?: string
  pinned?: boolean
  archived?: boolean
  createdAt?: number
  updatedAt?: number
}

/** agent 真实落盘的成品文件（主进程 stat 得到的真实值） */
export interface ProducedArtifact {
  path: string
  name: string
  mimeType: string
  size: number
  kind: 'document' | 'spreadsheet' | 'presentation' | 'other'
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  status?: 'sending' | 'streaming' | 'done' | 'error'
  error?: string
  providerId?: string
  modelId?: string
  timestamp?: number
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number; reasoningTokens?: number }
  /** 【P2】provider 真实回传的思考 token 数；未回传时不存在 */
  thinkingTokens?: number
  /** 本轮 agent 生成的成品，刷新后仍可点击打开 */
  artifacts?: ProducedArtifact[]
  [key: string]: unknown
}

export interface ChatSettings {
  [key: string]: unknown
}

/** 本地备份清单（主进程校验过 format/version） */
export interface BackupManifestInfo {
  format: string
  version: number
  createdAt: number
  appVersion: string
  includes: string[]
  apiKeysIncluded: boolean
  skillCount: number
}

export interface BackupInfo {
  fileName: string
  filePath: string
  createdAt: number
  size: number
  appVersion: string
  apiKeysIncluded: boolean
}

export interface BackupCreated {
  filePath: string
  size: number
  manifest: BackupManifestInfo
}

export interface BackupRestoreResult {
  manifest: BackupManifestInfo
  safetyBackupPath: string
  restored: string[]
  redactedKeys: number
  skillCount: number
}

/** 高频命名空间的精确签名(与 preload.ts 逐字对齐) */
export interface NWElectronAPI {
  // ========== 应用信息 ==========
  app: {
    /** app:version handler 返回 { success, data }，与 preload 真源一致 */
    getVersion: () => Promise<IpcResponse<string>>
    getPlatform: () => string
  }

  // ========== 错误台账(P0 工程规范可观测性) ==========
  errors: {
    report: (record: { kind?: string; message: string; source?: string; stack?: string }) =>
      Promise<{ success: boolean; error?: string }>
    summary: () => Promise<{ success: boolean; data?: { total: number; counts: Record<string, number>; recent: unknown[] }; error?: string }>
  }

  // ========== 模型管理 ==========
  models: {
    list: () => Promise<IpcResponse<ProviderConfig[]>>
    getTemplates: () => Promise<IpcResponse<Array<{ name: string; type: string; defaultConfig: Partial<ProviderConfig> }>>>
    get: (id: string) => Promise<IpcResponse<ProviderConfig>>
    add: (data: Omit<ProviderConfig, 'id' | 'createdAt' | 'updatedAt'>) => Promise<IpcResponse<ProviderConfig>>
    update: (id: string, updates: Partial<ProviderConfig>) => Promise<IpcResponse<ProviderConfig>>
    delete: (id: string) => Promise<IpcResponse<boolean>>
    toggle: (id: string, enabled: boolean) => Promise<IpcResponse<boolean>>
    test: (providerId: string, modelId?: string) => Promise<IpcResponse<ModelTestResult>>
    syncOllama: (providerId: string) => Promise<IpcResponse<ModelInfo[]>>
    fetch: (providerId: string) => Promise<IpcResponse<{ models: ModelInfo[]; error?: string }>>
  }

  // ========== 聊天管理 ==========
  chat: {
    conversations: () => Promise<IpcResponse<Conversation[]>>
    getConversation: (id: string) => Promise<IpcResponse<Conversation>>
    createConversation: (data?: { title?: string; providerId?: string; modelId?: string }) =>
      Promise<IpcResponse<Conversation>>
    updateConversation: (id: string, updates: Partial<Conversation>) => Promise<IpcResponse<Conversation>>
    deleteConversation: (id: string) => Promise<IpcResponse<boolean>>
    archiveConversation: (id: string) => Promise<IpcResponse<Conversation>>
    pinConversation: (id: string, pinned: boolean) => Promise<IpcResponse<Conversation>>
    sendMessage: (conversationId: string, content: string, providerId?: string, modelId?: string) =>
      Promise<IpcResponse<ChatMessage>>
    stopGeneration: (conversationId: string) => Promise<IpcResponse<void>>
    continueGeneration: (conversationId: string) => Promise<IpcResponse<void>>
    getLastModel: () => Promise<IpcResponse<{ providerId: string | null; modelId: string | null }>>
    getSettings: () => Promise<IpcResponse<ChatSettings>>
    updateSettings: (settings: Partial<ChatSettings>) => Promise<IpcResponse<ChatSettings>>
    /** 流式事件订阅(签名宽松: 事件种类多, 由主进程 payload 自描述) */
    onMessage: (callback: (data: { conversationId: string; message: ChatMessage }) => void) => void
    [key: string]: ((callback?: (...args: unknown[]) => void) => void) | unknown
  }

  // ========== 全局配置 ==========
  config: {
    get: (key: string) => Promise<IpcResponse<unknown>>
    set: (key: string, value: unknown) => Promise<IpcResponse<boolean>>
    getAll: () => Promise<IpcResponse<Record<string, unknown>>>
  }

  // ========== 对话框 ==========
  dialog: {
    openFile: (options?: unknown) => Promise<IpcResponse<{ path?: string; canceled?: boolean }>>
    saveFile: (options?: {
      title?: string
      defaultPath?: string
      filters?: Array<{ name: string; extensions: string[] }>
    }) => Promise<{ canceled: boolean; filePath?: string }>
  }

  // ========== 本地备份：配置/技能导出导入（无账号云同步） ==========
  backup: {
    create: (options?: { includeApiKeys?: boolean }) => Promise<IpcResponse<BackupCreated>>
    list: () => Promise<IpcResponse<BackupInfo[]>>
    restore: (filePath: string) => Promise<IpcResponse<BackupRestoreResult>>
    exportToFile: (filePath: string, options?: { includeApiKeys?: boolean }) => Promise<IpcResponse<BackupCreated>>
    exportSkills: (filePath: string) => Promise<IpcResponse<{ filePath: string; size: number; skillCount: number }>>
    copy: (sourcePath: string, targetPath: string) => Promise<IpcResponse<{ filePath: string; size: number }>>
    openFolder: () => Promise<IpcResponse<void>>
  }

  // ========== 成品文件打开 / 定位（主进程目录白名单校验） ==========
  file: {
    open: (filePath: string) => Promise<IpcResponse<{ path: string }>>
    showInFolder: (filePath: string) => Promise<IpcResponse<{ path: string }>>
  }

  // ========== 对话导出 ==========
  conversation: {
    export: (
      conversation: unknown,
      format: 'markdown' | 'pdf' | 'word',
      outputPath?: string,
    ) => Promise<IpcResponse<{ filePath: string; actualFormat?: string; degraded?: boolean }>>
  }

  // ========== 窗口管理 ==========
  window: {
    minimize: () => Promise<void>
    maximize: () => Promise<void>
    close: () => Promise<void>
    isMaximized: () => Promise<boolean>
    setAlwaysOnTop: (value: boolean) => Promise<void>
    isAlwaysOnTop: () => Promise<boolean>
    setEdgeHide: (value: boolean) => Promise<void>
    isEdgeHide: () => Promise<boolean>
    showMini: () => Promise<void>
    hideToTray: () => Promise<void>
    onMaximizeChange: (callback: (isMaximized: boolean) => void) => () => void
  }

  // ========== 任务执行预览（Chat.vue 消费） ==========
  task: {
    onPreview: (callback: (data: any) => void) => (() => void) | void
    [key: string]: unknown
  }

  // ========== 自动更新 ==========
  autoUpdater: {
    check: () => Promise<IpcResponse<{ version: string | null }>>
    download: () => Promise<IpcResponse<boolean>>
    install: () => Promise<IpcResponse<boolean>>
    getVersion: () => Promise<IpcResponse<string>>
    [key: string]: unknown
  }

  // ========== 沙箱 / 审批（M4.9 Codex 式双闸门）==========
  sandbox: {
    /** 读档位与自动审查配置 */
    getApprovalConfig: () => Promise<IpcResponse<{
      tier: 'read-only' | 'workspace' | 'full'
      autoReview: boolean
      limits: { maxConcurrent: number; maxMemoryMB: number; maxChildProcesses: number; sampleIntervalMs: number }
    }>>
    /** 改档位 / 自动审查 / 资源限额 */
    setApprovalConfig: (patch: {
      tier?: 'read-only' | 'workspace' | 'full'
      autoReview?: boolean
      limits?: Partial<{ maxConcurrent: number; maxMemoryMB: number; maxChildProcesses: number }>
    }) => Promise<IpcResponse<{ tier: string; autoReview: boolean }>>
    [key: string]: unknown
  }

  // ========== 渐进迁移兜底: 其余命名空间(skills/channel/gateway/nova/hermes/mcp/...) ==========
  // 未精确收编前保持 any-ish 调用可用; 收编一个就把签名挪进上面的接口。
  [key: string]: unknown
}

declare global {
  interface Window {
    electronAPI: NWElectronAPI
    /** 旧别名(部分 e2e/兼容代码使用) */
    newworld?: NWElectronAPI
  }
}

export {}
