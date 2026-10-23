/**
 * PiPiClaw - ContextEngine:上下文预算管理 (M2-A)
 *
 * 【为什么需要】
 * LlmAgentBrain.run() 的 messages 数组在单轮 run 内【只增不减】:
 * 每轮 LLM 返回的 assistant message + 每个工具的 tool 消息都无条件 push。
 * 配合 Read 工具单文件 200KB 上限,10 轮迭代极易撑爆模型上下文,
 * 而当前没有任何 token 计数 / 裁剪 / 压缩机制。
 *
 * 项目里 ErrorClassifier.ts:9 的注释写着 "context-overflow -> retry after
 * compressing",但压缩器从来不存在 —— 注释假定了本模块。
 *
 * 【设计原则:纯函数 + 无状态】
 * 与 RunCheckpointManager 同款风格:本模块不持有任何状态、不碰 fs、不引依赖,
 * 只提供 "给定 messages 和预算,返回应该送给 LLM 的 messages"。
 * 这样它可以被单测穷举,也可以在别处复用。
 *
 * 【三级降级】
 *   L1 裁剪:  丢弃最老的 tool 消息(工具原文是最大的token 黑洞)
 *   L2 摘要:  把被裁掉的历史压成一条摘要消息(保留决策与结论)
 *   L3 中止:  连摘要都放不下 → 中止 run,明确告知用户而非静默溢出
 *
 * token 估算:真实 usage 优先(模型返回的);无 usage 时按字符比例估算。
 * 估算不必精确 —— 它只用于决定何时触发降级,宁可早降级不可晚溢出。
 */

/** 与 LlmClient.types 的 LlmMessage 对齐(结构化子集,避免循环依赖) */
export interface ContextMessage {
  role: string
  content: string
  toolCalls?: unknown[]
  toolCallId?: string
  reasoningContent?: string
}

export interface ContextBudget {
  /** 模型上下文总容量 */
  total: number
  /** 给模型回复预留 */
  reserve: number
  /** 系统提示 + 工具 schema */
  system: number
  /** 对话历史配额 */
  history: number
  /** 工具返回配额(单独池 — 优先被淘汰,它们最占地方且最不重要) */
  toolResult: number
}

export const DEFAULT_BUDGET: ContextBudget = {
  total: 128_000,
  reserve: 16_000,
  system: 4_000,
  history: 60_000,
  toolResult: 48_000,
}

/** 降级阈值:达到可用容量的比例即触发对应动作 */
export const TRIM_THRESHOLD = 0.8
export const SUMMARIZE_THRESHOLD = 0.9

/** 估算 token 数。
 *  中英混排按 1 token ≈ 2.5 字符估(中文偏密,纯英文约 4)。
 *  这个估算只需"够用来判断何时该降级",不需要精确。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  // 快捷路径:纯 ASCII 且不含 CJK 时直接按 1/4 估,跳过逐字符扫描。
  // 工具返回值动辄几万字符,逐字符 for-of 在降级路径上会成为热点。
  // eslint-disable-next-line no-control-regex
  if (!/[^\x00-\x7F]/.test(text)) return Math.ceil(text.length / 4)
  let cjk = 0
  for (const ch of text) {
    const c = ch.codePointAt(0)!
    if (c >= 0x2e80 && c <= 0x9fff) cjk++   // CJK 统一表意
    else if (c >= 0xf900 && c <= 0xfaff) cjk++ // CJK 兼容
    else if (c >= 0xff00 && c <= 0xff60) cjk++ // 全角
  }
  const other = text.length - cjk
  return Math.ceil(cjk * 1.0 + other / 4)
}

export function estimateMessagesTokens(messages: ContextMessage[]): number {
  let sum = 0
  for (const m of messages) {
    // 每条消息有固定的结构开销(role / 分隔符 / tool_call 序列化)
    sum += 4 + estimateTokens(m.content ?? '')
    if (m.toolCalls?.length) sum += estimateTokens(JSON.stringify(m.toolCalls))
  }
  return sum
}

/** 当前预算下的可用容量 */
export function usableTokens(budget: ContextBudget = DEFAULT_BUDGET): number {
  return budget.total - budget.reserve - budget.system
}

export interface ContextPlan {
  /** 实际送给 LLM 的消息 */
  messages: ContextMessage[]
  /** 估算 token */
  estimatedTokens: number
  /** 触发的降级级别 */
  action: 'none' | 'trim' | 'summarize' | 'abort'
  /** 丢弃的 tool 消息条数 */
  trimmedToolMessages: number
  /** 丢弃的历史轮数 */
  trimmedTurns: number
  /** 人类可读的原因(用于事件与日志) */
  reason: string
}

/**
 * 计算该送给 LLM 的 messages。
 *
 * 铁律:
 *   1. system 消息永远保留第一条 —— 没有 system prompt 模型会跑偏
 *   2. 最后一条 user 消息永远保留 —— 那是当前任务
 *   3. assistant 与其 tool 结果必须成对处理 —— 孤立的 tool 消息会让
 *      部分 provider 直接报 400
 */
