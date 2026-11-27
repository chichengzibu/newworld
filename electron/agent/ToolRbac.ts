/**
 * New World - 工具 RBAC 判定桥（v4.8）
 * ═══════════════════════════════════════════════════════════════
 * 【要修的安全洞】
 * 用户在「设置 → 权限管理」选了安全/标准/全量模板，但 Agent 跑工具的主链路
 * （LlmAgentBrain → ToolGate → Bash/Edit/...）此前只读 ToolGate 自己的硬编码档位，
 * **从不读 PermissionManager**。结果：切到「安全模式」，Bash 依然能执行、Edit
 * 依然能写文件 —— 权限管理形同虚设。
 *
 * 【职责边界】
 * 本模块把「工具名 → 权限能力(category/action)」的映射和判定集中起来，
 * 供 LlmAgentBrain 以回调形式注入 ToolGate。ToolGate 保持不依赖 electron
 * userData，单测可独立验证档位逻辑；生产链路由这里提供真实的 RBAC 判定。
 *
 * 【只判能力，不判资源】
 * 不传 resource 给 checkPermission —— safe 模板的 filesystem 白名单是
 * $HOME/Documents，而 agent 的合法根是 sandbox/workspace，传路径会被误判为
 * 越界，导致所有工具在默认安全模式下全挂。路径安全由 ToolGate 自己的
 * FORBIDDEN_PATH_PATTERNS 负责，这里只管「该能力在当前权限集下是否允许」。
 */
import { PermissionManager } from '../permissions/PermissionManager'
import type { PermissionCategory } from '../permissions/PermissionTypes'
import type { ToolRbacDecision } from './ToolGate'

interface Capability {
  category: PermissionCategory
  action: string
}

/**
 * 工具 → 权限能力映射。
 * - 未登记的工具返回 null（交回 ToolGate 原有档位判定，避免陌生工具被误放行/误拒）。
 * - parallel_subtasks 是编排器：它本身不读写，子任务的每次工具调用仍会各自
 *   过 ToolGate + RBAC，所以这里不额外拦截（否则无人值守的子任务全挂）。
 */
const TOOL_CAPABILITIES: Record<string, Capability> = {
  Read: { category: 'filesystem', action: 'read' },
  Glob: { category: 'filesystem', action: 'read' },
  Grep: { category: 'filesystem', action: 'search' },
  Edit: { category: 'filesystem', action: 'write' },
  Write: { category: 'filesystem', action: 'write' },
  create_artifact: { category: 'filesystem', action: 'write' },
  Bash: { category: 'shell', action: 'execute' },
  load_skill: { category: 'filesystem', action: 'read' },
  // web_search 不在此列：它的授权就是 ChatInput 的联网开关本身（开启=授权模型联网），
  // 且关闭时工具不会进入 LLM 的 tools schema。若再经 RBAC 的 network=none 拦截，
  // 用户开启开关后仍被安全模板拒绝，行为不可预测。
}

export function capabilityForTool(toolName: string): Capability | null {
  return TOOL_CAPABILITIES[toolName] ?? null
}

/**
 * 生成注入 ToolGate 的 rbacCheck 回调。
 * 配置读取失败/无激活权限集时返回 null（不拦截）—— RBAC 是横切增强，
 * 不能因为权限模块故障就让整个工具链瘫痪；真正的「拒绝」只来自明确的
 * 权限集判定（如 safe 模板 shell=none）。
 */
export function createToolRbacCheck(): (toolName: string) => ToolRbacDecision | null {
  return (toolName: string): ToolRbacDecision | null => {
    const cap = capabilityForTool(toolName)
    if (!cap) return null
    try {
      const manager = PermissionManager.getInstance()
      // 【关键语义】「用户没配置过权限」≠「用户明确拒绝」。
      // checkPermission 在「无激活权限集」时返回 allowed:false（reason=未找到激活的权限集），
      // 但这其实是全新用户 / 无 userData 测试环境的常态，不是用户主动禁止。
      // 若照单拦截，会把「从未进过权限设置的新用户」的所有工具全锁死 —— 既有回归
      // 套件里 6 个用例正是这样挂的。故先判激活集：没有就交回 ToolGate 原档位判定。
      if (!manager.getActivePermissionSet()) return null
      const result = manager.checkPermission({
        category: cap.category,
        action: cap.action,
      })
      if (!result.allowed) {
        return { allowed: false, reason: result.reason || `${cap.category}:${cap.action} 未被当前权限集允许` }
      }
      return { allowed: true, reason: 'RBAC 通过' }
    } catch {
      // 权限配置不可用 → 不拦截，交回 ToolGate 档位判定
      return null
    }
  }
}
