/**
 * PiPiClaw - 标准 Electron 平台实现(win32 / darwin / linux)
 *
 * 把 electron `app` 的只读调用与生命周期调用桥接到 PlatformHost 接口。
 * 这是 Phase 2 解耦的"机械替换"落点:core 里原先的
 *   app.getPath(x) / app.getVersion() / app.isPackaged / app.getAppPath()
 *   app.on(...) / app.quit() / app.whenReady()
 * 改为
 *   getHost().getPath(x) / getHost().getVersion() / getHost().isPackaged() / getHost().getAppPath()
 *   getHost().on(...) / getHost().quit() / getHost().whenReady()
 *
 * 平台专属能力(tray/shortcuts/updater/secureStorage)本阶段返回 null;
 * 待 TrayManager / GlobalShortcut / AutoUpdater 迁移到宿主模式时再接真实实现。
 */

import { app } from 'electron'
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

export class ElectronHost implements PlatformHost {
  platform(): PlatformId {
    const p = process.platform as string
    if (p === 'win32' || p === 'darwin' || p === 'linux') return p as PlatformId
    return 'linux'
  }

  getPath(name: AppPathName): string {
    return app.getPath(name as Parameters<typeof app.getPath>[0])
  }

  getVersion(): string {
    return app.getVersion()
  }

  isPackaged(): boolean {
    return app.isPackaged
  }

  getAppPath(): string {
    return app.getAppPath()
  }

  // —— 生命周期 / 应用控制(直接委托 electron app) ——
  on(event: AppLifecycleEvent, listener: AppLifecycleListener): void {
    app.on(event as Parameters<typeof app.on>[0], listener as (...args: any[]) => void)
  }

  once(event: AppLifecycleEvent, listener: AppLifecycleListener): void {
    app.once(event as Parameters<typeof app.once>[0], listener as (...args: any[]) => void)
  }

  quit(): void {
    app.quit()
  }

  relaunch(options?: AppRelaunchOptions): void {
    app.relaunch(options)
  }

  exit(code?: number): void {
    app.exit(code ?? 0)
  }

  whenReady(): Promise<void> {
    return app.whenReady()
  }

  isReady(): boolean {
    return app.isReady()
  }

  // —— 以下能力本阶段返回 null,迁移 TrayManager/GlobalShortcut/AutoUpdater 后接入 ——
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
