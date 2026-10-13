/**
 * PiPiClaw - #005 Step 0 (DEV-014 机制切除): contextKind 显式贯穿验证
 *
 * ═══ 被测机制 ═══
 *   入口 (ChatManager.dispatchToAgent 派生) → think(ctx.contextKind) → run(opts.contextKind)
 *   → tool.execute(args, ctx) → execCommand(contextKind)
 *   模块态三件 (setCommandContext/getCommandContext/_ctx) 已删 — 本文件断言:
 *     S0-1: 并发场景 contextKind 逐调用独立 (无共享可变量, 旧攻击面消失)
 *     S0-2: 缺 ctx 兜底 headless (fail-safe, BashTool 侧 ?? 'headless')
 *     S0-3: think 入口派生值逐跳透传到 BashTool (im_inbound 不丢不串)
 *
 * ═══ 红线 ═══
 *   替身面 = LlmClient (vi.mock 脚本化 streamChat) + electron mock;
 *   BashTool.execute → commandDecide.execCommand → 三层决策/确认/审计【全真跑】;
 *   不放宽 mock / 不动安全链 (只消费既有注入面 setConfirmTransport/setAuditSink)。
 *
 * ═══ 回归钉 (本文件之外, 同提交原样绿) ═══
 *   tests/unit/gateway-source-injection.test.ts 5 用例 + tests/unit/chat-execution-ui.test.ts 3 用例
 *   (两文件零断言改动 — gateway 轨参数制 / chat 轨调用点已自带 contextKind, 对机制变更透明)
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import {
  execCommand,
  setConfirmTransport,
  setAuditSink,
} from '../../electron/agent/tools/commandDecide'
import { BashTool } from '../../electron/agent/tools/BashTool'
import { LlmAgentBrain } from '../../electron/agent/LlmAgentBrain'
import type { LlmToolCall } from '../../electron/agent/LlmAgentBrain'
import type { LlmStreamChunk } from '../../electron/llm/types'

// ─── 替身面 ───
vi.mock('electron', () => ({
  ipcMain: { on: vi.fn(), handle: vi.fn() },
  BrowserWindow: Object.assign(vi.fn(function () {}), { getAllWindows: () => [] }),
  shell: { openExternal: vi.fn() },
  clipboard: { readText: vi.fn(() => ''), writeText: vi.fn() },
}))

// 脚本化 LLM: 首轮 → tool_call(Bash node -e, CONFIRM 级), 次轮起 → final content
// (node 是 CONFIRM 级 — 判决依赖 contextKind, 是贯穿验证的理想探针)
const llmCallCounter = vi.hoisted(() => ({ n: 0, reset() { this.n = 0 } }))
vi.mock('../../electron/llm/LlmClient', () => ({
  LlmClient: { getInstance: () => ({
    streamChat: async function* (): AsyncGenerator<LlmStreamChunk> {
      const isFirst = ++llmCallCounter.n === 1
      if (isFirst) {
        yield { type: 'content', delta: '执行 node 探针。', accumulated: { content: '执行 node 探针。' } } as LlmStreamChunk
        yield { type: 'tool_call', toolCall: { id: 'call_prop', function: { name: 'Bash', arguments: JSON.stringify({ command: 'node', args: ['-e', 'console.log(1)'] }) } } } as unknown as LlmStreamChunk
      } else {
        yield { type: 'content', delta: '完成。', accumulated: { content: '完成。' } } as LlmStreamChunk
      }
    },
  }) },
}))

type AuditRow = Record<string, unknown>
let auditRows: AuditRow[]
const execKinds: string[] = [] // execCommand 收到的 contextKind 顺序记录 (探针)

beforeEach(() => {
  auditRows = []
  execKinds.length = 0
  // 探针 sink: 记录 contextKind + 不落盘 (setAuditSink 是 v3 既有注入面, 消费不新增)
  setAuditSink((entry) => {
    auditRows.push(entry)
    if (entry.contextKind) execKinds.push(String(entry.contextKind))
  })
  setConfirmTransport(async () => true) // ui 确认桥: 允许 (S0-1 A 链正向)
})
afterAll(() => {
  setAuditSink(null)
  setConfirmTransport(null)
})

describe('#005 Step 0 (DEV-014 切除): contextKind 显式贯穿', () => {
  it('S0-1 并发独立: A(ui) 链与 B(im_inbound) 链逐调用独立 — 无共享可变量, 判各依各的 ctx', async () => {
    // 旧攻击面 (已随模块态三件删除): B 入口写全局 _ctx='im_inbound' → A 的 BashTool 误读 B 的 kind。
    // 新机制: contextKind 逐调用参数携带 — 即使交替调度, A 的 execCommand 收到 ui, B 收到 im_inbound。
    const toolA = new BashTool() // "会话 A" 的工具实例
    const toolB = new BashTool() // "会话 B" 的工具实例

    // 交替调度 (模拟并发交错): A → B → A
    const rA1 = await toolA.execute({ command: 'node', args: ['-e', 'console.log(1)'] }, { contextKind: 'ui' })
    const rB1 = await toolB.execute({ command: 'node', args: ['-e', 'console.log(2)'] }, { contextKind: 'im_inbound' })
    const rA2 = await toolA.execute({ command: 'node', args: ['-e', 'console.log(3)'] }, { contextKind: 'ui' })

    expect(rA1.ok).toBe(true, "A1 (ui, 确认桥允许) 应执行成功")
    expect(rB1.ok).toBe(false, 'B1 (im_inbound) 的 confirm 级命令应被上下文门拒')
    expect(rB1.error).toMatch(/im_inbound|ui/, 'B1 拒绝理由应指向上下文 (非 cwd/非命令)')
    expect(rA2.ok).toBe(true, 'A2 (ui) 不受 B 链影响 — 逐调用独立')

    // 审计面: A1/A2 行 contextKind=ui; B1 行 contextKind=im_inbound (探针 sink 捕获)
    const confirmRows = auditRows.filter(r => r.phase === 'deny' && String(r.denialReason).includes('im_inbound'))
    expect(confirmRows.length).toBe(1, '恰 1 行 im_inbound deny (B1)')
    expect(confirmRows[0].contextKind).toBe('im_inbound')
  })

  it('S0-2 缺 ctx 兜底 fail-safe: execute(args) 不传 ctx → headless 判决', async () => {
    const tool = new BashTool()
    // CONFIRM 级 (node) 无 ctx → 缺省 headless → 拒 (确认门不放行)
    const r = await tool.execute({ command: 'node', args: ['-e', 'console.log(1)'] })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/headless|confirm|ui/)
    // AUTO 级 (echo) 无 ctx → headless 也放行 (判决正确面, 非一律拒)
    const rAuto = await tool.execute({ command: 'echo', args: ['safe'] })
    expect(rAuto.ok).toBe(true)
  })

  it('S0-3 think 入口派生值透传: think(ctx.contextKind=im_inbound) → run → BashTool 收到 im_inbound', async () => {
    // 入口 (ChatManager 派生值) → think(ctx) → run(opts) → tool.execute(ctx) 全链透传断言
    const brain = LlmAgentBrain.getInstance()
    // 审计探针: think 链触发 node(CONFIRM) 调用 → 拒绝行 contextKind 必须 = im_inbound
    auditRows.length = 0
    execKinds.length = 0
    const decision = await brain.think({
      conversationId: 'conv-prop',
      content: '跑 node 探针 (S0-3)',
      contextKind: 'im_inbound',
    } as any)
    expect(decision).toBeTruthy()
    // 审计行: im_inbound deny 行在场 (node confirm 级在 im_inbound 下被门拦)
    const denyIm = auditRows.filter(r => r.contextKind === 'im_inbound' && r.phase === 'deny')
    expect(denyIm.length, 'think 链的 ctx(im_inbound) 逐跳透传到咽喉, 被门拦留痕').toBeGreaterThanOrEqual(1)
    expect(denyIm[0].denialReason).toMatch(/im_inbound/)
  })

  it('S0-4 回归钉自验: gateway 轨参数制 (execCommand 直调) 对本单机制变更透明', async () => {
    // 与 gateway-source-injection 同构的最小复验 (该文件 5 用例同提交原样跑绿, 此处只锁"参数轨"语义)
    const rUi = await execCommand({ command: 'node', args: ['-e', 'console.log(1)'], contextKind: 'ui' })
    expect(rUi.ok).toBe(true)
    const rH = await execCommand({ command: 'node', args: ['-e', 'console.log(1)'], contextKind: 'headless' })
    expect(rH.ok).toBe(false)
    expect(rH.denied).toBe(true)
  })
})
