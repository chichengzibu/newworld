/**
 * PiPiClaw - LlmAgentBrain v0.1 (M1)
 *
 * 真 tool call loop, 跟 ClaudeCode 对齐:
 *   - LLM 收到 user prompt + 5 tools (Read/Edit/Bash/Glob/Grep) schema
 *   - 模型决定调 tool → 我们解析 tool_calls → 跑工具 → 把 result 写回 messages
 *   - 循环 max 10 轮直到 LLM 给出无 tool_calls 的 final answer
 *   - 流式: LlmClient.streamChat 逐 chunk, 通过 LlmAgentBrainEventBus 推到 IPC
 *
 * 接入 ChatManager: ChatManager.registerAgent(LlmAgentBrain.getInstance())
 *   - 在 dispatchToAgent() 里 ctx.conversationId 传进来, 我们维护 per-conversation multi-turn state
 *   - 但 v0.1 我们用 call 模式: 每次 think() 都是独立一次 multi-turn run, 由 ChatManager 决定何时调
 */
import { LogManager } from '../core/LogManager'
import { LlmClient } from '../llm/LlmClient'
import { BUILTIN_TOOLS, toolsToLlmSchema } from './tools'
import { planContext, DEFAULT_BUDGET, type ContextBudget, type ContextMessage } from './ContextEngine'
import { ToolGate, type ToolGateDecision } from './ToolGate'
import { listMcpTools, syncMcpTools, MCP_NAME_SEPARATOR } from './McpToolAdapter'
import { RetryPolicy } from './RetryPolicy'
import type { PiPiTool, ToolExecResult } from './tools'
import type { LlmMessage, LlmToolCall, LlmStreamChunk } from '../llm/types'
import type { AgentBrain, AgentContext, Decision, ToolCall, ToolResult, SubTask, SubAgent } from '../contracts/types'

const MAX_ITERATIONS = 10
/** #005 spawn R2 钉: v1 一层深度上限 — 超限 throw (非静默降级); 递归 Swarm 进 backlog, 届时移 AgentConfig 批 */
const MAX_SPAWN_DEPTH = 1
const DEFAULT_MODEL = 'qwen3.5:9b' // M1 v0.1 default: 本地 ollama, tool-capable

const SYSTEM_PROMPT = `你是 PiPiClaw 代码助手 (M1 v0.1), 跟 ClaudeCode 一样能用 5 个工具:
- Read: 读文件 (file_path, encoding?)
- Edit: 精确编辑文件 (file_path, old_string, new_string, replace_all?)
- Bash: 跑命令 (command, args?, cwd?, timeout_ms?)
- Glob: 文件匹配 (pattern, cwd?)
- Grep: 内容搜索 (pattern, cwd?, include?)

工作准则:
1. 优先用工具拿真实数据, 不要靠记忆编
2. Edit 工具要求 old_string 唯一, 不唯一就报错让你加上下文
3. Bash 走白名单, 不在白名单的命令会拒绝
4. 任务完成直接给最终答复, 不要无谓地继续调工具
5. 答复简洁, 中文, 1-3 句能说清就不啰嗦
6. 路径默认是 sandbox 内 (用户数据隔离), 不要试图读 ~/.ssh 或 C:\\Windows`

/** 单次 think run 的事件回调 (供 IPC / ChatManager 订阅) */
export type LlmAgentEvent =
  | { type: 'run_start'; runId: string; prompt: string; tools: string[] }
  | { type: 'iteration'; runId: string; iter: number; message: string }
  | { type: 'tool_call'; runId: string; iter: number; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; runId: string; iter: number; name: string; ok: boolean; result: string; error?: string; durationMs: number }
  | { type: 'content_delta'; runId: string; iter: number; delta: string; accumulated: string }
  | { type: 'thinking_delta'; runId: string; iter: number; delta: string; accumulated: string }
  | { type: 'final_answer'; runId: string; content: string; iterations: number; totalDurationMs: number }
  | { type: 'run_error'; runId: string; error: string; iterations: number; totalDurationMs: number }
  | { type: 'run_aborted'; runId: string; iterations: number }

export type LlmAgentEventHandler = (e: LlmAgentEvent) => void

/**
 * ============ #004 run 层 checkpoint 事件 (append-only 流的事件类型, A1) ============
 * 由 brain(生产方)定义类型; 消费者 = RunCheckpointManager(纯函数, A1-A3)。
 * 依赖方向单向: manager `import type { ... } from './LlmAgentBrain'`;
 * brain 【不】 import 任何 manager 模块 / fs (接缝仅 opts.checkpoint 回调)。
 */
export interface RunSnapshotPayload {
  runId: string
  conversationId: string
  status: 'running' | 'interrupted' | 'finalized'
  iteration: number
  /** 含轮内工具结果 (恢复后 LLM 上下文完整, 非 user 单声道) */
  messages: LlmMessage[]
  /** run 内工具执行账 (name/ok/durationMs), 恢复后可续跑记账 */
  toolState: Array<{ name: string; ok: boolean; durationMs: number }>
  /** #005 spawn ⑥: 父 runId (子代理快照溯源; 父 run 快照无此字段) */
  parentRunId?: string
}
export type RunCheckpointEvent =
  | (RunSnapshotPayload & { type: 'run.snapshot' })
  | { type: 'run.status'; runId: string; conversationId: string; status: 'running' | 'interrupted' | 'finalized'; reason?: string; parentRunId?: string }

