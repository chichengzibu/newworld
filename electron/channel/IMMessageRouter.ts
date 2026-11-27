/**
 * New World - Channel / IMMessageRouter (W7.1)
 *
 * 收到一条消息 → permission + security + routing 决策。
 * 不直接调 Channel.send(),由 ChannelRouter 负责。
 */

import { LogManager } from '../core/LogManager'
import { EventBus } from '../runtime/bridge/EventBus'
import { IMMessageStore } from './IMMessageStore'
import { IMPermissionManager } from './IMPermissionManager'
import { IMSecurityManager } from './IMSecurityManager'
import type { ChannelKind, ProcessedMessage, RouteRule } from './ChannelTypes'
import type { ChannelMessage } from '../contracts/types'

export interface RouteDecision {
  allowed: boolean
  sanitized: boolean
  matchedRule?: RouteRule
  rejectReason?: string
  cleanContent?: string
}

/**
 * IMMessageRouter: 收到一条消息 → permission + security + routing 决策
 * 不直接调 Channel.send(),由 ChannelRouter 负责
 */
export class IMMessageRouter {
  private static instance: IMMessageRouter
  private log = LogManager.getInstance()
  private bus = EventBus.getInstance()
  private messageStore = IMMessageStore.getInstance()
  private permission = IMPermissionManager.getInstance()
  private security = IMSecurityManager.getInstance()
  private rules: RouteRule[] = []

  private constructor() {}

  public static getInstance(): IMMessageRouter {
    if (!IMMessageRouter.instance) IMMessageRouter.instance = new IMMessageRouter()
    return IMMessageRouter.instance
  }

  /** 新增或按 id 更新（UI 编辑规则走同一入口，避免重复 push 出多条同 id 规则） */
  addRule(rule: RouteRule): void {
    const idx = this.rules.findIndex(r => r.id === rule.id)
    if (idx >= 0) this.rules[idx] = rule
    else this.rules.push(rule)
    this.log.info(
      `IMMessageRouter: ${idx >= 0 ? '更新' : '新增'}规则 ${rule.id} (${rule.trigger} → ${rule.targetChannel})`,
    )
  }

  removeRule(id: string): boolean {
    const idx = this.rules.findIndex(r => r.id === id)
    if (idx < 0) return false
    this.rules.splice(idx, 1)
    return true
  }

  listRules(): RouteRule[] {
    return [...this.rules]
  }

  /** 处理一条收到的消息:permission + security + match route */
  async handleIncoming(
    channelId: string,
    channelKind: ChannelKind,
    msg: ChannelMessage,
  ): Promise<RouteDecision> {
    // 1. record
    this.messageStore.record(channelId, 'in', msg)
    // 2. permission
    const allowed = this.permission.isAllowed(msg, channelKind)
    if (!allowed) {
      void this.bus.publish('im:message:denied', { channelId, reason: 'permission' })
      return { allowed: false, sanitized: true, rejectReason: `permission denied for user ${msg.to}` }
    }
    // 3. security
    const processed: ProcessedMessage = this.security.process(msg, channelId)
    if (!processed.sanitized) {
      void this.bus.publish('im:message:denied', { channelId, reason: 'security' })
      return {
        allowed: true,
        sanitized: false,
        rejectReason: processed.rejectReason,
      }
    }
    // 4. match route rule
    const matched = this.matchRule(processed.cleanContent ?? '')
    if (!matched) {
      // 【IM 真连通】此前这里漏带 cleanContent，导致「无路由规则」时下游
      // InboundBridge 拿到空内容直接跳过 —— 默认回原通道的闭环根本走不通。
      // 无规则 ≠ 拒绝：仍要把清洗后的正文交给回复生成器。
      return {
        allowed: true,
        sanitized: true,
        cleanContent: processed.cleanContent,
        rejectReason: 'no matching route rule',
      }
    }
    return {
      allowed: true,
      sanitized: true,
      matchedRule: matched,
      cleanContent: processed.cleanContent,
    }
  }

  private matchRule(text: string): RouteRule | undefined {
    for (const rule of [...this.rules].sort((a, b) => b.priority - a.priority)) {
      if (!rule.enabled) continue
      try {
        const re = new RegExp(rule.trigger)
        if (re.test(text)) return rule
      } catch (e) {
        this.log.warn(`IMMessageRouter: rule ${rule.id} invalid regex ${rule.trigger}`, e)
      }
    }
    return undefined
  }
}