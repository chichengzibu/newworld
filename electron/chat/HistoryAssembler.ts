/**
 * HistoryAssembler — 多轮记忆历史段组装 (#003-fix, DEV-020)
 *
 * 唯一实现, 两管道共用:
 *   管道A (活跃): ChatManager → InstructionGenerator.generateTaskSteps(history)
 *   管道B (休眠): 调用方 → LlmAgentBrain.run({history}) / think(ctx.history)
 *
 * 职责 = 把【会话真源消息】(main 侧 ChatConfig.conversations[id].messages)
 *   收敛成一段 LLM messages 历史 (user/assistant 交替, 从最老到最新),
 *   由调用方拼成 [system 恒首位, ...history, 当前user 恒末位]。
 *
 * ═══ 窗口 (ContextCompressor 是 #008 的活, 本层先用硬窗顶住) ═══
 *   - HISTORY_WINDOW_TURNS = 10  : 最多保留最近 10 轮 (turn=一个 user 消息 + 紧跟的 assistant)
 *   - HISTORY_MAX_CHARS  = 16000 : 历史 content 总字符上限, 超限从【最老 turn】起删
 *   (修记忆不许引入 token 爆炸新事故 — 加窗先行)
 *
 * ═══ 无状态 ═══
 *   纯函数, 不读 store / 不写模块态 (禁新增模块态红线)。
 *   会话状态归会话层 (ChatConfig 真源), brain/generator 只消费, 不自存 → #004 checkpoint 前提。
 *
 * ═══ 真源映射 (Step A' 已实证, 非硬编) ═══
 *   真源 = main 侧 ChatConfig.conversations.get(id).messages, 前 N-1 轮在此 (ChatConfig.ts:235/281 saveConfig)
 *   renderer Pinia 是镜像非真源; 兜底路径 handleNormalChat(ChatManager.ts:426-442) 已读此真源为证。
 */
export type HistoryRole = 'user' | 'assistant' | 'tool' | 'system'

/** 一条可入历史的消息 (结构兼容 ChatMessage / LlmMessage / openai message 的 role+content 子集) */
export interface HistoryMsg {
  role: string
  content: string
  /** 用于调用方排除当前轮 (sendMessage 先落当前 user 再拉历史, 防重复拼) */
  id?: string
  status?: string
}

export const HISTORY_WINDOW_TURNS = 10
export const HISTORY_MAX_CHARS = 16000

export interface AssembledMessage {
  role: HistoryRole
  content: string
}

/**
 * 从【真源消息列表】组装历史段。
 * @param messages       会话真源的消息 (按时间序, 最老→最新)
 * @param currentUserId  当前轮 user 消息 id (排除, 防调用方重复拼)
 * @param opts.maxTurns  覆盖窗口 (默认 HISTORY_WINDOW_TURNS)
 * @param opts.maxChars  覆盖字符上限 (默认 HISTORY_MAX_CHARS)
 * @returns 历史段 (user/assistant 交替, 从最老到最新; 助手轮次在场, 非 user 单声道)
 */
export class HistoryAssembler {
  static buildHistory(
    messages: HistoryMsg[],
    currentUserId?: string,
    opts: { maxTurns?: number; maxChars?: number } = {},
  ): AssembledMessage[] {
    const maxTurns = opts.maxTurns ?? HISTORY_WINDOW_TURNS
    const maxChars = opts.maxChars ?? HISTORY_MAX_CHARS

    if (!Array.isArray(messages) || messages.length === 0) return []

    // 1. 过滤有效消息: 只收 user/assistant(/tool), 有内容, 非 streaming 占位空壳
    const usable: AssembledMessage[] = messages
      .filter((m) => {
        if (!m || typeof m.content !== 'string') return false
        if (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'tool') return false
        if (m.status === 'streaming') return false
        if (m.id && m.id === currentUserId) return false        // 排除当前轮 user
        if (m.content.trim().length === 0) return false          // 空壳占位不入历史
        return true
      })
      .map((m) => ({ role: m.role as HistoryRole, content: m.content }))

    if (usable.length === 0) return []

    // 2. 按 turn 切 (一个 user 消息开启一轮, 直到下一个 user 消息前)
    const turns: AssembledMessage[][] = []
    let cur: AssembledMessage[] = []
    for (const m of usable) {
      if (m.role === 'user') {
        if (cur.length > 0) turns.push(cur)
        cur = []
      }
      cur.push(m)
    }
    if (cur.length > 0) turns.push(cur)

    // 3. 窗口: 保留最近 maxTurns 轮 (turns 是二维, 每轮 = user + 其 assistant)
    const kept = turns.slice(-maxTurns)
    // 每轮字符数 (该轮所有 message 的 content 之和)
    const turnChars = (t: AssembledMessage[]) => t.reduce((s, m) => s + m.content.length, 0)
    const flat = (ts: AssembledMessage[][]) => ts.flat()

    // 4. 字符上限: 从【最老 turn】起删, 直到总字符 <= maxChars, 但【至少保留 1 轮】
    //    (宁缺历史不丢当前上下文 — 若连最新一轮都超, 保留它, 交后续截断兜底)
    let keptTurns = [...kept]
    while (keptTurns.length > 1 && keptTurns.reduce((s, t) => s + turnChars(t), 0) > maxChars) {
      keptTurns = keptTurns.slice(1)
    }

    // 5. 展平
    let result = flat(keptTurns)

    // 6. 字符最终保护: 仍超 (单轮超大) → 从最老 message 逐条删, 至少留 1 条
    while (result.length > 1 && result.reduce((s, m) => s + m.content.length, 0) > maxChars) {
      result = result.slice(1)
    }

    return result
  }

  /** 便捷: 拼成 [system, ...history, user] 的完整 messages (system/user 由调用方给) */
  static compose(
    systemPrompt: string,
    history: AssembledMessage[],
    currentInstruction: string,
  ): Array<{ role: string; content: string }> {
    return [
      { role: 'system', content: systemPrompt },
      ...history,
      { role: 'user', content: currentInstruction },
    ]
  }
}