/**
 * #005 spawn (R1 工厂 + R3 单例保留): 新实例构造上下文。
 * R1 钉: 子代理 = 【新 LlmAgentBrain 实例】(独立 messages/runId), 禁 `brain: this` 自引用 (旧 stub 债已删)。
 * R3 钉: getInstance() 单例保留 (main.ts:217 类型面依赖); 子实例一律经 create() 工厂产出。
 */
export interface SpawnContext {
  /** 深度 (父=0); 子 = 父+1; 超过 MAX_SPAWN_DEPTH 的 spawn 调用立即 throw */
  depth: number
  /** 父 runId (子快照溯源 parentRunId; 审计 DEV-023 同点接线批消费) */
  parentRunId: string
  /** 父上下文类型 (Step 0 机制承载: 显式传递, 禁模块态/禁子自派生) */
  contextKind?: 'ui' | 'im_inbound' | 'scheduler' | 'headless'
  /** 父 checkpoint 钩子 (子继承 → 同一 append-only 流 + parentRunId 溯源; 不接线 = 子无钩子, 休眠态) */
  checkpointHook?: (ev: RunCheckpointEvent) => void
}

class LlmAgentBrainEventBus {
  private static instance: LlmAgentBrainEventBus
  private handlers: Set<LlmAgentEventHandler> = new Set()
  private constructor() {}
  static getInstance(): LlmAgentBrainEventBus {
    if (!LlmAgentBrainEventBus.instance) LlmAgentBrainEventBus.instance = new LlmAgentBrainEventBus()
    return LlmAgentBrainEventBus.instance
  }
  subscribe(h: LlmAgentEventHandler): () => void {
    this.handlers.add(h)
    return () => this.handlers.delete(h)
  }
  emit(e: LlmAgentEvent): void {
    for (const h of Array.from(this.handlers)) {
      try { h(e) } catch { /* noop */ }
    }
  }
}

export const LlmAgentBrainEvents = LlmAgentBrainEventBus.getInstance()

/** run 状态机 (供 agent:abort IPC 用) */
interface RunState {
  runId: string
  aborted: boolean
  controller: AbortController
}

export class LlmAgentBrain implements AgentBrain {
  private static instance: LlmAgentBrain
  private log = LogManager.getInstance()
  private llm = LlmClient.getInstance()
  private tools: Map<string, PiPiTool> = new Map()
  /**
   * 【M3-B】LLM 调用重试策略(带熔断器)。
   * 单例共享 —— 熔断器状态需跨 run 累积:某个 provider 持续不可用时,
   * 应当对所有会话生效,而不是每个 run 各撞一次墙。
   */
  private retryPolicy = new RetryPolicy()
  /** runId → state */
  private runs: Map<string, RunState> = new Map()
  /** #005 spawn: 出生上下文 (仅子实例持有; 父/单例为 undefined)。只读 — run 时显式下传, 不入脑内可变态 */
  private readonly spawnCtx?: SpawnContext

  private constructor(spawnCtx?: SpawnContext) {
    // 注册 5 工具 (父子同源 BUILTIN_TOOLS — 工具面零提权, spawn 案⑤)
    for (const t of BUILTIN_TOOLS) this.tools.set(t.metadata.name, t)
    this.spawnCtx = spawnCtx
    this.log.info(`LlmAgentBrain v0.1 初始化: ${this.tools.size} tools${spawnCtx ? ` (子代理 parent=${spawnCtx.parentRunId}, depth=${spawnCtx.depth})` : ' (单例)'}`)
  }

  /**
   * 【M3-A】把 MCP server 的工具同步进 agent 工具表。
   *
   * 此前 MCP 能力只在 IPC 层,LLM 完全看不到 —— 用户装了 MCP server 也白装。
   * 同步后 MCP 工具与内置工具走同一套 function calling / 权限门 / 可视化。
   *
   * 时机:由调用方(main 启动后 / MCP server 启停后)显式触发,
   * 不在构造器里做 —— 构造器不能 await,且 MCP server 此时可能还没起。
   *
   * 内置工具优先:同名时跳过 MCP 版本,避免第三方 server 意外覆盖核心能力。
   */
  public async syncMcpTools(): Promise<{ added: string[]; skipped: string[] }> {
    const mcpTools = await listMcpTools()
    const res = syncMcpTools(this.tools, mcpTools)
    if (res.added.length > 0) {
      this.log.info(`LlmAgentBrain: 已接入 ${res.added.length} 个 MCP 工具 (当前共 ${this.tools.size} 个)`)
    }
    return res
  }

