/**
 * New World - BashTool 三层名单 (v3 终版 + 5 裁决; 唯一可调松紧处)
 *
 * 纯逻辑模块: 禁止 import electron / node 运行时依赖以外的东西,
 * 使 decideCommand / normalizeCommand / isSecretsSegmentHit 可脱离 electron 独立测试 (T1-T5)。
 *
 * 三层模型:
 *   1. AUTO    — 只读/无网/无副作用, 默任信任, 免确认
 *   2. CONFIRM — 需逐次人工审批, 仅 ui 上下文放行弹窗; 其余上下文一律拒
 *   3. 其余    — 一律拒绝
 *
 * 归一化 (v3 强制 #1): basename → 剥 /\.(exe|cmd|bat|com)$/i → toLowerCase → 查表。
 *   测试 (T3 归一化四连) 钉死: 'BASH' / '/bin/bash' / 'bash.exe' 全命中 'bash'。
 *
 * 残留风险条款 (v3 强制 #8):
 *   Windows 无 OS 沙箱 ⇒ 自动放行级命令 (ls/cat) 可读当前用户可读的任何文件;
 *   名单层防"执行", 不防"读取"。根治 = Windows 沙箱 (P2)。
 *
 * 密钥 guard (v3 强制 #7 + 裁决 #2):
 *   (a) 路径段感知: 匹配 path segment == pattern, 禁裸子串 (防误杀)
 *   (b) SECRETS_GUARD_PATTERNS 为追加数据表, 新条目改数据不改 decideCommand
 *   (c) 尽力而为: base64/echo/重打包均可绕过; 根治 = Windows 沙箱 P2
 */

/** 上下文类型 (v3 强制 #4); 仅 'ui' 放行 confirm 级命令 */
export type ContextKind = 'ui' | 'im_inbound' | 'scheduler' | 'headless'

export type DecisionKind = 'auto' | 'confirm' | 'deny'

export interface Decision {
  kind: DecisionKind
  reason?: string
  /** 归一化后的 baseCmd (审计/日志用; 非 execFile 用的原始 base) */
  normalizedCmd: string
}

/** 密钥 guard 数据表 (裁决 #2b: 追加条目改此处, 不改 decideCommand) */
export const SECRETS_GUARD_PATTERNS: ReadonlyArray<string> = [
  // 裁决 #2a: 路径段感知 → 以下均为 "段名", 匹配 basename or path-segment
  '.ssh',                          // /home/user/.ssh/ , C:\Users\xxx\.ssh\
  '.newworld-secrets',             // 自定义秘钥包
  '.pipiclaw-secrets',             // 旧目录名仍在本机存在,保留 guard 防误读真实私钥
  'clawhub-dev-ed25519.key',       // 禁止入库的 key (即使不在 .git 里也拦截)
  'id_rsa',                        // 常见 SSH 私钥文件名
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  '.aws',                          // /home/user/.aws/credentials
  '.gnupg',                        // GPG 密钥目录
]

/**
 * (裁决 #2a: 路径段感知) — 匹配规则:
 *   对每个 arg 按 / 和 \ 切段, 取小写; 若任一段 == SECRETS_GUARD_PATTERNS 表项 → 命中。
 *   不裸子串: 'my-ssh-config' 段 ≠ '.ssh' → 不命中; 'sshtest' 段 ≠ '.ssh' → 不命中。
 */
export function isSecretsSegmentHit(arg: string): boolean {
  const segments = arg.replace(/\\/g, '/').split('/').map(s => s.toLowerCase())
  return segments.some(seg => SECRETS_GUARD_PATTERNS.includes(seg))
}

/** 自动放行 (v3 终版 + 规格修正: AUTO 13 项, env 移出 → CONFIRM)
 *   集合为唯一事实源; 文档/测试计数由 .size 派生, 禁手写数字。 */
export const COMMAND_AUTO_ALLOWLIST: ReadonlySet<string> = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'tree', 'pwd',
  'whoami', 'date', 'uname', 'echo', 'find',
])

/** find 危险参数 (命中任一 → deny) */
export const FIND_DENY_FLAGS: ReadonlySet<string> = new Set([
  '-exec', '-execdir', '-ok', '-okdir', '-delete',
  '-fprint', '-fprintf', '-fls',
])

/** 确认名单 (v3 终版 + 规格修正: CONFIRM 20 项 = shell 7 + 网络 2 + 运行时/包管 9 + env 1 + git 1)
 *   集合为唯一事实源; 计数由 .size 派生, 禁手写数字。 */
export const COMMAND_CONFIRM_LIST: ReadonlySet<string> = new Set([
  // shell 家族 ×7 (v3 明列)
  'bash', 'sh', 'zsh', 'fish', 'cmd', 'powershell', 'pwsh',
  // 网络出站 ×2
  'curl', 'wget',
  // 运行时/包管理 ×9
  'node', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'deno',
  'python', 'python3',
  // env (v3 规格修正: 无参数=密钥倾倒, 带参数=任意执行器, 两模式都不配 auto)
  'env',
  // git (ext::sh/hooks/push, 既定裁决) ×1
  'git',
])

// wsl 不列入任何名单 (v3): wsl 是 Windows 子系统集成, 不在本机名单讨论范围内,
// 若未来需要, 单独 PR 评估。
// 注: printenv 不在任何名单 → 一律 deny (单变量打印进 backlog, v3 规格修正)。

/** basename 提取 (跨 POSIX/Windows): 按 / 与 \ 切分取最后一段 */
export function basename(raw: string): string {
  const parts = raw.split(/[/\\]/)
  return parts[parts.length - 1] || raw
}

/** 归一化 (v3 #1): basename → 剥可执行后缀 → 小写 */
export function normalizeCommand(raw: string): string {
  let b = basename(raw.trim())
  b = b.replace(/\.(exe|cmd|bat|com)$/i, '')
  return b.toLowerCase()
}

/**
 * 三层决策 (v3 #2): 接 args 支持 find/env/secrets 例外。
 * 顺序: 密钥 guard (最优先) → find 封禁 → AUTO → CONFIRM → 其余 deny。
 */
export function decideCommand(rawCmd: string, args: readonly string[] = []): Decision {
  const norm = normalizeCommand(rawCmd)

  // 密钥 guard (v3 #7 + 裁决 #2a: 路径段感知) — 最优先
  if (args.some(a => isSecretsSegmentHit(a === null || a === undefined ? '' : String(a)))) {
    return { kind: 'deny', reason: 'args 路径段命中 secrets 守护表', normalizedCmd: norm }
  }

  // find 危险参数封禁 (v3 终版)
  if (norm === 'find') {
    const hit = args.find(a => FIND_DENY_FLAGS.has(String(a).toLowerCase()))
    if (hit) {
      return { kind: 'deny', reason: `find 危险参数: ${hit}`, normalizedCmd: norm }
    }
  }

  // AUTO
  if (COMMAND_AUTO_ALLOWLIST.has(norm)) {
    return { kind: 'auto', normalizedCmd: norm }
  }

  // CONFIRM
  if (COMMAND_CONFIRM_LIST.has(norm)) {
    return { kind: 'confirm', reason: '命令在确认名单 (需逐次审批)', normalizedCmd: norm }
  }

  // 其余一律 deny
  return { kind: 'deny', reason: `baseCmd "${norm}" 不在自动/确认名单`, normalizedCmd: norm }
}

/** contextKind 是否允许 confirm 级命令 (v3 #4: 仅 ui) */
export function contextAllowsConfirm(kind: ContextKind): boolean {
  return kind === 'ui'
}
