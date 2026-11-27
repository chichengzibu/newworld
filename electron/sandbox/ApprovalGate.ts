/**
 * New World — ApprovalGate（审批双闸门 · Codex 式）
 * ═══════════════════════════════════════════════════════════════
 * 【Codex 的设计精髓】
 * Codex 把"能碰什么"和"什么时候要问"分成两道独立的闸门：
 *   · **沙箱（sandbox）**决定技术边界：能写哪些路径、能否联网
 *   · **审批（approval）**决定交互策略：哪些操作停下来问人
 *
 * 两者正交 —— 同一个沙箱档位，可以配不同审批策略（问你 / 自动 / 全放开）。
 *
 * 本项目此前只有一道闸门（`decideCommand` 的 AUTO/CONFIRM/deny），
 * 且是**非黑即白**：白名单外的命令直接 deny，用户改配置才能用。
 * 缺的正是 Codex 那层"越界就问你"。
 *
 * 【本模块补什么】
 *   ① **三档沙箱档位**（对齐 Codex）
 *        read-only   —— 只读，任何写操作/命令执行都拒
 *        workspace   —— 工作区内可读写可执行，区外需审批（默认）
 *        full        —— 不受限（仅建议在受控环境）
 *
 *   ② **自动审查子代理**（Codex 的 auto-review）
 *        对于"需要确认"的操作，先用一个轻量模型判断风险：
 *        低风险（如 `mkdir ./tmp`）自动放行，高风险才真正打断用户。
 *        这解决了"每步都弹窗导致用户直接点同意"的审批疲劳问题 ——
 *        审批疲劳比没有审批更危险。
 *
 * 【自动审查的红线】
 *   · **只降级，不升级**：它只能把 confirm 变成 auto，永远不能把 deny 变成允许
 *   · 删库/改系统/外传数据这类**硬禁区永不自动放行**（关键词硬拦截优先于模型判断）
 *   · 模型不可用时一律回退为"要人确认"（fail-safe）
 *   · 每次自动放行都写审计，用户可回溯
 */

import { LogManager } from '../core/LogManager'
import { ConfigStore } from '../core/ConfigStore'
import { LlmClient } from '../llm/LlmClient'
import { ModelManager } from '../models/ModelManager'
import { LlmConfigStore } from '../llm/LlmConfigStore'
import { ChatConfig } from '../chat/ChatConfig'
import type { LlmProvider } from '../llm/types'

/** 沙箱档位（对齐 Codex 的 read-only / workspace-write / danger-full-access） */
export type SandboxTier = 'read-only' | 'workspace' | 'full'

/** 审批评级 */
export type ApprovalVerdict =
  | { kind: 'auto-allow'; reason: string }
  | { kind: 'need-human'; reason: string }
  | { kind: 'block'; reason: string }

const SANDBOX_TIER_KEY = 'agent.sandbox-tier'
const AUTO_REVIEW_KEY = 'agent.auto-review'

/** 自动审查的硬禁区 —— 这些东西无论模型怎么说都不许自动放行 */
const HARD_BLOCK_PATTERNS: RegExp[] = [
  // 删库 / 格式化
  /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/i,
  /\bmkfs\b/i,
  /\bformat\s+[a-z]:/i,
  /\bdd\s+if=/i,
  // Windows 系统目录
  /\b(C:\\Windows|C:\/Windows)\b/i,
  // 提权 / 权限破坏
  /\bicacls\b.*\/(grant|deny)\b/i,
  /\bchmod\s+777\b/i,
  /\bsudo\b/i,
  // 外传数据（配合网络白名单一起挡）
  /\b(scp|rsync)\b.*@/i,
  /\bcurl\b.*\|\s*(ba)?sh\b/i,
  /\bwget\b.*\|\s*(ba)?sh\b/i,
  // 注册表/服务
  /\breg\s+(add|delete)\b/i,
  /\b(sc|net)\s+stop\b/i,
]

const REVIEW_TIMEOUT_MS = 12_000

