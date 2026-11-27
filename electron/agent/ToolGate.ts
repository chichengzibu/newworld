/**
 * New World - 工具权限门 (M2-B)
 *
 * 【要修的安全洞】
 * EditTool.ts:56 标注了 `requiresPermission: true`,但这个字段在整个 run loop
 * 里【从未被读取】—— 只有 listTools() 把它暴露给外部查看。
 * 后果: EditTool 写文件(EditTool.ts:119-120)没有任何确认、没有 diff 预览、
 * 没有 dry-run。本地小模型跑偏时,可以在用户完全无感知的情况下改掉
 * sandbox/workspace 里的任意文件。
 *
 * 与 BashTool 的对比很刺眼:
 *   BashTool → commandDecide.execCommand() → 三层决策(AUTO 13 / CONFIRM 20 / deny)
 *              + secrets 路径段 guard + cwd 沙箱检查 + fail-closed 审计
 *   EditTool  → 直接写,零检查
 *
 * 【设计:权限是 Harness 的横切关注点】
 * 不在每个工具里各写一套检查(那正是当前分裂的原因),而是统一调度:
 *   工具声明元数据 → ToolGate 判定 → 执行 or 拒绝。
 * BashTool 自己的 commandDecide 保留(它有更细的命令级白名单),
 * 但 ToolGate 作为兜底层,确保任何新工具都不会"忘记检查"。
 *
 * 【fail-safe 原则】
 * 判定不确定时一律 CONFIRM 而非放行。安全边界上,"不知道"不等于"可以"。
 */
import { LogManager } from '../core/LogManager'
import type { PiPiTool, RuntimeToolContext } from './tools/Tool'
import type { ContextKind } from './tools/constants'

export type ToolPermission = 'auto' | 'confirm' | 'deny'

export interface ToolGateDecision {
  allowed: boolean
  permission: ToolPermission
  reason: string
  /** 需要人工确认时的提示文案 */
  prompt?: string
}

/**
 * RBAC 判定结果（由主进程注入，ToolGate 本身不直接依赖 PermissionManager）。
 * - allowed=false → 工具被当前激活权限集禁止，直接 deny
 * - 返回 null → 没有配置/没有激活权限集，交回 ToolGate 原有档位判定
 */
export interface ToolRbacDecision {
  allowed: boolean
  reason: string
}

export interface ToolGateHooks {
  /**
   * 【v4.8】RBAC 能力级检查（用户在「设置 → 权限管理」选的安全/标准/全量）。
   * 按工具名映射到 category/action，不传 resource —— 避免把 sandbox/workspace
   * 路径误判为不在 safe 模板的 $HOME/Documents 白名单里。
   * 注入回调而非在 ToolGate 内 import PermissionManager，是为了让单测(node 环境、
   * 无 electron userData)能独立验证档位逻辑；生产由 LlmAgentBrain 注入真实判定。
   */
  rbacCheck?: (toolName: string) => ToolRbacDecision | null
  /**
   * 请求用户确认。仅 contextKind==='ui' 时才会被调用 ——
   * headless / scheduler / im_inbound 无法弹窗,一律按拒绝处理
   * (与 commandDecide 的既有策略一致:不因为"没人在"就默认同意)。
   */
  requestConfirmation?: (toolName: string, prompt: string) => Promise<boolean>
  /**
   * 调用方显式声明"这些写操作已预先获得授权"。
   *
   * 用于确实无人值守但已在上层做过授权的场景(如用户为某个定时任务
   * 单独授权过)。这是【显式注入】而非全局开关 ——
   * 生产调用方不传就是拒绝,不存在可被误用的旁路。
   */
  preApproved?: boolean
}

const log = LogManager.getInstance()

/**
 * 内置工具的默认权限。
 * 依据:只读无副作用 → auto;写/删 → confirm;不可逆且破坏性强 → deny。
 */
