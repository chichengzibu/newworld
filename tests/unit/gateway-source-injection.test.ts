/**
 * commit A 堵 #13 — gateway source 入口派生测试
 *
 * 核心安全断言：params.contextKind 对 gateway 决策零影响，
 *   execCommand 收到的 contextKind 只来自 executeOperation/request 第二参数 (source)。
 *
 * 策略：
 *   - 真实 execCommand (不 mock 决策逻辑) + stub audit sink + stub confirm transport
 *   - gateway 重依赖 (PermissionManager/BrowserManager/OpenClawServer) mock 掉
 *   - 用 confirm 级命令 (node) 验证 source 对结果的真实影响
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { TEST_USER_DATA } from './test-host'
import { setConfirmTransport, setAuditSink } from '../../electron/agent/tools/commandDecide'

// mock gateway 重依赖，避免真 BrowserWindow / Electron 网络调用
vi.mock('../../electron/permissions/PermissionManager', () => ({
  PermissionManager: {
    getInstance: vi.fn(() => ({
      checkPermission: vi.fn(() => ({ allowed: true, reason: 'test-allow' })),
    })),
  },
}))
vi.mock('../../electron/browser/BrowserManager', () => ({
  BrowserManager: { getInstance: vi.fn(() => ({})) },
}))
vi.mock('../../electron/openclaw/OpenClawServer', () => ({
  OpenClawServer: { getInstance: vi.fn(() => ({})) },
}))

import { OpenClawGateway } from '../../electron/openclaw/OpenClawGateway'

const AUDIT_FILE = path.join(TEST_USER_DATA, 'audit', 'openclaw.audit.jsonl')
// 收集审计行，供断言
let auditRows: any[] = []
function installAuditSink() {
  auditRows = []
  setAuditSink((entry: any) => {
    auditRows.push(entry)
    fs.mkdirSync(path.dirname(AUDIT_FILE), { recursive: true })
    fs.appendFileSync(AUDIT_FILE, JSON.stringify(entry) + '\n', 'utf8')
  })
}

function gw() {
  const g = OpenClawGateway.getInstance() as any
  return g
}

describe('commit A: 堵 #13 — gateway source 入口派生', () => {
  beforeEach(() => {
    installAuditSink()
    setConfirmTransport(async () => true)
  })
  afterEach(() => {
    setConfirmTransport(null)
    setAuditSink(null)
  })

  it('攻击-1: executeOperation (source缺失/默认) + params.contextKind="ui" → 仍被 headless 拒绝', async () => {
    // HTTP 入口：OpenClawServer 调 executeOperation(req) 不传 source → 默认 'headless'
    // 攻击者往 params 塞 contextKind:'ui'
    const result: any = await gw().executeOperation({
      operationType: 'run_command',
      params: { command: 'node', args: ['-e', 'process.exit(0)'], contextKind: 'ui' },  // ← 伪造
      operationId: 'op-attack-1',
    })

    // 关键：params.contextKind 无效，executeOperation 默认 source='headless' → confirm 级命令被拒
    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('PERMISSION_DENIED')
    // 注意: executeOperation 的 catch 块不写审计行（审计仅在 runCommand 的 execCommand 内写）
    // 这里只断言"被拒绝的事实"；审计行的真实 contextKind='headless' 由攻击-2 直接 runCommand 覆盖
  })

  it('攻击-2: 直接 runCommand(params) 无 source 参数 → 默认 headless 拒绝', async () => {
    await expect(
      gw().runCommand({ command: 'node', args: ['-e', '1'], contextKind: 'ui' })  // ← 伪造
    ).rejects.toThrow(/headless|denied|不允许/)

    // 审计显示 contextKind='headless'
    const denyRow = auditRows.find((r) => r.phase === 'deny')
    expect(denyRow?.contextKind).toBe('headless')
  })

  it('IPC-1: runCommand(params, "ui") → execCommand 收到 ui → 确认桥 → 允许', async () => {
    const { stdout } = await gw().runCommand(
      { command: 'node', args: ['-e', 'console.log("ipc-ok")'] },  // ← 无 contextKind
      'ui'
    )
    expect(stdout).toContain('ipc-ok')

    // 审计 start 行 contextKind='ui'
    const startRow = auditRows.find((r) => r.contextKind === 'ui' && r.phase === 'start')
    expect(startRow).toBeDefined()
  })

  it('scheduler: runCommand(params, "scheduler") → 只允许 AUTO 级，confirm 被拒', async () => {
    await expect(
      gw().runCommand({ command: 'node', args: ['-e', '1'] }, 'scheduler')
    ).rejects.toThrow()

    const denyRow = auditRows.find((r) => r.contextKind === 'scheduler' && r.phase === 'deny')
    expect(denyRow).toBeDefined()
    expect(denyRow.denied).toBe(true)
  })

  it('im_inbound: runCommand(params, "im_inbound") → 同上，confirm 被拒', async () => {
    await expect(
      gw().runCommand({ command: 'node', args: ['-e', '1'] }, 'im_inbound')
    ).rejects.toThrow()

    const denyRow = auditRows.find((r) => r.contextKind === 'im_inbound' && r.phase === 'deny')
    expect(denyRow).toBeDefined()
  })
})
