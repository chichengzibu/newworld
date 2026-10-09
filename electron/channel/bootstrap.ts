/**
 * PiPiClaw - Channel / bootstrap (W8)
 *
 * 应用启动时,把 IMConfigStore 中"已启用"的通道注册进 ChannelRouter,
 * 使 channel:send / healthCheckAll 等路径对全部 11 个通道可用。
 */

import { LogManager } from '../core/LogManager'
import { IMConfigStore } from './IMConfigStore'
import { ChannelRouter } from './ChannelRouter'
import { createChannelByKind, ALL_CHANNEL_KINDS } from './factory'

export function initChannels(): void {
  const log = LogManager.getInstance()
  const configStore = IMConfigStore.getInstance()
  const router = ChannelRouter.getInstance()
  let registered = 0
  for (const kind of ALL_CHANNEL_KINDS) {
    const cfg = configStore.get(kind)
    if (!cfg?.enabled) continue
    try {
      const channel = createChannelByKind(kind, kind)
      router.register(channel, {
        id: kind,
        kind,
        displayName: kind,
        enabled: true,
        priority: 0,
        configRef: kind,
      })
      registered++
    } catch (e) {
      log.warn(`initChannels: 注册 ${kind} 失败`, e)
    }
  }
  log.info(`initChannels: 共注册 ${registered} 个已启用通道`)
}
