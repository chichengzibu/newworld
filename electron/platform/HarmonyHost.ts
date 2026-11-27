/**
 * New World - 鸿蒙 PC(HarmonyOS PC)平台实现
 *
 * 鸿蒙 PC 走华为提供的 Electron 适配运行时(ArkWeb 渲染,NAPI 原生扩展,HAP 包)。
 * 由于无 keytar / 无系统托盘 / 无标准 autoUpdater,相关能力返回 null 由调用方降级。
 *
 * 本文件不 import 'electron'(鸿蒙运行时虽兼容 electron API,但核心路径用 node 原生即可),
 * 仅依赖 node:path / node:os / node:events,保证可在非 Electron 环境单测。
 *
 * 生命周期:鸿蒙无 app 事件总线,用 EventEmitter + process 信号桥接 before-quit/quit,
 * 使 core/shell 通过 getHost().on(...) 注册的生命周期监听在鸿蒙下也能被触发。
 */

import { join } from 'node:path'
import { homedir } from 'node:os'
import { EventEmitter } from 'node:events'
import type {
  PlatformHost,
  PlatformId,
  AppPathName,
  AppLifecycleEvent,
  AppLifecycleListener,
  AppRelaunchOptions,
  TrayCapability,
  ShortcutCapability,
  UpdaterCapability,
  SecureStorageCapability,
} from './PlatformHost'

export class HarmonyHost implements PlatformHost {
  private bus = new EventEmitter()

  constructor() {
    // 鸿蒙无 app 事件总线,用 process 信号桥接生命周期事件
    process.on('SIGINT', () => this.bus.emit('before-quit'))
    process.on('SIGTERM', () => this.bus.emit('before-quit'))
  }

  platform(): PlatformId {
    return 'ohos'
  }

  private base(): string {
    return process.env.NW_USER_DATA ?? join(homedir(), '.nw-ohos')
  }

  getPath(name: AppPathName): string {
    const base = this.base()
    switch (name) {
      case 'userData':
        return base
      case 'logs':
        return join(base, 'logs')
      case 'cache':
        return join(base, 'cache')
      case 'temp':
        return process.env.TMPDIR ?? '/tmp'
      case 'downloads':
        return join(homedir(), 'Downloads')
      case 'exe':
      case 'appData':
      default:
        return base
    }
  }

  getVersion(): string {
    return process.env.NW_VERSION ?? '0.0.0'
  }

  isPackaged(): boolean {
    return true
  }

  getAppPath(): string {
    return process.env.NW_APP_PATH ?? join(this.base(), 'app')
  }

  // —— 生命周期 / 应用控制(鸿蒙用 EventEmitter + process) ——
  on(event: AppLifecycleEvent, listener: AppLifecycleListener): void {
    this.bus.on(event, listener)
  }

  once(event: AppLifecycleEvent, listener: AppLifecycleListener): void {
    this.bus.once(event, listener)
  }

  quit(): void {
    this.bus.emit('before-quit')
    this.bus.emit('quit')
    process.exit(0)
  }

  relaunch(_options?: AppRelaunchOptions): void {
    // 鸿蒙无标准 relaunch,记录后退出,由启动器负责重启
    console.warn('[HarmonyHost] relaunch 在鸿蒙环境为 no-op,由启动器重启')
    this.bus.emit('before-quit')
    process.exit(0)
  }

  exit(code = 0): void {
    this.bus.emit('quit')
    process.exit(code)
  }

  whenReady(): Promise<void> {
    return Promise.resolve()
  }

  isReady(): boolean {
    return true
  }

  // 鸿蒙 PC:无系统托盘 / 无全局快捷键 / 走应用商店更新 / 无 keytar 等价物
  tray(): TrayCapability | null {
    return null
  }

  shortcuts(): ShortcutCapability | null {
    return null
  }

  updater(): UpdaterCapability | null {
    return null
  }

  secureStorage(): SecureStorageCapability | null {
    return null
  }
}