const DEFAULT_PERMISSIONS: Record<string, ToolPermission> = {
  // 只读:无副作用
  Read: 'auto',
  Glob: 'auto',
  Grep: 'auto',
  // 【M4-D 补登】load_skill 是只读(读技能正文文件,无副作用)。
  //   此前漏登 → 落到兜底 'confirm' → headless 场景【直接被拒】,
  //   UI 场景每加载一次技能就弹一次确认框。
  //   症状:「技能被应用」这件事在数据里根本不存在(M4-D 的信号源),
  //   且只读操作被当成有副作用,徒增打断。
  load_skill: 'auto',
  // 【v4.8】联网搜索是只读网络检索，无本地副作用。是否可用由 ChatInput 的
  // 「联网搜索」开关决定（开关关闭时工具根本不进入 LLM 的 tools schema），
  // 这里只需保证开关开启后不会被档位默认 'confirm' 卡住。
  web_search: 'auto',
  // 【P3】委派本身不直接读写文件:它只派生子代理,子代理的每次工具调用仍走各自权限门,
  // 因此不构成提权。若标 confirm,headless/定时任务会因无人确认而整体拒绝编排。
  parallel_subtasks: 'auto',
  // 写:需要用户知情
  Edit: 'confirm',
  Write: 'confirm',
  // 执行:走 BashTool 自己的 commandDecide 分档,这里只兜底敏感路径
  Bash: 'auto',
}

/**
 * 无论档位如何都必须查敏感路径的工具 —— 它们的参数里能藏文件路径。
 * Bash 在列:`rm -rf ~/.ssh` 的路径藏在 args 数组里,不扫就会漏。
 */
const ALWAYS_PATH_CHECKED = new Set(['Bash', 'Edit', 'Write', 'Read'])

/**
 * 【不重复拦截】已有更细权限层的工具 —— ToolGate 只做敏感路径兜底,
 * 权限决策交还给它自己那套(命令级白名单/档位)。
 *
 * BashTool → commandDecide.execCommand: AUTO 13 项 / CONFIRM 20 项 / deny,
 * 且带 fail-closed 审计留痕。若 ToolGate 先拦,BashTool 那套永远跑不到,
 * 既重复实现又让审计链断掉 —— contextKind 贯穿机制正是靠它验证的。
 */
const DELEGATED_PERMISSION = new Set(['Bash'])

/** 路径逃逸检查:所有路径型工具都必须过这一关。
 *  agent 工具的合法根是 sandbox / workspace;process.cwd() 在开发态下
 *  等于整个仓库可读(ReadTool.ts:31),这里额外拦掉明显不该碰的路径。 */
const FORBIDDEN_PATH_PATTERNS: ReadonlyArray<RegExp> = [
  /(^|[\\/])\.ssh([\\/]|$)/i,
  /(^|[\\/])\.aws([\\/]|$)/i,
  /(^|[\\/])\.gnupg([\\/]|$)/i,
  /(^|[\\/])Windows([\\/])System32([\\/])/i,
  /(^|[\\/])\.env(\.|$)/i,
  /\.pem$/i,
  /\.key$/i,
  /id_rsa/i,
]

/**
 * 从 args 里尽力提取待检查的路径串。
 *
 * 不只是单个 path 字段:Bash 的参数是数组(`rm -rf ~/.ssh`),
 * 只认字符串键会让危险路径从 args 数组里溜过去 —— 这是一个真实的绕过。
 * 故对所有字符串值做扁平化扫描。
 */
function extractPaths(args: Record<string, unknown>): string[] {
  const out: string[] = []
  const push = (v: unknown): void => {
    if (typeof v === 'string' && v.length > 0) out.push(v)
    else if (Array.isArray(v)) v.forEach(push)
  }
  for (const key of ['file_path', 'path', 'filePath', 'target', 'dest', 'destination']) {
    push(args[key])
  }
  // Bash 的 command / args 也要查 —— "rm -rf ~/.ssh" 里路径藏在 args 数组中
  push(args.command)
  push(args.args)
  return out
}

/** 取第一个路径(用于生成确认提示) */
function extractPath(args: Record<string, unknown>): string | null {
  return extractPaths(args)[0] ?? null
}