  /** 移除某个 server 的全部 MCP 工具(server 停用时调用) */
  public removeMcpToolsOfServer(server: string): number {
    const prefix = `${server}${MCP_NAME_SEPARATOR}`
    let removed = 0
    for (const name of Array.from(this.tools.keys())) {
      if (name.startsWith(prefix)) {
        this.tools.delete(name)
        removed++
      }
    }
    if (removed > 0) this.log.info(`LlmAgentBrain: 已移除 server ${server} 的 ${removed} 个 MCP 工具`)
    return removed
  }

  public static getInstance(): LlmAgentBrain {
    if (!LlmAgentBrain.instance) LlmAgentBrain.instance = new LlmAgentBrain()
    return LlmAgentBrain.instance
  }

  /**
   * #005 spawn R3 钉: 工厂 — 子代理唯一构造入口 (单例 getInstance 保留, main.ts:217 依赖)。
   * 新实例 = 独立工具注册表 / 独立 runs Map (同 BUILTIN_TOOLS 源, 零提权)。
   */
  public static create(spawnCtx: SpawnContext): LlmAgentBrain {
    return new LlmAgentBrain(spawnCtx)
  }

  /** 列已注册 tool 的 metadata (供 agent:list-tools IPC 用) */
  listTools(): Array<{ name: string; description: string; parameters: Record<string, unknown>; requiresPermission: boolean }> {
    return Array.from(this.tools.values()).map(t => ({
      name: t.metadata.name,
      description: t.metadata.description,
      parameters: t.metadata.parametersJson,
      requiresPermission: t.metadata.requiresPermission,
    }))
  }

  /** 中止 run */
  abortRun(runId: string): boolean {
    const s = this.runs.get(runId)
    if (!s) return false
    s.aborted = true
    s.controller.abort()
    return true
  }

  /** list active runs (供 IPC 调试) */
  listActiveRuns(): string[] {
    return Array.from(this.runs.keys())
  }

