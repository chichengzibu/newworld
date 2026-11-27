/**
 * New World - Agent 工具基础接口 (M1 v0.1)
 *
 * 跟 ClaudeCode 协议对齐: 每个 tool = { name, description, input_schema, execute() }.
 * 这是 In-process 的实现 (v0.1), 后续 M2 会拆到 MCP server 形式.
 */
import type { ToolMetadata } from '../AgentTypes'
import type { ContextKind } from './constants'

/** 工具执行结果 (与 ToolResult 不同: 这里只覆盖 {ok, result, error}, ToolResult 在 contracts/types 是 ok/data/error 命名) */
/** 【P3-补短】工具真实产出的文件 —— 路径/大小都来自落盘后的 stat，不是字符串承诺 */
export interface ProducedArtifact {
  path: string
  name: string
  mimeType: string
  size: number
  kind: 'document' | 'spreadsheet' | 'presentation' | 'other'
}

export interface ToolExecResult {
  ok: boolean
  /** 人类可读的结果内容,LLM 会读这个 */
  result: string
  /** 错误时填这个,LLM 也会读 */
  error?: string
  /**
   * 【M4-D】本次执行"作用在哪个实体上"。
   *
   * 【为什么需要】
   * 「技能被应用后到底有没有用」这个问题,前提是能说出【哪些技能被应用了】。
   * 但工具调用的日志里只有工具名 —— `load_skill` 是个工具名,不是技能 id,
   * 于是"应用了技能 A"这件事在数据里根本不存在,效用无从谈起。
   *
   * 【设计取舍:由工具自己报,不由脑去猜】
   * 让 brain 读 `args.skill_id` 是把工具的内部知识泄到编排层 ——
   * 每加一个作用于实体的工具,编排层就得改一次。
   * 由工具在返回值里声明"我动了什么",编排层只负责记录,零特殊-case。
   * 这也让机制对所有工具通用(未来"应用工作流""套用模板"同样适用)。
   */
  appliedEntity?: {
    /** 实体类别,如 'skill' */
    kind: string
    /** 实体标识,如技能 id */
    id: string
  }
  /** 真实落盘的文件清单；UI 据此生成可打开的产物卡片 */
  artifacts?: ProducedArtifact[]
}

/**
 * #005 Step 0 (DEV-014 机制切除): 工具执行上下文 — 显式贯穿, 禁模块态。
 * 链深: ChatManager → brain.think → brain.run → tool.execute, 逐跳携带, 无共享可变量;
 * 缺 ctx = 默认 headless (fail-safe 显式, 可 grep 审计)。
 * 预留 (本单不填值): runScope 字段供 DEV-023 审计关联接线批 (W5), 本单传 null。
 */
export interface RuntimeToolContext {
  /** 上下文类型 — 由已验证入口派生, 工具【绝不】从 LLM args 读 (v3 #4 红线保留) */
  contextKind: ContextKind
  /** 预留: run 溯源 (#006/#007 / DEV-023 接线批填值, 本单不读不写) */
  runScope?: { runId: string; parentRunId?: string } | null
  /**
   * 【M3-C】本次 run 的中止信号。
   *
   * 【为什么加】
   * 用户点「停止」时,此前只有 LLM 流被中止 —— **正在跑的命令不受影响**:
   * 它继续跑完(最长 60s),它起的孙进程继续跑(永久)。
   * 带上这个信号后,命令执行可以自己订阅中止 → 整棵树被杀。
   *
   * 【口径】可选:不传就是"不可中止"(旧行为)。brain 一定会传。
   */
  signal?: AbortSignal
  /**
   * 【M4-E】本次 run 里**被抑制**的技能 id 列表。
   *
   * 【为什么需要】
   * 「这个技能到底有没有用」要能被回答,前提是能做**配对对照**:
   * 同一个任务跑两遍 —— 一遍允许用该技能,一遍禁止用。
   * 而「禁止用」必须**真的禁止**:模型自己调 `load_skill` 就把对照做废了。
   * 所以抑制必须落到工具层,由工具自己拒绝。
   *
   * 【为什么放在 context 而不是全局】
   * 全局抑制集会串味 —— 两个会话同时跑,一个的对照实验会把另一个的技能也禁掉。
   * 随 run 传递(和 contextKind 同一套路)天然隔离。
   */
  suppressedSkills?: string[]
  /**
   * 【P3 多 agent 编排】本次 run 的并行子任务委派入口。
   * 由 LlmAgentBrain 在每次 run 构造 toolCtx 时注入闭包，捕获当前 run 的
   * model/provider/contextKind/AbortSignal —— 工具本身不持有 brain，零模块态。
   * 不传 = 工具明确拒绝（不伪造结果）。
   */
  delegate?: (instructions: string[]) => Promise<ToolExecResult>
}

/** 工具接口 */
export interface PiPiTool {
  /** ToolMetadata 用于注册到 ToolRegistry / 透传给 LLM */
  metadata: ToolMetadata
  /**
   * 真实执行, args 由 LLM tool_calls.function.arguments 解码得到.
   * @param ctx #005 Step 0: 可选执行上下文 (contextKind 显式贯穿); 缺省 = headless (fail-safe)
   */
  execute(args: Record<string, unknown>, ctx?: RuntimeToolContext): Promise<ToolExecResult>
}
