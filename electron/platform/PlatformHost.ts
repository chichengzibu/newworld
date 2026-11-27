/**
 * New World - 平台能力抽象层(纯 TS,不依赖 Electron)
 *
 * 目的:把 core/ 对 electron `app` 的只读调用(getPath/getVersion/isPackaged/getAppPath)
 * 与生命周期调用(on/once/quit/whenReady/...)收敛到统一接口,使 core 层零 Electron 依赖
 * (Phase 2 解耦的核心)。各平台实现见 ElectronHost(标准 Electron)/ HarmonyHost(鸿蒙 PC)。
 *
 * 设计要点:
 * - 本文件及其配套 runtime.ts 绝不 import 'electron',否则 core 会经由此处
 *   间接引入 Electron。core 应只从 './platform/runtime' 取 getHost()。
 * - 平台专属能力(tray/shortcuts/updater/secureStorage)在"不支持时返回 null",
 *   调用方据此降级,不抛错、不阻断启动。
 */

export type PlatformId = 'win32' | 'darwin' | 'linux' | 'ohos'

/** 对应 electron app.getPath 支持的名称 */
export type AppPathName =
  | 'userData'
  | 'logs'
  | 'temp'
  | 'downloads'
  | 'desktop'
  | 'exe'
  | 'appData'
  | 'cache'

/** 应用生命周期事件(本项目实际使用子集) */
export type AppLifecycleEvent =
  | 'before-quit'
  | 'will-quit'
  | 'quit'
  | 'window-all-closed'
  | 'activate'
  | 'ready'
  | 'second-instance'
  | 'web-contents-created'

/** 生命周期监听器(参数随事件变化,用宽松签名) */
export type AppLifecycleListener = (...args: any[]) => void

/** relaunch 选项(对应 electron App.RelaunchOptions) */
export interface AppRelaunchOptions {
  args?: string[]
  execPath?: string
}

/** 托盘能力(不支持返回 null) */
export interface TrayCapability {
  create(): unknown
  setQuitting(v: boolean): void
  destroy(): void
}

/** 全局快捷键能力(不支持返回 null) */
export interface ShortcutCapability {
  registerAll(): void
  destroy(): void
}

/** 自动更新能力(不支持返回 null,如鸿蒙走应用商店) */
export interface UpdaterCapability {
  registerIpcHandlers(): void
  initialize(window: unknown): void
}

/** 安全存储能力(不支持返回 null) */
export interface SecureStorageCapability {
  encrypt(plain: string): string
  decrypt(cipher: string): string
}

/**
 * 平台能力统一接口。core 层只认这个接口,不认 electron。
 */
export interface PlatformHost {
  /** 平台标识 */
  platform(): PlatformId

  /** 对应 electron app.getPath */
  getPath(name: AppPathName): string

  /** 对应 electron app.getVersion */
  getVersion(): string

  /** 对应 electron app.isPackaged */
  isPackaged(): boolean

  /** 对应 electron app.getAppPath (应用资源/包目录) */
  getAppPath(): string

  /** 注册应用生命周期事件监听(对应 app.on) */
  on(event: AppLifecycleEvent, listener: AppLifecycleListener): void

  /** 单次生命周期事件监听(对应 app.once) */
  once(event: AppLifecycleEvent, listener: AppLifecycleListener): void

  /** 对应 app.quit() */
  quit(): void

  /** 对应 app.relaunch() */
  relaunch(options?: AppRelaunchOptions): void

  /** 对应 app.exit(code) */
  exit(code?: number): void

  /** 对应 app.whenReady() */
  whenReady(): Promise<void>

  /** 对应 app.isReady() */
  isReady(): boolean

  /** 托盘(鸿蒙 / 部分 Linux 桌面无托盘 → null) */
  tray(): TrayCapability | null

  /** 全局快捷键 */
  shortcuts(): ShortcutCapability | null

  /** 自动更新(鸿蒙走应用商店 → null) */
  updater(): UpdaterCapability | null

  /** 安全存储(无 keytar / 鸿蒙无等价物 → null) */
  secureStorage(): SecureStorageCapability | null
}