  /**
   * 跑一次 multi-turn tool call loop.
   * @param prompt 用户输入
   * @param opts.runId 可选, 默认自动生成
   * @param opts.model 覆盖默认模型
   * @param opts.provider 覆盖 provider (默认 ollama → openai-compatible)
   * @param opts.tools tool 名白名单, 默认全部 5 个
   * @param opts.maxIterations 覆盖默认 10
   * @param opts.systemPrompt 覆盖默认 system prompt
   * @returns final answer + 总迭代数 + 总耗时
   */
  async run(prompt: string, opts: {
    runId?: string
    model?: string
    provider?: 'openai' | 'openai-compatible' | 'anthropic' | 'zhipu'
    tools?: string[]
    maxIterations?: number
    systemPrompt?: string
    apiBaseUrl?: string
    /** 多轮历史段 (可选) — 由会话层拉取真源后传入, 拼入 [system, ...history, 当前prompt]。
     *  brain 【不自存】历史 (保持无状态): history 归会话层, #004 checkpoint 才有明确快照对象 (DEV-020) */
    history?: Array<{ role: string; content: string }>
    /** #004: 会话 id — checkpoint 快照的归属键 (run 层, 对话层不入快照) */
    conversationId?: string
    /** #005 spawn (预算刹车): token 预算上限 — 由 usage chunk 聚合; 超限时停 tool 循环取最后 assistant
     *  为 final_answer + run_error 事件 (降级到 final, 不中断会话/不 throw)。缺省 = 不限 (本单不强加全局预算, spawn R1 裁决) */
    maxTokens?: number
    /** #005 spawn ⑥: 父 runId — 子 run 快照溯源 (RunCheckpointEvent.parentRunId 字段落事件流) */
    parentRunId?: string
    /** #005 Step 0 (DEV-014 切除): contextKind 显式贯穿 — 由入口 (ChatManager 派生值) 经 think→run 传入,
     *  逐跳携带到 tool.execute(ctx); brain 不自存 (无状态红线)。缺省 = headless (BashTool 侧 fail-safe)。 */
    contextKind?: 'ui' | 'im_inbound' | 'scheduler' | 'headless'
    /** #004: checkpoint 上推钩子 (纯函数 manager 的 append 入口; brain 零 fs 零 manager import)。
     *  接缝 4 处: 每工具结果落 messages 后 / abort 退出前 / 异常 throw 前 / final_answer。
     *  不传 = 不产生 checkpoint (休眠态, 与 history 参数同一模式); 钩子异常不得影响 run 主流程。 */
    checkpoint?: (ev: RunCheckpointEvent) => void
    /** #006.5 R-1 (休眠 brain 链, W5 接线后生效): 相关记忆上下文注入位 — 显式参数 (#003-fix 同模式,
     *  会话层派生经 opts 透传, brain 不自存 — 无状态红线; 字符串 = HermesAdapter.recall() 已渲染结果,
     *  本类零 HermesAdapter import / 零 embedText 调用 — 不新增外部依赖, 不引入模块态)。
     *  不传 = 不注入 (休眠态, 与 history 参数同一模式)。 */
    memoryContext?: string
    /**
     * 【M2-A】上下文预算 —— 覆盖默认的 DEFAULT_BUDGET(128k)。
     * 不同模型上下文窗口不同,小模型(如 8B 本地)必须给更小的预算,
     * 否则降级阈值形同虚设。缺省 = DEFAULT_BUDGET。
     */
    contextBudget?: ContextBudget
    /**
     * 【M2-B】工具权限确认桥 —— 由会话层(TUI/渲染层)注入。
     * 传入后,权限门在 contextKind==='ui' 时可弹窗向用户确认写操作。
     * 不传 = 无确认能力 → 权限门对 confirm 级工具一律拒绝(fail-safe)。
     * 绝不因为"没人确认"就默认放行 —— 那等于没装这道门。
     */
    requestToolConfirmation?: (toolName: string, prompt: string) => Promise<boolean>
    /**
     * 【M2-B】调用方声明写操作已预先授权 —— 用于无人值守但上层已授权的场景
     * (如用户为某个定时任务单独授权过)。
     *
     * 这是显式注入而非全局开关:生产调用方不传就是拒绝。
     * 曾考虑过 globalThis 形式的测试后门,因"任何人加一行赋值即可绕过
     * fail-safe"而废弃 —— 安全边界不能建立在约定上。
     */
    preApprovedToolConfirm?: boolean
  } = {}): Promise<{ runId: string; content: string; iterations: number; totalDurationMs: number; totalTokens: number; toolCalls: Array<{ name: string; ok: boolean; durationMs: number }> }> {
    const runId = opts.runId ?? `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const controller = new AbortController()
    const state: RunState = { runId, aborted: false, controller }
    this.runs.set(runId, state)

    const startMs = Date.now()
    const maxIter = opts.maxIterations ?? MAX_ITERATIONS
    // #006.5 R-1 (休眠 brain 链, W5 接线后生效): memoryContext 显式参数注入位 —
    //   与 history/checkpoint 同模式 (brain 无状态, 参数透传不自存);
    //   拼接为系统提示词的固定追加段 (非覆盖, 不改变 SYSTEM_PROMPT 本体)
    const systemPrompt = (opts.memoryContext && opts.memoryContext.trim())
      ? `${opts.systemPrompt ?? SYSTEM_PROMPT}\n\n相关记忆 (管线召回, stub 口径):\n${opts.memoryContext.trim()}`
      : (opts.systemPrompt ?? SYSTEM_PROMPT)
    const selectedToolNames = opts.tools ?? Array.from(this.tools.keys())
    const selectedTools = selectedToolNames
      .map(n => this.tools.get(n))
      .filter((t): t is PiPiTool => !!t)
    const toolCallsLog: Array<{ name: string; ok: boolean; durationMs: number }> = []

    LlmAgentBrainEvents.emit({ type: 'run_start', runId, prompt, tools: selectedToolNames })

    // DEV-020 修冷启动: 拼多轮历史段 [system, ...history, 当前prompt]
    //   history 由会话层提供 (brain 无状态, 不自存); 保持无状态 → #004 checkpoint 快照对象明确
    const historySeg: LlmMessage[] = (opts.history && opts.history.length > 0)
      ? (opts.history as Array<{ role: string; content: string }>).map((m) => ({
          role: (m.role as LlmMessage['role']),
          content: m.content,
        }))
      : []
    const messages: LlmMessage[] = [
      { role: 'system', content: systemPrompt },
      ...historySeg,
      { role: 'user', content: prompt },
    ]
    const llmSchema = toolsToLlmSchema(selectedTools)

    let finalContent = ''
    let iterations = 0
    const convId = opts.conversationId ?? 'unknown'
    // #005 spawn (预算隔离): usage 聚合 + 刹车判定 (run 局部变量, 无状态红线)
    let totalTokens = 0
    let budgetBraked = false
    const budgetCheck = (): boolean => {
      if (opts.maxTokens !== undefined && totalTokens >= opts.maxTokens && !budgetBraked) {
        budgetBraked = true
        this.log.warn(`LlmAgentBrain: run ${runId} token 预算刹车 (total=${totalTokens} >= max=${opts.maxTokens}) — 停 tool 循环取最后 assistant 为 final`)
        LlmAgentBrainEvents.emit({ type: 'run_error', runId, error: `token budget exceeded (${totalTokens} >= ${opts.maxTokens})`, iterations, totalDurationMs: Date.now() - startMs })
        return true
      }
      return false
    }
    // #004: checkpoint 安全推 — 钩子异常吞掉并记 log, 绝不影响 run 主流程 (红线)
    const pushCkpt = (ev: RunCheckpointEvent): void => {
      // #005 spawn ⑥: 子实例 opts 未显式传钩子时继承 spawnCtx.checkpointHook (同一 append-only 流, parentRunId 溯源)
      const hook = opts.checkpoint ?? this.spawnCtx?.checkpointHook
      try { hook?.(ev) } catch (e) { this.log.warn(`LlmAgentBrain: checkpoint 钩子异常(run 不受影响): ${e instanceof Error ? e.message : e}`) }
    }
    const parentRunId = opts.parentRunId ?? this.spawnCtx?.parentRunId
    const takeCkpt = (status: 'running' | 'interrupted' | 'finalized', reason?: string): RunCheckpointEvent =>
      status === 'interrupted'
        ? { type: 'run.status', runId, conversationId: convId, status, reason, ...(parentRunId ? { parentRunId } : {}) }
        : ({
            type: 'run.snapshot' as const,
            runId,
            conversationId: convId,
            status,
            iteration: iterations,
            messages: JSON.parse(JSON.stringify(messages)) as LlmMessage[], // 发送瞬间深拷贝 — brain tool-loop 后续 push 不污染快照 (#003-fix B-2 同款防御)
            toolState: [...toolCallsLog],
            ...(parentRunId ? { parentRunId } : {}), // #005 spawn ⑥: 子快照溯源 (类型层: RunSnapshotPayload 扩展位)
          })
    try {
      for (let iter = 1; iter <= maxIter; iter++) {
        if (state.aborted) {
          pushCkpt(takeCkpt('interrupted', 'aborted')) // #004 接缝②: 中止前 flush 当前态 (A2 append-only)
          LlmAgentBrainEvents.emit({ type: 'run_aborted', runId, iterations: iter - 1 })
          this.runs.delete(runId)
          return { runId, content: finalContent, iterations: iter - 1, totalDurationMs: Date.now() - startMs, totalTokens, toolCalls: toolCallsLog }
        }
        // #005 spawn (预算刹车): 每轮 LLM 调用前判定 — 超限即停 tool 循环,
        // 下方 maxIter 收尾块取【最后 assistant】为 final (降级到 final, 不 throw 不中断会话)
        if (budgetCheck()) break
        iterations = iter
        LlmAgentBrainEvents.emit({ type: 'iteration', runId, iter, message: `第 ${iter}/${maxIter} 轮` })

        /**
         * 【M2-A】上下文降级 —— 调 LLM 之前执行,而不是溢出之后补救。
         * messages 在 run 内单调增长,10 轮 × Read 单文件 200KB 必然撑爆,
         * 而部分 provider 遇到超限直接报错、整个 run 崩掉(且无可恢复路径)。
         * 三级降级由 ContextEngine 决策:裁剪 → 摘要 → 中止。
         */
        const ctxPlan = planContext(
          messages as unknown as ContextMessage[],
          opts.contextBudget ?? DEFAULT_BUDGET,
        );
        if (ctxPlan.action === 'abort') {
          this.log.warn(`LlmAgentBrain: run ${runId} 上下文超限无法降级 — ${ctxPlan.reason}`);
          LlmAgentBrainEvents.emit({
            type: 'run_error', runId, iterations,
            totalDurationMs: Date.now() - startMs,
            error: `上下文超出模型容量(${ctxPlan.reason})。请缩短单次输入,或分多步执行。`,
          });
          finalContent = finalContent
            || '这次的内容太长,超出模型能一次读完的量了。建议拆成几步,或者只把关键部分发给我。';
          pushCkpt(takeCkpt('finalized'));
          this.runs.delete(runId);
          return { runId, content: finalContent, iterations, totalDurationMs: Date.now() - startMs, totalTokens, toolCalls: toolCallsLog };
        }
        if (ctxPlan.action !== 'none') {
          this.log.info(`LlmAgentBrain: run ${runId} 上下文降级 — ${ctxPlan.reason}`);
          // 用裁剪后的副本喂 LLM,但【不回写 messages】:
          // messages 保持完整,checkpoint 快照与恢复逻辑仍能拿到全量上下文。
          // 每轮独立降级,不会累积丢失。
        }

        // 调 LLM (流式), 聚合 tool_calls + final content
        /**
         * 【M3-B】重试 + 退避 + 熔断。
         * 修复前: 单次 LLM 调用失败(429/5xx/网络抖动)整个多轮 run 直接崩,
         *   用户看到"执行失败",此前的工作全废。
         * 现在: 可重试错误走 full-jitter 退避重试(调研:3 次可捕获 97.3%
         *   瞬时故障);熔断器在持续失败时开闸,避免更快烧完配额。
         * 不可重试错误(400/401/403/404/422)直接失败,不浪费退避时间。
         */
        const result = await this.retryPolicy.execute(
          () => this.callLlmOnce(
            ctxPlan.messages as unknown as LlmMessage[],
            llmSchema, iter, runId, controller.signal, {
              provider: opts.provider,
              model: opts.model ?? DEFAULT_MODEL,
            },
          ),
          `llm-call iter=${iter}`,
        )
        // #005 spawn 预算: 聚合本轮 usage → run 级 totalTokens (budgetCheck 下轮前判定)
        if (typeof result.totalTokens === 'number') totalTokens += result.totalTokens

        // 把 assistant message 回写
        const assistantMsg: LlmMessage = { role: 'assistant', content: result.content }
        if (result.toolCalls.length > 0) assistantMsg.toolCalls = result.toolCalls
        if (result.reasoning) assistantMsg.reasoningContent = result.reasoning
        messages.push(assistantMsg)

        if (result.toolCalls.length === 0) {
          // 没有 tool call → final answer
          finalContent = result.content
          break
        }

        // 跑每个 tool, 把 result 写回 messages
        for (const tc of result.toolCalls) {
          if (state.aborted) break
          const tool = this.tools.get(tc.function.name)
          if (!tool) {
            const errResult = `unknown tool: ${tc.function.name}`
            LlmAgentBrainEvents.emit({ type: 'tool_result', runId, iter, name: tc.function.name, ok: false, result: '', error: errResult, durationMs: 0 })
            messages.push({ role: 'tool', content: `Error: ${errResult}`, toolCallId: tc.id })
            continue
          }
          let args: Record<string, unknown> = {}
          try {
            args = JSON.parse(tc.function.arguments || '{}')
          } catch (e) {
            const errResult = `arguments JSON parse error: ${(e as Error).message}`
            LlmAgentBrainEvents.emit({ type: 'tool_result', runId, iter, name: tc.function.name, ok: false, result: '', error: errResult, durationMs: 0 })
            messages.push({ role: 'tool', content: `Error: ${errResult}`, toolCallId: tc.id })
            continue
          }
          LlmAgentBrainEvents.emit({ type: 'tool_call', runId, iter, name: tc.function.name, args })
          const tStart = Date.now()
          let exec: ToolExecResult
          // #005 Step 0 (DEV-014 切除): contextKind 显式贯穿 — 禁脑读模块态 (全局态已删),
          // 本 run 的 ctx 由入口派生后经 think→run 携带; 子实例 (spawnCtx) 继承出生 ctx; 均无 → 'headless' (fail-safe)
          const toolCtx = { contextKind: opts.contextKind ?? this.spawnCtx?.contextKind ?? 'headless' }
          /**
           * 【M2-B】工具权限门 —— 修安全洞: EditTool 标注 requiresPermission:true
           * 但此前 run loop 从不读取该字段,写文件零确认。本门作为兜底层,
           * 确保任何新工具都不会"忘记检查"。
           * BashTool 自己的 commandDecide 更细(命令级白名单),这里只做前置兜底。
           */
          let gate: ToolGateDecision
          try {
            gate = await ToolGate.check(tool, args, toolCtx, {
              requestConfirmation: opts.requestToolConfirmation,
              ...(opts.preApprovedToolConfirm ? { preApproved: true } : {}),
            })
          } catch (e) {
            // 判定器本身异常 → 按拒绝处理(fail-safe)
            this.log.warn(`LlmAgentBrain: ToolGate 异常(${(e as Error).message}),按拒绝处理`)
            gate = { allowed: false, permission: 'deny', reason: '权限判定异常' }
          }
          if (!gate.allowed) {
            exec = { ok: false, result: '', error: `权限拒绝:${gate.reason}` }
            const gms = Date.now() - tStart
            toolCallsLog.push({ name: tc.function.name, ok: false, durationMs: gms })
            LlmAgentBrainEvents.emit({ type: 'tool_result', runId, iter, name: tc.function.name, ok: false, result: '', error: exec.error, durationMs: gms })
            messages.push({ role: 'tool', content: `Error: ${exec.error}`, toolCallId: tc.id })
            continue
          }
          try {
            exec = await tool.execute(args, toolCtx)
          } catch (e) {
            exec = { ok: false, result: '', error: `tool execution threw: ${(e as Error).message}` }
          }
          const durationMs = Date.now() - tStart
          toolCallsLog.push({ name: tc.function.name, ok: exec.ok, durationMs })
          LlmAgentBrainEvents.emit({ type: 'tool_result', runId, iter, name: tc.function.name, ok: exec.ok, result: exec.result, error: exec.error, durationMs })
          // tool 消息: OpenAI 格式用 content 字段, 部分 provider 也会读 name
          const toolContent = exec.ok ? exec.result : `Error: ${exec.error ?? 'unknown'}`
          messages.push({ role: 'tool', content: toolContent, toolCallId: tc.id })
          pushCkpt(takeCkpt('running')) // #004 接缝①: 每工具结果落 messages 后 upsert (running)
        }
      }

      if (!finalContent && (budgetBraked || iterations >= maxIter)) {
        // 预算超限 或 超过 max 轮 — 取最后一轮 assistant content (降级到 final, 不中断会话)
        const lastAssistant = messages.filter(m => m.role === 'assistant').pop()
        finalContent = lastAssistant?.content ?? ''
        // budgetBraked 时 run_error 已在 budgetCheck() 内 emit, 此处只补 max 轮场景
        if (!budgetBraked) {
          LlmAgentBrainEvents.emit({ type: 'run_error', runId, error: `超过 max iterations (${maxIter}), 强制结束`, iterations, totalDurationMs: Date.now() - startMs })
        }
      }

      const totalDurationMs = Date.now() - startMs
      LlmAgentBrainEvents.emit({ type: 'final_answer', runId, content: finalContent, iterations, totalDurationMs })
      pushCkpt(takeCkpt('finalized')) // #004 接缝④: 终态标记 (run 完整, 恢复时无需续跑)
      this.runs.delete(runId)
      return { runId, content: finalContent, iterations, totalDurationMs, totalTokens, toolCalls: toolCallsLog }
    } catch (e) {
      const totalDurationMs = Date.now() - startMs
      const errMsg = e instanceof Error ? e.message : String(e)
      LlmAgentBrainEvents.emit({ type: 'run_error', runId, error: errMsg, iterations, totalDurationMs })
      pushCkpt(takeCkpt('interrupted', `exception: ${errMsg}`)) // #004 接缝③: 异常 throw 前 flush (spec#5 "异常时 flush")
      this.runs.delete(runId)
      throw e
    }
  }

  /** 调一次 LLM, 聚合 stream chunks → { content, reasoning, toolCalls, error } */
  private async callLlmOnce(
    messages: LlmMessage[],
    llmSchema: ReturnType<typeof toolsToLlmSchema>,
    iter: number,
    runId: string,
    signal: AbortSignal,
    opts: { provider?: 'openai' | 'openai-compatible' | 'anthropic' | 'zhipu'; model: string }
  ): Promise<{ content: string; reasoning: string; toolCalls: LlmToolCall[]; error?: string; totalTokens?: number }> {
    const req = {
      model: opts.model,
      messages,
      tools: llmSchema,
      toolChoice: 'auto' as const,
      provider: opts.provider,
    }
    let content = ''
    let reasoning = ''
    let totalTokens = 0 // #005 spawn 预算刹车: usage chunk 聚合 (LlmClient:99-100 既有流面)
    const toolAcc: Map<number, LlmToolCall> = new Map()
    try {
      for await (const chunk of this.llm.streamChat(req, signal)) {
        const ch = chunk as LlmStreamChunk
        if (ch.type === 'content' && ch.delta) {
          content = ch.accumulated?.content ?? content + ch.delta
          LlmAgentBrainEvents.emit({ type: 'content_delta', runId, iter, delta: ch.delta, accumulated: content })
        } else if (ch.type === 'thinking' && ch.delta) {
          reasoning = ch.accumulated?.reasoning ?? reasoning + ch.delta
          LlmAgentBrainEvents.emit({ type: 'thinking_delta', runId, iter, delta: ch.delta, accumulated: reasoning })
        } else if (ch.type === 'tool_call' && ch.toolCall) {
          toolAcc.set(toolAcc.size, ch.toolCall)
        } else if (ch.type === 'usage' && ch.usage) {
          totalTokens = Math.max(totalTokens, ch.usage.totalTokens ?? 0)
        } else if (ch.type === 'error') {
          throw new Error(ch.error ?? 'unknown stream error')
        }
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        // 用户中止
      } else {
        throw e
      }
    }
    // 防御: 空响应 + 没 tool call → 至少把 content 设为空字符串, LLM 下一轮会想办法
    if (!content && toolAcc.size === 0) {
      this.log.warn(`LlmAgentBrain: iter ${iter} 完全空响应, 继续 next iter 兜底`)
    }
    return {
      content,
      reasoning,
      toolCalls: Array.from(toolAcc.values()),
      totalTokens,
    }
  }

  // ======== AgentBrain interface 兼容 (旧 ChatManager.registerAgent 走 dispatchToAgent) ========

  async think(ctx: AgentContext): Promise<Decision> {
    const content = typeof ctx.content === 'string' ? ctx.content : ''
    if (!content) {
      return { action: 'reply', payload: { text: '', model: '', durationMs: 0 } }
    }
    try {
      // DEV-020: think 内把会话层提供的 history 注入 run (brain 仍无状态, 只透传不自存)
      const history = (ctx as { history?: Array<{ role: string; content: string }> }).history
      // #004: 会话层可透传 checkpoint 钩子 (W5 接线时由 ChatManager 提供; ctx 索引签名已允许)
      const ckpt = (ctx as { checkpoint?: (ev: RunCheckpointEvent) => void }).checkpoint
      const runOpts: Parameters<typeof this.run>[1] = {}
      if (history) runOpts.history = history
      if (ckpt) runOpts.checkpoint = ckpt
      if (ctx.conversationId) runOpts.conversationId = String(ctx.conversationId)
      // 【W5 接线 · M1-C】会话层预分配的 runId:必须在 run() 生成默认 runId 之前透传,
      // 否则事件中继无法把 tool_call 关联回会话(brain 无状态,不持有 conversationId)。
      const callerRunId = (ctx as { runId?: string }).runId
      if (typeof callerRunId === 'string' && callerRunId.length > 0) runOpts.runId = callerRunId
      // #005 Step 0 (DEV-014 切除): contextKind 入口派生值透传 think→run→tool.execute(ctx)
      //   —— brain 不自存 (无状态红线); 会话层 (ChatManager) 是唯一派生源
      if (ctx.contextKind) runOpts.contextKind = ctx.contextKind as 'ui' | 'im_inbound' | 'scheduler' | 'headless'
      // #006.5 R-1: 会话层派生的相关记忆上下文 (已渲染字符串) 透传 think→run→systemPrompt 追加段。
      //   brain 不自存 / 零 HermesAdapter import (无状态红线 + 零新增依赖); 派生源归会话层 (与 contextKind 同模式)
      if (typeof ctx.memoryContext === 'string' && ctx.memoryContext.trim()) runOpts.memoryContext = ctx.memoryContext
      // 【M2-B】权限确认桥透传:缺省 = 权限门对写操作一律拒绝(fail-safe)
      const confirmBridge = (ctx as { requestToolConfirmation?: (tool: string, prompt: string) => Promise<boolean> }).requestToolConfirmation
      if (typeof confirmBridge === 'function') runOpts.requestToolConfirmation = confirmBridge
      // 【M2-B】预授权标记透传(与确认桥同模式,显式注入)
      if ((ctx as { preApprovedToolConfirm?: boolean }).preApprovedToolConfirm === true) {
        runOpts.preApprovedToolConfirm = true
      }
      const r = await this.run(content, runOpts)
      return { action: 'reply', payload: { text: r.content, model: 'agent-v0.1', durationMs: r.totalDurationMs, iterations: r.iterations, totalTokens: r.totalTokens, runId: r.runId, toolCalls: r.toolCalls } }
    } catch (e) {
      this.log.warn('LlmAgentBrain.think: fallback stub', e)
      return { action: 'reply', payload: { text: `[LlmAgentBrain error] ${(e as Error).message}`, model: 'agent-v0.1-stub', durationMs: 0 } }
    }
  }

  async call(tool: ToolCall): Promise<ToolResult> {
    const t = this.tools.get(tool.name)
    if (!t) return { ok: false, error: `unknown tool: ${tool.name}` }
    try {
      const r = await t.execute(tool.args)
      return { ok: r.ok, data: r.result, error: r.error }
    } catch (e) {
      return { ok: false, error: String((e as Error).message) }
    }
  }

  async spawn(subtask: SubTask, parentCtx?: { contextKind?: SpawnContext['contextKind']; parentRunId: string; checkpoint?: (ev: RunCheckpointEvent) => void }): Promise<SubAgent> {
    // #005 spawn R2 钉: 深度上限 MAX_SPAWN_DEPTH=1 — 子实例(带 spawnCtx)再 spawn 即超限, 立即 throw (非静默降级, 非静默降级到脑内递归)。
    // 用「是否已带出生上下文」判定, 不依赖 depth 计数字段 — 单例(undefined)=父允许, 子实例(有)=已达上限。
    if (this.spawnCtx !== undefined) {
      throw new Error(`LlmAgentBrain.spawn: 深度超限 (MAX_SPAWN_DEPTH=${MAX_SPAWN_DEPTH}) — 子代理禁止再 spawn [${subtask.instruction.slice(0, 30)}]`)
    }
    // #005 spawn R1 钉: 显式 parentCtx 必传 — 禁模块态/禁子自派生 (Step 0 机制贯穿的 spawn 面)。
    if (!parentCtx || typeof parentCtx.parentRunId !== 'string' || parentCtx.parentRunId.length === 0) {
      throw new Error('LlmAgentBrain.spawn: 缺 parentCtx — 需显式传 { parentRunId, contextKind?, checkpoint? } (禁模块态)')
    }
    // #005 spawn ① 独立性: 新实例 (独立 tools Map / runs Map, 同 BUILTIN_TOOLS 源零提权), 禁 brain:this 自引用 (旧 stub 债已删)。
    const child = LlmAgentBrain.create({
      depth: (this.spawnCtx?.depth ?? 0) + 1, // 父=0 → 子=1 (= MAX_SPAWN_DEPTH)
      parentRunId: parentCtx.parentRunId,
      contextKind: parentCtx.contextKind,
      checkpointHook: parentCtx.checkpoint,
    })
    const id = `llm-sub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    this.log.info(`LlmAgentBrain.spawn: 子实例 ${id} (parent=${parentCtx.parentRunId}, kind=${parentCtx.contextKind ?? 'headless'}) [${subtask.instruction.slice(0, 30)}]`)
    return { id, brain: child }
  }

  async checkpoint(): Promise<string> {
    // #004: run 层 checkpoint 由会话层经 opts.checkpoint 上推到 RunCheckpointManager (append-only 纯函数)。
    // 旧 stub (v0.1, 返回时间戳串、零调用者 — P1/P5 实证) 已删除; 契约接口保留 (AgentBrain, DEV-024)。
    throw new Error('LlmAgentBrain.checkpoint: 已废弃 — 使用会话层 opts.checkpoint 钩子 (#004)')
  }

  async restore(_id: string): Promise<void> {
    // #004: 恢复入口 = RunCheckpointManager.collectForRestore(dir, runId) → 重放 messages (纯读)。
    // 旧 stub (v0.1 no-op, 零调用者) 已删除; 契约接口保留 (AgentBrain, DEV-024)。
    throw new Error('LlmAgentBrain.restore: 已废弃 — 使用 RunCheckpointManager (#004)')
  }
}
