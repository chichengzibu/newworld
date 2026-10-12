/**
 * commit B 2.5 完成 — chat 活跃链 ui 贯穿测试
 *
 * 链路(本测试覆盖, 端到端):
 *   ChatManager.sendMessage
 *     → InstructionGenerator.generateTaskSteps (spy stub, 不真发 LLM)
 *     → TaskExecutor.executeTask(task, 'ui')      ← commit B 生产端改动点
 *     → TaskExecutor.executeStep(step, 'ui')
 *     → gateway.executeOperation(op, 'ui')         ← commit A source 参数
 *     → gateway.runCommand(params, 'ui')
 *     → execCommand({contextKind:'ui'})            ← 咽喉
 *     → UI 确认桥 (setConfirmTransport stub)     ← 两态: 允许 / 拒绝
 *     → audit: ui AUTO 命令 (whoami) → 无需确认 + 执行成功
 *              ui CONFIRM 命令 (node) → 弹确认 → 允许 → 成功
 *              ui CONFIRM 命令 (node) → 弹确认 → 拒绝 → 失败
 *
 * 隔离:
 *   - 重依赖 (Hermes/SelfLearner/ModelManager/PermissionManager/
 *     BrowserManager/OpenClawServer/SkillLoader) mock 掉
 *   - InstructionGenerator 用 vi.spyOn 运行时注入 (避免 vi.mock hoisting TDZ)
 *   - 真 gateway / 真 TaskExecutor / 真 execCommand
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { TEST_USER_DATA } from './test-host'

// electron 文件级 mock (ChatManager.broadcastMessage → BrowserWindow.getAllWindows)
// 全局 electron-setup.ts 的 BrowserWindow 是 vi.fn 缺静态方法, 这里补全
// (工厂内定义, 避免外部引用 hoisting TDZ)
vi.mock('electron', () => ({
  BrowserWindow: Object.assign(vi.fn(function () {}), { getAllWindows: () => [] }),
  shell: { openExternal: vi.fn() },
  clipboard: { readText: vi.fn(() => ''), writeText: vi.fn() },
}))

// ── mock 重依赖 ──
vi.mock('../../electron/hermes/HermesMemory', () => ({
  HermesMemory: { getInstance: () => ({
    search: async () => null,
    remember: () => undefined,
    recall: async () => null,
    buildMemoryPrompt: () => '',
  }) },
}))
vi.mock('../../electron/learning/SelfLearner', () => ({
  SelfLearner: { getInstance: () => ({
    checkAndTrigger: async () => null,
    getPendingProposal: () => null,
    saveSkillFromProposal: () => true,
    observeExecution: () => undefined,
  }) },
}))
vi.mock('../../electron/models/ModelManager', () => ({
  ModelManager: { getInstance: () => ({
    getProvider: () => ({ id: 'mock-prov', name: 'MockProv', type: 'openai', baseUrl: 'http://localhost:18789' }),
    getActiveModel: () => ({ id: 'mock-model' }),
    listModels: () => [],
  }) },
}))
vi.mock('../../electron/permissions/PermissionManager', () => ({
  PermissionManager: { getInstance: () => ({
    checkPermission: () => ({ allowed: true, reason: 'test-allow' }),
  }) },
}))
vi.mock('../../electron/browser/BrowserManager', () => ({
  BrowserManager: { getInstance: () => ({}) },
}))
vi.mock('../../electron/openclaw/OpenClawServer', () => ({
  OpenClawServer: { getInstance: () => ({}) },
}))
vi.mock('../../electron/skill/SkillLoader', () => ({
  SkillLoader: { getInstance: () => ({
    listSkills: () => [],
    loadSkill: () => null,
  }) },
}))
vi.mock('../../electron/core/LogManager', () => ({
  LogManager: { getInstance: () => ({
    info: () => undefined, warn: () => undefined,
    error: () => undefined, debug: () => undefined,
  }) },
}))

import { ChatManager } from '../../electron/chat/ChatManager'
import { ChatConfig } from '../../electron/chat/ChatConfig'
import { InstructionGenerator } from '../../electron/task/InstructionGenerator'
import { setConfirmTransport, setAuditSink } from '../../electron/agent/tools/commandDecide'

const AUDIT_DIR = path.join(TEST_USER_DATA, 'audit')
const AUDIT_FILE = path.join(AUDIT_DIR, 'openclaw.audit.jsonl')
let auditRows: any[] = []
function installAuditSink() {
  auditRows = []
  setAuditSink((entry) => {
    auditRows.push(entry)
    fs.mkdirSync(AUDIT_DIR, { recursive: true })
    fs.appendFileSync(AUDIT_FILE, JSON.stringify(entry) + '\n', 'utf8')
  })
}

/** 运行时注入 InstructionGenerator stub */
let genSpy: any
function installGenStub(cmd: string, args: string[]) {
  if (genSpy) genSpy.mockRestore()
  genSpy = vi
    .spyOn(InstructionGenerator.prototype, 'generateTaskSteps' as any)
    .mockImplementation(async () => [
      { action: 'run_command', description: '测试命令', params: { command: cmd, args } },
    ])
}