export class ToolGate {
  /**
   * 判定一个工具调用是否放行。
   *
   * @param tool 工具实例(读其 metadata.requiresPermission 与名称)
   * @param args LLM 传入的参数
   * @param ctx  显式执行上下文(决定能否弹窗)
   * @param hooks 确认桥(headless 场景不传)
   */
  static async check(
    tool: PiPiTool,
    args: Record<string, unknown>,
    ctx: RuntimeToolContext | undefined,
    hooks?: ToolGateHooks,
  ): Promise<ToolGateDecision> {
    const name = tool.metadata?.name ?? 'unknown'

    // ① 工具自身显式声明 deny —— 尊重工具作者的判断
    if ((tool.metadata as { deny?: boolean })?.deny === true) {
      return { allowed: false, permission: 'deny', reason: `工具 ${name} 被标记为禁止执行` }
    }

    // ①bis 【v4.8】RBAC 能力级检查 —— 用户配置的权限集真正生效的地方。
    // 放在档位判定之前：即使某工具档位是 auto(如 Bash/Read)，只要用户在
    // 「设置 → 权限管理」把对应能力关掉(safe 模板 shell=none / filesystem=read)，
    // 就必须拒绝。只判能力级别、不传 resource，避免路径白名单误伤 workspace。
    if (hooks?.rbacCheck) {
      let rbac: ToolRbacDecision | null = null
      try {
        rbac = hooks.rbacCheck(name) ?? null
      } catch (e) {
        // 判定回调异常 → fail-safe 拒绝(与确认桥异常一致)
        return {
          allowed: false,
          permission: 'deny',
          reason: `权限判定异常,已拒绝(${(e as Error).message})`,
        }
      }
      if (rbac && !rbac.allowed) {
        log.warn(`ToolGate: RBAC 拒绝 ${name} —— ${rbac.reason}`)
        return { allowed: false, permission: 'deny', reason: `权限集已禁止:${rbac.reason}` }
      }
    }

    // ② 权限档位:metadata.requiresPermission 为真 → 至少 confirm
    //
    // 【口径说明 — 别只改一半】
    // `requiresPermission: false` 并不等于「auto」:它只说明"这个工具没有声明
    // 需要权限",具体档位仍查 DEFAULT_PERMISSIONS,查不到就落到兜底 'confirm'。
    // 兜底是**故意的** —— 陌生工具默认保守(见 ToolGate.test.ts「未知工具默认保守」),
    // 且不能由工具自己声明来降档:声明 false 的工具未必真的无副作用
    // (例:D1ScreenshotQA 声明 false,但截图本身是可见的隐私面)。
    //
    // → 代价:**新增只读工具必须在本表登记**,否则会静默变成 confirm
    //   (headless 被拒 / UI 每次弹窗)。tests/unit/ToolGate.test.ts 有
    //   「内置工具档位与声明一致」用例盯着这件事,漏登记会红。
    const declared = (tool.metadata as { requiresPermission?: boolean })?.requiresPermission === true
    const permission: ToolPermission = declared
      ? 'confirm'
      : (DEFAULT_PERMISSIONS[name] ?? 'confirm')

    if (permission === 'deny') {
      return { allowed: false, permission: 'deny', reason: `工具 ${name} 不允许执行` }
    }

    // ③ 路径逃逸检查。
    //   confirm 级工具必查;Bash/Read 即使是 auto 也必查 ——
    //   "rm -rf ~/.ssh" 里的路径藏在 args 数组,不扫就会漏。
    if (permission === 'confirm' || ALWAYS_PATH_CHECKED.has(name)) {
      for (const p of extractPaths(args)) {
        for (const re of FORBIDDEN_PATH_PATTERNS) {
          if (re.test(p)) {
            log.warn(`ToolGate: 拒绝 ${name} 访问敏感路径 ${p}`)
            return {
              allowed: false,
              permission: 'deny',
              reason: `拒绝访问敏感路径(匹配安全规则:${p})`,
            }
          }
        }
      }
    }

    // ④ auto 直接放行
    if (permission === 'auto') {
      return { allowed: true, permission: 'auto', reason: '只读操作,自动放行' }
    }

    // ④bis 已委托的工具:Bash 由 commandDecide 按命令档位决策(它有更细的
    //      AUTO/CONFIRM/deny 三层 + fail-closed 审计留痕)。ToolGate 在此
    //      重复拦一次既无必要,又会让审计链断裂 —— 放行给它判断。
    if (DELEGATED_PERMISSION.has(name)) {
      return { allowed: true, permission: 'confirm', reason: '交由工具自身的权限层(commandDecide)决策' }
    }

    // ⑤ confirm:必须有人在场并明确同意
    const prompt = buildPrompt(name, args)
    const contextKind: ContextKind = ctx?.contextKind ?? 'headless'

    if (contextKind !== 'ui') {
      // 无 UI 上下文 → 无法获得用户确认 → 拒绝(不默认放行)。
      //
      // 【为什么不留"豁免开关"】
      // 曾考虑过 globalThis.__newworldHeadlessExempt 之类的测试后门,
      // 但那是把安全边界建立在"没人会写这行代码"的约定上 ——
      // 任何人加一行赋值就能绕过 fail-safe。已废弃该方向。
      // 需要在非 UI 上下文预授权的,必须由调用方【显式传参】
      // opts.preApprovedToolConfirm,走与 requestToolConfirmation 同构的
      // 注入路径:生产调用方不传就是拒绝,不存在可被误用的全局旁路。
      if (hooks?.preApproved) {
        return { allowed: true, permission: 'confirm', reason: '调用方已声明预授权(显式注入)' }
      }
      return {
        allowed: false,
        permission: 'confirm',
        reason: `${name} 需要用户确认,但当前上下文(${contextKind})无法弹窗,已拒绝`,
        prompt,
      }
    }

    if (!hooks?.requestConfirmation) {
      // 有 UI 但没接确认桥 → 仍然拒绝(缺桥 ≠ 免确认)
      log.warn(`ToolGate: ${name} 需要确认但未接入确认桥,已拒绝`)
      return {
        allowed: false,
        permission: 'confirm',
        reason: `${name} 需要确认但确认通道不可用,已拒绝(fail-safe)`,
        prompt,
      }
    }

    try {
      const ok = await hooks.requestConfirmation(name, prompt)
      return ok
        ? { allowed: true, permission: 'confirm', reason: '用户已确认' }
        : { allowed: false, permission: 'confirm', reason: '用户拒绝执行', prompt }
    } catch (e) {
      log.warn(`ToolGate: 确认桥异常(${e instanceof Error ? e.message : e}),按拒绝处理`)
      return {
        allowed: false,
        permission: 'confirm',
        reason: '确认过程出错,已拒绝(fail-safe)',
        prompt,
      }
    }
  }

