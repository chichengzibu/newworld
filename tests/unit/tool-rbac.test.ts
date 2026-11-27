// @vitest-environment node
/**
 * 工具 RBAC 判定桥单测（v4.8）
 *
 * 钉住两件事：
 *   1. 工具 → 权限能力的映射正确（Bash=shell:execute、Edit=filesystem:write…）
 *   2. 用户选「安全模式」时，危险工具（Bash/Edit）真的被拒；配置不可用时
 *      返回 null 交回 ToolGate 档位判定，不让整个工具链瘫痪。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { checkPermissionMock, getInstanceMock, getActiveSetMock } = vi.hoisted(() => ({
  checkPermissionMock: vi.fn(),
  getInstanceMock: vi.fn(),
  getActiveSetMock: vi.fn(),
}))

vi.mock('../../electron/permissions/PermissionManager', () => ({
  PermissionManager: {
    getInstance: () => getInstanceMock(),
  },
}))

import { capabilityForTool, createToolRbacCheck } from '../../electron/agent/ToolRbac'

describe('工具 RBAC 映射', () => {
  it('危险工具映射到正确能力', () => {
    expect(capabilityForTool('Bash')).toEqual({ category: 'shell', action: 'execute' })
    expect(capabilityForTool('Edit')).toEqual({ category: 'filesystem', action: 'write' })
    expect(capabilityForTool('Write')).toEqual({ category: 'filesystem', action: 'write' })
    // web_search 的授权是 ChatInput 的联网开关本身，不走 RBAC（避免开了开关仍被 network=none 拒绝）
    expect(capabilityForTool('web_search')).toBeNull()
  })

  it('只读工具映射到 filesystem:read/search', () => {
    expect(capabilityForTool('Read')).toEqual({ category: 'filesystem', action: 'read' })
    expect(capabilityForTool('Grep')).toEqual({ category: 'filesystem', action: 'search' })
  })

  it('未登记工具返回 null（交回档位判定）', () => {
    expect(capabilityForTool('unknown_tool')).toBeNull()
    expect(capabilityForTool('parallel_subtasks')).toBeNull()
  })
})

describe('RBAC 判定回调', () => {
  beforeEach(() => {
    checkPermissionMock.mockReset()
    getInstanceMock.mockReset()
    getActiveSetMock.mockReset()
    // 默认模拟「用户已配置权限集」，需要测「无激活集」的用例单独覆盖
    getActiveSetMock.mockReturnValue({ id: 'test-set' })
    getInstanceMock.mockImplementation(() => ({
      checkPermission: checkPermissionMock,
      getActivePermissionSet: getActiveSetMock,
    }))
  })

  it('无激活权限集 → 返回 null 不拦截（新用户/无配置环境不被锁死）', () => {
    getActiveSetMock.mockReturnValue(undefined)
    const check = createToolRbacCheck()
    expect(check('Bash')).toBeNull()
    expect(checkPermissionMock).not.toHaveBeenCalled()
  })

  it('权限集明确拒绝 → 返回 allowed:false，工具被拦', () => {
    checkPermissionMock.mockReturnValue({ allowed: false, reason: 'shell 操作已被禁用' })
    const check = createToolRbacCheck()
    const d = check('Bash')
    expect(d?.allowed).toBe(false)
    expect(d?.reason).toContain('shell 操作已被禁用')
    expect(checkPermissionMock).toHaveBeenCalledWith({ category: 'shell', action: 'execute' })
    // 关键：只传 category/action，不传 resource（避免白名单误伤 workspace）
    expect(checkPermissionMock.mock.calls[0][0]).not.toHaveProperty('resource')
  })

  it('权限集允许 → 放行', () => {
    checkPermissionMock.mockReturnValue({ allowed: true, reason: '权限检查通过' })
    expect(createToolRbacCheck()('Edit')).toEqual({ allowed: true, reason: 'RBAC 通过' })
  })

  it('配置读取异常 → 返回 null 不拦截（不让工具链瘫痪）', () => {
    getInstanceMock.mockImplementation(() => { throw new Error('no userData') })
    expect(createToolRbacCheck()('Bash')).toBeNull()
  })

  it('未登记工具不查权限系统', () => {
    const check = createToolRbacCheck()
    expect(check('parallel_subtasks')).toBeNull()
    expect(checkPermissionMock).not.toHaveBeenCalled()
  })
})