const SYSTEM_PROMPT = `你是命令安全审查器。判断这条命令是否可以自动放行（不打断用户）。

判定标准：
- **可以放行**：只读查询、在工作目录内创建/修改文件、运行常规开发工具（npm/pnpm/git/python/node）、构建、测试、格式化。
- **必须人工确认**：写入工作区外的路径、访问外部网络、修改系统配置、安装全局软件包、删除目录、修改用户级配置（PATH/环境变量/注册表）。
- **必须拒绝**：删除系统文件、格式化磁盘、提权、把数据发往外部服务器、下载并直接执行远程脚本。

只返回 JSON：
{"verdict":"allow"|"ask"|"deny","reason":"一句话中文理由","risk":"low"|"medium"|"high"}`

export class ApprovalGate {
  private static instance: ApprovalGate
  private log = LogManager.getInstance()
  private configStore = ConfigStore.getInstance()

  private constructor() {}

  public static getInstance(): ApprovalGate {
    if (!ApprovalGate.instance) ApprovalGate.instance = new ApprovalGate()
    return ApprovalGate.instance
  }

  // ── 档位读写 ──────────────────────────────────────────────
  getSandboxTier(): SandboxTier {
    try {
      const v = this.configStore.get(SANDBOX_TIER_KEY)
      if (v === 'read-only' || v === 'workspace' || v === 'full') return v
    } catch {
      /* 读失败用默认 */
    }
    return 'workspace'
  }

  setSandboxTier(tier: SandboxTier): void {
    this.configStore.set(SANDBOX_TIER_KEY, tier)
    this.log.info(`[ApprovalGate] 沙箱档位 → ${tier}`)
  }

  isAutoReviewEnabled(): boolean {
    try {
      const v = this.configStore.get(AUTO_REVIEW_KEY)
      return v === true
    } catch {
      return false
    }
  }

  setAutoReview(enabled: boolean): void {
    this.configStore.set(AUTO_REVIEW_KEY, enabled)
    this.log.info(`[ApprovalGate] 自动审查 → ${enabled}`)
  }

  // ── 档位对命令的预判 ────────────────────────────────────────
  /**
   * 按档位判断这条命令是否根本不该执行。
   *
   * read-only：只允许纯查询类命令，任何写操作直接拒
   * workspace：交由下游的 cwd 白名单与网络白名单处理
   * full：不额外限制
   */
  precheckByTier(command: string, args: readonly string[]): ApprovalVerdict | null {
    const tier = this.getSandboxTier()
    if (tier === 'full') return null

    if (tier === 'read-only') {
      const cmd = String(command ?? '').toLowerCase().replace(/\.exe$/i, '')
      // 只读白名单：查询、查看、搜索
      const readOnlyCmds = new Set([
        'ls', 'dir', 'cat', 'type', 'head', 'tail', 'grep', 'find', 'rg',
        'git', 'node', 'python', 'python3', 'echo', 'pwd', 'whoami',
        'wc', 'sort', 'uniq', 'awk', 'sed', 'tree', 'file', 'stat',
      ])
      if (!readOnlyCmds.has(cmd)) {
        return { kind: 'block', reason: `当前为「只读模式」，不允许执行 ${cmd}` }
      }
      // git 只允许只读子命令
      if (cmd === 'git') {
        const sub = String(args[0] ?? '').toLowerCase()
        const writeSubs = new Set(['push', 'commit', 'add', 'checkout', 'reset', 'clean', 'merge', 'rebase', 'rm', 'mv'])
        if (writeSubs.has(sub)) {
          return { kind: 'block', reason: `当前为「只读模式」，不允许 git ${sub}` }
        }
      }
      // sed -i 是写操作
      if (cmd === 'sed' && args.some((a) => /^-i/.test(String(a)))) {
        return { kind: 'block', reason: '当前为「只读模式」，不允许 sed -i 就地修改' }
      }
      return { kind: 'auto-allow', reason: '只读模式允许的查询命令' }
    }

    return null
  }

