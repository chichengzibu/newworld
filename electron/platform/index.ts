/**
 * PiPiClaw - 平台宿主聚合入口
 *
 * 主进程启动时调用 initHost() 一次,依据 detectPlatformId() 选择
 * ElectronHost(标准 Electron)或 HarmonyHost(鸿蒙 PC),并注入运行时容器。
 *
 * 注意:本文件 import 了 ElectronHost(进而 import 'electron'),
 * 因此只能由主进程 / shell 层引入。core 层请直接 import './platform/runtime'
 * 取 getHost(),以避免间接引入 Electron。
 */

import type { PlatformHost } from './PlatformHost'
import { setHost } from './runtime'
import { detectPlatformId } from './detect'
import { ElectronHost } from './ElectronHost'
import { HarmonyHost } from './HarmonyHost'

/** 初始化并注入平台宿主(主进程启动时调用一次) */
export function initHost(): PlatformHost {
  const id = detectPlatformId()
  const host: PlatformHost = id === 'ohos' ? new HarmonyHost() : new ElectronHost()
  setHost(host)
  return host
}

export * from './PlatformHost'
export { getHost, setHost, hasHost } from './runtime'
export { detectPlatformId, isOhos } from './detect'
export { ElectronHost } from './ElectronHost'
export { HarmonyHost } from './HarmonyHost'