export function planContext(
  messages: ContextMessage[],
  budget: ContextBudget = DEFAULT_BUDGET,
): ContextPlan {
  if (messages.length === 0) {
    return {
      messages: [], estimatedTokens: 0, action: 'none',
      trimmedToolMessages: 0, trimmedTurns: 0, reason: '空上下文',
    }
  }

  const usable = usableTokens(budget)
  const total = estimateMessagesTokens(messages)
  const ratio = total / usable

  if (ratio < TRIM_THRESHOLD) {
    return {
      messages: [...messages], estimatedTokens: total, action: 'none',
      trimmedToolMessages: 0, trimmedTurns: 0, reason: '容量充足',
    }
  }

  // ── 索引分层:system / 历史 / 当前 user ──
  const system: ContextMessage[] = []
  const tail: ContextMessage[] = []
  const middle: ContextMessage[] = []
  let lastUserIdx = -1
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'user') lastUserIdx = i
  }
  for (let i = 0; i < messages.length; i++) {
    if (i === 0 && messages[i].role === 'system') system.push(messages[i])
    else if (lastUserIdx >= 0 && i >= lastUserIdx) tail.push(messages[i])
    else middle.push(messages[i])
  }

  let trimmedToolMessages = 0
  let trimmedTurns = 0
  const summaryNote: ContextMessage[] = []

  // ── L1/L2: 先淘汰 tool 消息(最占地方且最不重要) ──
  const fixedTokens =
    estimateMessagesTokens(system) +
    estimateMessagesTokens(tail) +
    budget.system - estimateMessagesTokens(system)  // system 预留补足
  const target = usable - Math.max(0, fixedTokens)

  const keptMiddle: ContextMessage[] = []
  let middleTokens = 0
  for (const m of middle) {
    const t = estimateMessagesTokens([m])
    // toolResult 配额单独判定:超了就丢
    if (m.role === 'tool' && middleTokens > budget.toolResult) {
      trimmedToolMessages++
      continue
    }
    keptMiddle.push(m)
    middleTokens += t
  }

  let action: ContextPlan['action'] = ratio >= SUMMARIZE_THRESHOLD ? 'summarize' : 'trim'

  // ── 仍超 → 按轮次裁剪最老的历史 ──
  // 增量维护 middleTokens(每轮只减去被移除部分的 token),避免每轮重算全文的 O(n²)。
  middleTokens = estimateMessagesTokens(keptMiddle)
  // 重试上限:防御性。若每轮 splice 都没真正减少长度(如数组全是 tool 消息),
  // 无上限的 while 会死循环 —— 这在长会话降级路径上是不可接受的。
  let guard = 0
  while (middleTokens > budget.history && keptMiddle.length > 0 && guard++ < keptMiddle.length * 2 + 8) {
    // 成对移除最早的一轮 assistant + 其 tool 结果,避免孤立 tool 消息
    const dropUpTo = keptMiddle.findIndex(m => m.role === 'assistant')
    let end: number
    if (dropUpTo === -1) {
      // 没有 assistant 锚点(异常结构):直接丢第一条,保证收敛
      end = 1
    } else {
      end = dropUpTo
      while (end < keptMiddle.length && keptMiddle[end].role !== 'assistant') end++
    }
    const removed = keptMiddle.splice(dropUpTo, end - dropUpTo)
    middleTokens -= estimateMessagesTokens(removed)
    if (middleTokens < 0) middleTokens = 0
    trimmedTurns++
  }

  // ── 仍超 → 摘要 ──
  if (middleTokens > budget.history && keptMiddle.length > 0) {
    const compressed = compressHistory(keptMiddle)
    summaryNote.push({
      role: 'user',
      content:
        `[历史摘要] 此前 ${trimmedTurns + keptMiddle.length} 轮交互已压缩。\n` +
        `用户诉求:${compressed.userIntent}\n` +
        `已完成:${compressed.done}\n` +
        `关键结论:${compressed.findings}`,
    })
    keptMiddle.length = 0
    action = 'summarize'
  }

  const finalMessages = [...system, ...summaryNote, ...keptMiddle, ...tail]
  const finalTokens = estimateMessagesTokens(finalMessages)

  // ── L3: 连 tail 都放不下(单条 user 消息就超限)→ 中止而非静默溢出 ──
  if (finalTokens > usable) {
    return {
      messages: [...system, ...tail], estimatedTokens: finalTokens, action: 'abort',
      trimmedToolMessages, trimmedTurns,
      reason:
        `单条消息即超出上下文容量(${finalTokens} > ${usable} tokens),` +
        `已裁掉全部中间历史;仍放不下时需中止并提示用户`,
    }
  }

  return {
    messages: finalMessages,
    estimatedTokens: finalTokens,
    action,
    trimmedToolMessages,
    trimmedTurns,
    reason: `触发${action === 'trim' ? '裁剪' : '摘要'}:${total} → ${finalTokens} tokens` +
      ` (丢弃 ${trimmedToolMessages} 条工具消息 / ${trimmedTurns} 轮历史)`,
  }
}

/** 把一段历史压成"用户诉求 + 已完成 + 关键结论"三要素。
 *  纯启发式(取首尾 + 工具名统计),不调 LLM —— 摘要本身不能引入新的失败点。 */
function compressHistory(history: ContextMessage[]): {
  userIntent: string; done: string; findings: string
} {
  const users = history.filter(m => m.role === 'user').map(m => m.content)
  const assistants = history.filter(m => m.role === 'assistant' && m.content).map(m => m.content)
  const toolNames = new Set<string>()
  for (const m of history) {
    for (const tc of (m.toolCalls ?? []) as Array<{ function?: { name?: string } }>) {
      if (tc?.function?.name) toolNames.add(tc.function.name)
    }
  }
  return {
    userIntent: users.length ? truncate(users[users.length - 1], 200) : '(未记录)',
    done: assistants.length ? truncate(assistants[assistants.length - 1], 200) : '(无助手回复)',
    findings: toolNames.size ? `用过工具:${Array.from(toolNames).join(', ')}` : '(无工具调用)',
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`
}