  /**
   * 自动审查子代理：判断一条"需要确认"的命令能否自动放行。
   *
   * @returns auto-allow（低风险，免打扰）/ need-human（要人看）/ block（拒绝）
   */
  async autoReview(command: string, args: readonly string[], cwd?: string): Promise<ApprovalVerdict> {
    if (!this.isAutoReviewEnabled()) {
      return { kind: 'need-human', reason: '自动审查未开启' }
    }

    const full = [command, ...args].join(' ')

    // ① 硬禁区优先 —— 不交给模型判断
    for (const re of HARD_BLOCK_PATTERNS) {
      if (re.test(full)) {
        return { kind: 'block', reason: `命中硬禁区：${re.source}` }
      }
    }

    // ② 模型判断
    const resolved = this.resolveModel()
    if (!resolved) {
      return { kind: 'need-human', reason: '未配置模型，无法自动审查' }
    }

    try {
      const res = await this.withTimeout(
        LlmClient.getInstance().chat({
          model: resolved.model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            {
              role: 'user',
              content: `命令：${full}\n工作目录：${cwd ?? '(未指定)'}`,
            },
          ],
          temperature: 0.1,
          maxTokens: 200,
          ...(resolved.inline ? { config: resolved.inline } : {}),
          ...(resolved.provider ? { provider: resolved.provider } : {}),
        }),
        REVIEW_TIMEOUT_MS,
      )
      if (!res.ok || !res.content) {
        return { kind: 'need-human', reason: '审查模型无响应' }
      }
      return this.parseVerdict(res.content)
    } catch (e) {
      this.log.warn('[ApprovalGate] 自动审查异常，回退为人工确认', e)
      return { kind: 'need-human', reason: '审查异常' }
    }
  }

  /** 解析审查模型输出 */
  parseVerdict(raw: string): ApprovalVerdict {
    let text = raw.trim()
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (fence) text = fence[1].trim()
    const s = text.indexOf('{')
    const e = text.lastIndexOf('}')
    if (s < 0 || e <= s) return { kind: 'need-human', reason: '审查结果无法解析' }

    let parsed: any
    try {
      parsed = JSON.parse(text.slice(s, e + 1))
    } catch {
      return { kind: 'need-human', reason: '审查结果无法解析' }
    }

    const verdict = String(parsed?.verdict ?? '').toLowerCase()
    const reason = String(parsed?.reason ?? '').slice(0, 200)
    if (verdict === 'allow') return { kind: 'auto-allow', reason: reason || '低风险操作' }
    if (verdict === 'deny') return { kind: 'block', reason: reason || '高风险操作' }
    return { kind: 'need-human', reason: reason || '需人工确认' }
  }

  private resolveModel(): { model: string; provider?: LlmProvider; inline?: { provider: LlmProvider; apiKey?: string; apiBaseUrl?: string } } | null {
    try {
      const chatConfig = ChatConfig.getInstance()
      const providerId = chatConfig.getLastProvider()
      const modelId = chatConfig.getLastModel()
      const manager = ModelManager.getInstance()

      const mp = providerId ? manager.getProvider(providerId) : manager.getEnabledProviders()[0]
      if (mp?.enabled) {
        const firstUsable = mp.models?.find((m) => !m.disabled)?.id
        const provider = (mp.type as LlmProvider) ?? 'openai'
        return {
          model: modelId || mp.defaultModel || firstUsable || 'gpt-4o-mini',
          inline: { provider, apiKey: mp.apiKey, apiBaseUrl: mp.baseUrl },
        }
      }
      const active = LlmConfigStore.getInstance().getActive()
      if (active) {
        return { model: modelId || active.defaultModel || 'gpt-4o-mini', provider: active.provider }
      }
      return null
    } catch {
      return null
    }
  }

  private async withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_r, rej) => {
      timer = setTimeout(() => rej(new Error(`review timeout ${ms}ms`)), ms)
    })
    try {
      return await Promise.race([p, timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}