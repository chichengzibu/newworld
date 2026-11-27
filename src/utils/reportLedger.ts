/**
 * New World - 渲染错误 → 本地台账统一入口
 *
 * 此前这段逻辑私有在 src/main.ts 里，业务模块（Voice 等）无法复用，
 * 结果是错误只写 UI 状态、从不落盘。抽出来后：
 *   - main.ts 的全局钩子与业务模块共用同一条 IPC 路径；
 *   - 业务模块可传 kindOverride，让台账按领域区分（voice-unavailable 等）。
 *
 * 契约：台账失败绝不升级成新错误；不阻塞主流程。
 */
import { humanizeError } from './humanizeError'

export type LedgerKindOverride = string

/**
 * 【良性 window.error 白名单】
 * Chromium/Electron 的 `ResizeObserver loop completed with undelivered notifications`
 * （及 `limit exceeded` 变体）是社区公认的良性通知：回调内改了布局，下一帧自动
 * 收敛，功能完全正常。但它以 window.error 事件派发，若按普通错误处理会挂
 * 全屏「render error」红框，把整个应用伪装成崩溃（实测长对话列表布局变化时
 * 稳定触发）。只白名单这两条精确前缀，其余错误照常上报/挂屏。
 */
const BENIGN_WINDOW_ERROR_PATTERNS = [
  /^ResizeObserver loop (completed with undelivered notifications|limit exceeded)/,
]

export function isBenignWindowError(message: string | undefined | null): boolean {
  if (!message) return false
  return BENIGN_WINDOW_ERROR_PATTERNS.some((re) => re.test(message))
}

/**
 * @param source   来源标签，如 'voice:tts' / 'vue:<info>'，进入台账的 source 字段
 * @param err      原始错误或字符串
 * @param kindOverride 领域错误码；provider/业务自有分类优先于通用 humanizeError
 */
export function reportToLedger(source: string, err: unknown, kindOverride?: LedgerKindOverride): void {
  try {
    const realErr = err instanceof Error ? err : null
    const message = realErr?.message ?? String(err ?? '').slice(0, 300)
    const kind = kindOverride ?? (() => {
      try {
        return humanizeError(realErr ?? new Error(message)).kind
      } catch {
        return 'unclassified'
      }
    })()
    const api = (window as unknown as {
      electronAPI?: { errors?: { report?: (r: Record<string, unknown>) => Promise<unknown> } }
    }).electronAPI
    void api?.errors?.report?.({
      kind,
      message,
      source,
      stack: (realErr?.stack ?? '').slice(0, 2000) || undefined,
    })
  } catch {
    /* swallow: 台账失败不影响主流程 */
  }
}