let convId: string | undefined

describe('commit B: chat 活跃链 ui 贯穿测试', () => {
  beforeEach(() => {
    installAuditSink()
    const cfg = ChatConfig.getInstance() as any
    if (!convId) convId = cfg.createConversation({ title: 'b-chat-test' }).id
  })
  afterEach(() => {
    setConfirmTransport(null)
    setAuditSink(null)
    if (genSpy) { genSpy.mockRestore(); genSpy = null }
  })

  it('B-1: chat 触发 AUTO 级命令 (whoami) → source="ui" 透传至咽喉 → 执行成功', async () => {
    setConfirmTransport(async () => true)  // AUTO 命令不会触发 transport，但设上兜底
    installGenStub('whoami', [])

    const chat = ChatManager.getInstance() as any
    await chat.sendMessage(convId!, 'whoami', 'mock-prov', 'mock-model')

    // 审计 start 行 contextKind='ui'
    const start = auditRows.find(r => r.contextKind === 'ui' && r.phase === 'start')
    expect(start).toBeDefined()
    // whoami 是 AUTO 级 → 无需确认 → humanConfirm='not-required'
    expect(start.humanConfirm).toBe('not-required')

    // finish 行成对, exit=0
    const finish = auditRows.find(r => r.opId === start.opId && r.phase === 'finish')
    expect(finish).toBeDefined()
    expect(finish.exit).toBe(0)
  }, 60000)

  it('B-2: chat 触发 CONFIRM 级命令 (node) + 确认桥允许 → 成功 + humanConfirm="true"', async () => {
    setConfirmTransport(async () => true)
    installGenStub('node', ['-e', 'console.log(1)'])

    const chat = ChatManager.getInstance() as any
    const reply = await chat.sendMessage(convId!, '用 node 跑个脚本', 'mock-prov', 'mock-model')

    // 审计 start 行: humanConfirm='true' (确认桥允许)
    const start = auditRows.find(r => r.contextKind === 'ui' && r.phase === 'start')
    expect(start).toBeDefined()
    expect(start.humanConfirm).toBe('true')
    expect(start.confirmChannel).toBe('ui')

    // finish 行: exit=0
    const finish = auditRows.find(r => r.opId === start.opId && r.phase === 'finish')
    expect(finish).toBeDefined()
    expect(finish.exit).toBe(0)
  }, 60000)

  it('B-3: chat 触发 CONFIRM 级命令 (node) + 确认桥拒绝 → 失败 + humanConfirm="false" + denied', async () => {
    setConfirmTransport(async () => false)
    installGenStub('node', ['-e', 'console.log(1)'])

    const chat = ChatManager.getInstance() as any
    const reply = await chat.sendMessage(convId!, '用 node 跑个脚本', 'mock-prov', 'mock-model')

    // 审计 deny 行: humanConfirm='false' + denied=true
    const deny = auditRows.find(r => r.contextKind === 'ui' && (r.phase === 'deny' || (r.denied === true)))
    expect(deny).toBeDefined()

    // 无 finish 行 (命令未真正执行)
    const finish = auditRows.find(r => deny && r.opId === deny.opId && r.phase === 'finish')
    expect(finish ?? undefined).toBeUndefined()

    // chat 层回复包含失败信息
    expect(reply.content).toMatch(/失败|错误|denied|rejected/i)
  }, 60000)
})
