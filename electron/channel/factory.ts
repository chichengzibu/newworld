/**
 * New World - Channel / factory (W8)
 *
 * 根据 ChannelKind 构造对应 Channel 实例。
 * 统一所有 11 个 IM 通道的实例化入口,供 channel-config:test 与启动注册使用。
 */

import type { Channel } from '../contracts/types'
import { FeishuChannel } from './FeishuChannel'
import { DingTalkChannel } from './DingTalkChannel'
import { WechatWorkChannel } from './WechatWorkChannel'
import { WeChatChannel } from './WeChatChannel'
import { QQChannel } from './QQChannel'
import { TelegramChannel } from './TelegramChannel'
import { SlackChannel } from './SlackChannel'
import { DiscordChannel } from './DiscordChannel'
import { WhatsAppChannel } from './WhatsAppChannel'
import { LarkChannel } from './LarkChannel'
import { RocketChannel } from './RocketChannel'
import type { ChannelKind as Kind } from './ChannelTypes'

export function createChannelByKind(kind: Kind, id?: string): Channel {
  switch (kind) {
    case 'im-feishu': return new FeishuChannel(id)
    case 'im-dingtalk': return new DingTalkChannel(id)
    case 'im-wechat-work': return new WechatWorkChannel(id)
    case 'im-wechat': return new WeChatChannel(id)
    case 'im-qq': return new QQChannel(id)
    case 'im-telegram': return new TelegramChannel(id)
    case 'im-slack': return new SlackChannel(id)
    case 'im-discord': return new DiscordChannel(id)
    case 'im-whatsapp': return new WhatsAppChannel(id)
    case 'im-lark': return new LarkChannel(id)
    case 'im-rocket': return new RocketChannel(id)
    default:
      throw new Error(`createChannelByKind: unknown kind ${kind}`)
  }
}

/** 全部支持的通道种类 */
export const ALL_CHANNEL_KINDS: Kind[] = [
  'im-feishu',
  'im-dingtalk',
  'im-wechat-work',
  'im-wechat',
  'im-qq',
  'im-telegram',
  'im-slack',
  'im-discord',
  'im-whatsapp',
  'im-lark',
  'im-rocket',
]
