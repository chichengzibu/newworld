/**
 * New World - 平台宿主运行时容器(纯 TS,不依赖 Electron)
 *
 * 依赖注入容器:主进程启动时调用 setHost(initHost()) 注入具体实现,
 * core 层通过 getHost() 取用,从而 core 不直接 import electron。
 *
 * 注意:本文件只 import PlatformHost 类型(被擦除),不引入任何 Electron 代码。
 */

import type { PlatformHost } from './PlatformHost'

let active: PlatformHost | null = null

/** 注入当前平台宿主实现(主进程启动时调用一次) */
export function setHost(host: PlatformHost): void {
  active = host
}

/** 取当前平台宿主;未初始化时抛错(提示应先 initHost) */
export function getHost(): PlatformHost {
  if (!active) {
    throw new Error('[platform] PlatformHost 尚未初始化,请在主进程启动时调用 initHost()')
  }
  return active
}

/** 是否已注入宿主(供 core 在单测中判断) */
export function hasHost(): boolean {
  return active !== null
}
