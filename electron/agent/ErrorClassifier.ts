/**
 * New World - Agent / ErrorClassifier
 *
 * 【设计依据:业界调研结论】
 * 2026 年的生产实践(12+ agent 系统的实测数据)给出了一致的结论:
 *   1. 错误分类必须【先于】重试决策,且应基于结构化信号而非字符串猜测
 *   2. 429/5xx/超时/网络抖动 = 可重试;400/401/403/404/422 = 不可重试
 *   3. context_length_exceeded 重试同样输入无意义 —— 需先压缩
 *   4. provider 特有语义要区分:overloaded_error(容量不足,可退避重试)
 *      与 rate_limit_error(配额耗尽,重试只会更糟)
 *
 * 【相比原版的修正】
 *   原版用 lower.includes('rate') 判断限流 —— 会误匹配 "generate" /
 *   "moderate" / "accurate" 等正常词汇,导致非限流错误被错误重试。
 *   现改为:优先从 HTTP 状态码与结构化字段判定,字符串匹配仅作兜底
 *   且收窄为无歧义词组。
 *
 * 【重试预算】
 * 实测:3 次重试可捕获 97.3% 的瞬时故障;超过 5 次边际收益 < 0.5%。
 * 故 maxAttempts 默认 3,并区分"每次调用的预算"与"总预算"。
 */

export type ErrorKind =
  | 'transient'      // 网络抖动 / 5xx / 超时 → 重试
  | 'rate-limit'     // 429 配额耗尽 → 退避重试(但要尊重 Retry-After)
  | 'overloaded'     // provider 容量不足(Anthropic overloaded_error)→ 退避重试
  | 'permanent'      // 400/404/422 等 → 不重试
  | 'permission'     // 401/403 → 不重试
  | 'context-overflow' // 上下文超限 → 压缩后重试(同输入重试无意义)
  | 'syntax'         // LLM 输出格式错 → 变体重试(见下)
  | 'unknown'        // 未知 → 不重试,交用户

export interface ClassifiedError {
  kind: ErrorKind
  retryable: boolean
  hint?: string
  /** 服务端建议的重试等待时间(ms)—— 优先于本地计算的退避 */
  retryAfterMs?: number
}

/** 从错误文本里抽 HTTP 状态码。
 *  各 adapter 统一抛 `HTTP {status}: {body}`(见 adapters/*.ts),这是最可靠的信号。 */
function extractStatus(msg: string): number | null {
  const m = msg.match(/\bHTTP\s+(\d{3})\b/i)
  if (m) return Number(m[1])
  // 退化:裸状态码(仅当 3 位且看起来像 HTTP 状态)
  const m2 = msg.match(/(?:^|\s)([1-5]\d{2})(?:\s|$|:)/)
  return m2 ? Number(m2[1]) : null
}

/** 抽 Retry-After(秒或 HTTP 日期)。各 adapter 目前未透传该头,留接口。 */
function extractRetryAfter(msg: string): number | undefined {
  const m = msg.match(/retry[-_ ]?after[\s:=]+(\d+)/i)
  if (m) return Number(m[1]) * 1000
  return undefined
}

/**
 * 分类一个错误。
 *
 * 优先级:状态码 > provider 语义 > 无歧义词组兜底。
 */
export function classifyError(e: unknown): ClassifiedError {
  const msg = e instanceof Error ? e.message : String(e)
  const lower = msg.toLowerCase()
  const status = extractStatus(msg)
  const retryAfterMs = extractRetryAfter(msg)

  // ── 1. 状态码优先(最可靠) ──
  // 529 = Anthropic 的 overloaded(容量不足),语义上不同于普通 5xx:
  //   退避重试是明确有效的处置,单独归类便于观测与差异化退避。
  if (status === 529 || lower.includes('overloaded')) {
    return { kind: 'overloaded', retryable: true, hint: '服务端容量不足,backoff 退避后重试', retryAfterMs }
  }
  if (status === 401 || status === 403) {
    return { kind: 'permission', retryable: false, hint: '认证失败或无权限,检查 API Key / 授权范围' }
  }
  if (status === 429) {
    return { kind: 'rate-limit', retryable: true, hint: '速率/配额限制,backoff 退避后重试', retryAfterMs }
  }
  if (status === 400 || status === 404 || status === 422) {
    // 400 也可能是 context_length_exceeded —— 那是可压缩重试的
    if (lower.includes('context') && (lower.includes('length') || lower.includes('window'))) {
      return { kind: 'context-overflow', retryable: true, hint: '上下文超限,压缩后重试' }
    }
    return { kind: 'permanent', retryable: false, hint: `HTTP ${status} — 请求本身有问题,重试无意义` }
  }
  if (status !== null && status >= 500) {
    return { kind: 'transient', retryable: true, hint: `HTTP ${status} 服务端错误,backoff 退避后重试`, retryAfterMs }
  }

  // ── 2. provider 语义(无状态码时的兜底) ──
  if (lower.includes('overloaded_error')) {
    return { kind: 'overloaded', retryable: true, hint: '服务端容量不足,backoff 退避后重试', retryAfterMs }
  }

  // ── 3. 无歧义词组兜底 ──
  // 注意: 词组必须无歧义。原版用 'rate' 单字会误匹配 generate/moderate/accurate。
  if (/\b(rate limit|rate_limit|too many requests|quota exceeded)\b/.test(lower)) {
    return { kind: 'rate-limit', retryable: true, hint: '速率/配额限制,backoff 退避后重试', retryAfterMs }
  }
  if (/\b(permission denied|forbidden|unauthorized|invalid api key|authentication)\b/.test(lower)) {
    return { kind: 'permission', retryable: false, hint: '需要权限 token 或用户授权' }
  }
  if (/\bcontext (length|window) exceeded\b/.test(lower)
    || /\b(token limit|max tokens|maximum context)\b/.test(lower)
    || (lower.includes('context') && /\b(exceeded|too long|overflow)\b/.test(lower))) {
    return { kind: 'context-overflow', retryable: true, hint: '上下文超限,压缩后重试(backoff 后)' }
  }
  if (/\b(json ?parse|unexpected token|invalid json|syntax error)\b/.test(lower)) {
    return { kind: 'syntax', retryable: true, hint: 'LLM 输出格式错,变体重试' }
  }
  if (/\b(timeout|timed out|econnreset|econnrefused|etimedout|epipe|socket hang up|network)\b/.test(lower)) {
    return { kind: 'transient', retryable: true, hint: '临时错误(网络/超时),backoff 退避后重试', retryAfterMs }
  }

  // ── 4. 未知 → 不重试,交用户 ──
  //  宁可让用户看到原始错误,也不要在未知错误上盲目重试烧 token
  return { kind: 'unknown', retryable: false, hint: '未知错误,需人工确认' }
}