  /** 批量判定 —— 供未来"执行前预览整个计划"用 */
  static async checkAll(
    tools: Array<{ tool: PiPiTool; args: Record<string, unknown> }>,
    ctx: RuntimeToolContext | undefined,
    hooks?: ToolGateHooks,
  ): Promise<ToolGateDecision[]> {
    const out: ToolGateDecision[] = []
    for (const { tool, args } of tools) {
      out.push(await ToolGate.check(tool, args, ctx, hooks))
    }
    return out
  }
}

function buildPrompt(name: string, args: Record<string, unknown>): string {
  const p = extractPath(args)
  if (name === 'Edit') {
    return p
      ? `即将修改文件:${p}`
      : '即将修改文件'
  }
  if (name === 'Bash') {
    const cmd = typeof args.command === 'string' ? args.command : '(未提供)'
    return `即将执行命令:${cmd}`
  }
  // create_artifact 的路径由工具自己固定在 userData/workspace，args 里只有文件名；
  // 提示里把「文件类型 + 文件名」说清楚，用户才知道自己确认的是哪份成品。
  if (name === 'create_artifact') {
    const type = typeof args.type === 'string' ? args.type : '未知类型'
    const file = typeof args.filename === 'string' ? args.filename : '未命名'
    return `即将生成成品文件:${file}（${type}）`
  }
  return `即将使用工具 ${name}${p ? `:${p}` : ''}`
}