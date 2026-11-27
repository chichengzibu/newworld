/**
 * New World - 联网搜索开关（v4.8）
 *
 * 语义对齐 ChatGPT / Claude / WorkBuddy：联网搜索是一个「给模型用的能力开关」，
 * 不是让用户自己输关键词的页面。开关状态存 ConfigStore 的 `nova.webSearch.enabled`，
 * 默认关闭（尊重隐私与成本；用户开启即视为授权模型联网检索）。
 *
 * 与 nova:search 手动搜索页的区别：那个页面仍保留（查看/复制结果），但模型是否
 * 能看到 web_search 工具由这里的开关决定。
 */
import { ConfigStore } from '../core/ConfigStore'

const KEY = 'nova.webSearch.enabled'

/** 默认关闭：模型默认不联网，用户显式开启才授权 */
export function isWebSearchEnabled(): boolean {
  try {
    const v = ConfigStore.getInstance().get(KEY)
    return v === true
  } catch {
    return false
  }
}

export function setWebSearchEnabled(enabled: boolean): boolean {
  try {
    ConfigStore.getInstance().set(KEY, !!enabled)
    return true
  } catch {
    return false
  }
}

export function getWebSearchSettings(): { enabled: boolean } {
  return { enabled: isWebSearchEnabled() }
}
