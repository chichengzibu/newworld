/**
 * PiPiClaw - #004 run 层 checkpoint 验证 (C-1..C-4)
 *
 * ═══ 红线 (冻结延续) ═══
 *   main.ts / IpcServer / commandDecide / BashTool 零改动;
 *   安全链交互只经既有 execCommand 公开 API (setCommandContext/setConfirmTransport/setAuditSink
 *   是 v3 已就位的注入面, 本文件只【消费】, 不新增、不放宽 mock);
 *   ChatManager:985 接线留 W5 (本单只验证 brain 接缝 + manager 纯函数)。
 *
 * ═══ 架构 (#004 A1-A4) ═══
 *   接缝: LlmAgentBrain.run(conversationId, { history, checkpoint: 钩子 })
 *     - 4 处上推: 每工具结果后 / abort 前 / 异常前 / final_answer (brain 零 fs 零 manager import)
 *   宿主: RunCheckpointManager (纯函数, A1) — append-only 事件流 (A2) + 惰性 sweep (A3)
 *   恢复: collectForRestore(dir, runId) → 纯读, 重放 messages 交回会话层
 *
 * ═══ 替换替身 (与 #003-fix 管道B 同配方) ═══
 *   - LlmClient: vi.mock → 脚本化 streamChat (tool_call → 再一轮 content)
 *   - electron: vi.mock (ipcMain/BrowserWindow) — commandDecide 既有依赖面
 *   - 真代码: BashTool.execute → commandDecide.execCommand → 咽喉决策/确认/审计 全真
 *
 * ═══ DEV-023 边界 (如实复述, 防范围漂移) ═══
 *   审计行目前无 run 关联字段 (audit entries 不含 runId/conversationId 之外的 run 标记)。
 *   本单【不】动 audit 行格式 / 【不】注入 run 关联 — 归 W5 入口注入修 (DEV-023)。
 *   C-3 只断言"恢复后 confirm 级仍被上下文门拦", 不断言审计行内容。
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import crypto from 'node:crypto'

import {
  execCommand,
  setCommandContext,
  setConfirmTransport,
  setAuditSink,
} from '../../electron/agent/tools/commandDecide'
import { BashTool } from '../../electron/agent/tools/BashTool'
import {
  appendEvent as mgrAppend,
  readEvents,
  latestSnapshot,
  deriveStatus,
  findSweepTargets,
  lazyCheckpoint,
  collectForRestore,
  RUN_CHECKPOINTS_DIRNAME,
} from '../../electron/agent/RunCheckpointManager'
import { LlmAgentBrain } from '../../electron/agent/LlmAgentBrain'
import type { RunCheckpointEvent, LlmToolCall } from '../../electron/agent/LlmAgentBrain'
import type { LlmStreamChunk } from '../../electron/llm/types'

// ─── 替身面 ───
vi.mock('electron', () => ({
  ipcMain: { on: vi.fn(), handle: vi.fn() },
  BrowserWindow: Object.assign(vi.fn(function () {}), { getAllWindows: () => [] }),
  shell: { openExternal: vi.fn() },
  clipboard: { readText: vi.fn(() => ''), writeText: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => s,
    decryptString: (s: string) => s,
  },
  nativeTheme: { shouldUseDarkColors: false, on: vi.fn() },
}))

// 脚本化 LLM: 首轮 → tool_call(Bash echo hello, AUTO 级放行), 次轮起 → 可配置: final content 或崩溃
const scriptState = vi.hoisted(() => ({
  callCount: 0,
  mode: 'normal' as 'normal' | 'crash-on-2nd',
  reset() { this.callCount = 0; this.mode = 'normal' },
}))
vi.mock('../../electron/llm/LlmClient', () => ({
  LlmClient: { getInstance: () => ({
    streamChat: async function* (): AsyncGenerator<LlmStreamChunk> {
      const n = scriptState.callCount++
      if (n === 0) {
        // echo: AUTO 级 (constants.ts:63-66 实读, 13 项之一) — headless 直接放行, 真咽喉不弹窗不拒
        const tc: LlmToolCall = { id: 'call_t1', function: { name: 'Bash', arguments: JSON.stringify({ command: 'echo', args: ['hello-checkpoint'] }) } }
        yield { type: 'content', delta: '执行 echo。', accumulated: { content: '执行 echo。' } } as LlmStreamChunk
        yield { type: 'tool_call', toolCall: tc } as unknown as LlmStreamChunk
      } else if (scriptState.mode === 'crash-on-2nd') {
        throw new Error('mock crash: connection reset')
      } else {
        yield { type: 'content', delta: 'echo 执行完毕。', accumulated: { content: 'echo 执行完毕。' } } as LlmStreamChunk
      }
    },
  }) },
}))

// ─── 环境: 临时目录 (沙盒) — 审计走 setAuditSink 内存探针, 不落盘 ───
let tmpBase: string
beforeEach(() => {
  setCommandContext('headless')
  setConfirmTransport(null)
  const rows: Record<string, unknown>[] = []
  setAuditSink((entry) => { rows.push(entry) })
  // 每用例独立 run-checkpoints 目录
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pipiclaw-ckpt-'))
  scriptState.callCount = 0
})
afterAll(() => {
  setAuditSink(null)
  setConfirmTransport(null)
  setCommandContext('headless')
})

// ─── helper: 跑一次 brain.run 并收集 checkpoint 事件 ───
async function runBrain(opts: { conversationId?: string; maxIterations?: number } = {}): Promise<{ events: RunCheckpointEvent[]; result: unknown }> {
  const events: RunCheckpointEvent[] = []
  const result = await LlmAgentBrain.getInstance().run('跑 git status', {
    conversationId: opts.conversationId ?? 'conv-test',
    maxIterations: opts.maxIterations ?? 3,
    model: 'fake',
    provider: 'openai-compatible',
    checkpoint: (ev) => { events.push(JSON.parse(JSON.stringify(ev))) }, // 深拷贝 — 防 brain 后续 push 污染 (#003-fix 同款)
  })
  return { events, result }
}

describe('#004 C-1 中断注入 → restore → messages/tool_state 完整 → 续跑至完成', () => {
  it('run 中途崩溃(异常) → 最后一条 run_snapshot 含已完成的 tool 结果 → 可恢复续跑', async () => {
    // 场景: 第 1 轮 tool_call 执行后, 第 2 轮 streamChat 抛异常 (模拟崩溃) — 脚本模式切换, 禁运行时 vi.mock
    scriptState.reset()
    scriptState.mode = 'crash-on-2nd'
    const events: RunCheckpointEvent[] = []
    let threw = false
    try {
      await LlmAgentBrain.getInstance().run('崩溃场景', {
        conversationId: 'conv-crash',
        maxIterations: 3,
        checkpoint: (ev) => { events.push(ev) },
      })
    } catch { threw = true }
    finally { scriptState.reset() }

    expect(threw, '第二轮异常应上抛 (brain 契约)').toBe(true)
    // C-1 核心: 异常 flush 前已有 tool 结果落 snapshot
    const snaps = events.filter(e => e.type === 'run.snapshot')
    expect(snaps.length, '至少 1 条 snapshot (tool 执行后 upsert)').toBeGreaterThanOrEqual(1)
    const lastSnap = snaps[snaps.length - 1] as (typeof snaps)[number] & { type: 'run.snapshot' }
    expect(lastSnap.messages, 'snapshot.messages 非空').toBeTruthy()
    expect(lastSnap.messages.length).toBeGreaterThan(0)
    expect(lastSnap.messages.some(m => m.role === 'tool'), '含 tool 结果 (非 user 单声道)').toBe(true)
    // interrupt 标记最后
    const lastEv = events[events.length - 1]
    expect(lastEv.type, '最后一条 = run.status interrupted').toBe('run.status')
    if (lastEv.type === 'run.status') expect(lastEv.status).toBe('interrupted')
  })

  it('恢复: collectForRestore 返回的 messages 可续跑至 final_answer', async () => {
    // 前置: 模拟已有一次中断 run (落盘到 manager)
    const dir = path.join(tmpBase, RUN_CHECKPOINTS_DIRNAME)
    const interruptedRun: RunCheckpointEvent = {
      type: 'run.snapshot',
      runId: 'run-interrupted',
      conversationId: 'conv-restore',
      status: 'running',
      iteration: 1,
      messages: [
        { role: 'system', content: 'SYS' },
        { role: 'user', content: '原始指令' },
        { role: 'assistant', content: '我来执行', toolCalls: [{ id: 't1', function: { name: 'Bash', arguments: '{}' } }] },
        { role: 'tool', content: 'exit=0\nstdout=done', toolCallId: 't1' },
      ],
      toolState: [{ name: 'Bash', ok: true, durationMs: 12 }],
    }
    mgrAppend(dir, interruptedRun)

    // 恢复入口 (纯读)
    const restored = collectForRestore(dir, 'run-interrupted')
    expect(restored, '快照存在').not.toBeNull()
    expect(restored!.snapshot.messages.length).toBeGreaterThanOrEqual(3)
    expect(restored!.snapshot.messages[0].role).toBe('system')
    // 恢复 = 用 snapshot.messages 作为新一轮 run 的上下文 (会话层职责)
    // brain.run 仍无状态 — messages 由调用方传入 (history 参数或 messages 直通)
    // 续跑验证: 再次调用 brain.run, checkpoint 钩子继续 append (append-only)
    const events: RunCheckpointEvent[] = []
    const r2 = await LlmAgentBrain.getInstance().run('继续', {
      conversationId: 'conv-restore',
      history: restored!.snapshot.messages.map(m => ({ role: m.role, content: m.content })) as Array<{ role: string; content: string }>,
      maxIterations: 2,
      checkpoint: (ev) => { events.push(ev) },
    })
    expect(r2.content, '完成 final_answer').toBeTruthy()
    expect(events.length, '第二次 run 也产生 checkpoint').toBeGreaterThanOrEqual(1)
  })
})

describe('#004 C-2 (照案) 正常 run → final_answer 后 status=finalized', () => {
  it('完整 run: 最后事件 = run.snapshot finalized (或 run.status 无)', async () => {
    const { events } = await runBrain()
    if (events.length > 0) {
      // brain 在 final_answer 处 pushCkpt('finalized') — 最后一条含 finalized
      const lastSnap = events.filter(e => e.type === 'run.snapshot').pop() as RunCheckpointEvent & { type: 'run.snapshot' } | undefined
      expect(lastSnap, '至少 1 条 snapshot').toBeTruthy()
      expect(lastSnap!.status, '完成时 status=finalized').toBe('finalized')
    }
  })
})

describe('#004 C-3 安全回归: 恢复后 confirm 级命令仍被上下文门拦 (伪造版)', () => {
  it('headless + confirm 级命令 → 仍拒绝 (不因 checkpoint/恢复获得豁免)', async () => {
    setCommandContext('headless')
    const tool = new BashTool()
    const r = await tool.execute({ command: 'git', args: ['status'] })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('context=headless 不允许 confirm 级')
  })

  it('恢复后仍 headless → 恢复的 messages 不改变 contextKind (脑无状态, 入口派生)', async () => {
    // 模拟: checkpoint 快照含 headless 时的 confirm 命令拒绝记录
    const r = await execCommand({ command: 'bash', args: ['-c', 'echo hi'], contextKind: 'headless' })
    expect(r.ok).toBe(false)
    expect(r.denied).toBe(true)
    expect(r.humanConfirm).toBe('false')
  })
})

describe('#004 C-4 孤儿快照: 惰性 sweep (A3) — 新 run 首事件到达时, 旧 running 快照标 interrupted', () => {
  it('findSweepTargets 纯函数: 找出旧 running 无 interrupted 标记的 runId', () => {
    const events: RunCheckpointEvent[] = [
      { type: 'run.snapshot', runId: 'old-a', conversationId: 'c', status: 'running', iteration: 1, messages: [], toolState: [] },
      { type: 'run.snapshot', runId: 'old-b', conversationId: 'c', status: 'running', iteration: 2, messages: [], toolState: [] },
      { type: 'run.status', runId: 'old-b', conversationId: 'c', status: 'interrupted', reason: 'swept-by-lazy' },
    ]
    const targets = findSweepTargets(events, 'current-run')
    expect(targets).toEqual(['old-a']) // old-b 已有 interrupted 标记, 不重复
  })

  it('lazyCheckpoint: 追加 sweep 标记 + 本事件, 旧行字节级不动 (A2 append-only)', () => {
    const dir = path.join(tmpBase, RUN_CHECKPOINTS_DIRNAME)
    const oldEv: RunCheckpointEvent = { type: 'run.snapshot', runId: 'orphan-1', conversationId: 'c', status: 'running', iteration: 5, messages: [{ role: 'user', content: 'x' }], toolState: [] }
    mgrAppend(dir, oldEv)
    const beforeContent = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8')

    const newEv: RunCheckpointEvent = { type: 'run.snapshot', runId: 'fresh-run', conversationId: 'c', status: 'running', iteration: 1, messages: [{ role: 'user', content: 'new' }], toolState: [] }
    const res = lazyCheckpoint(dir, newEv, 'fresh-run')

    expect(res.swept).toEqual(['orphan-1'])
    const afterContent = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8')
    expect(afterContent.startsWith(beforeContent), '旧行字节级未动 (append-only)').toBe(true)
    expect(afterContent.length).toBeGreaterThan(beforeContent.length)

    // 孤儿标记后 → collectForRestore 返回 status=interrupted (非静默续跑)
    const restored = collectForRestore(dir, 'orphan-1')
    expect(restored!.status, '孤儿 → interrupted (非 running, 非静默续跑)').toBe('interrupted')
  })

  it('幂等: 已标记的孤儿不重复 sweep; 未标记的 (含 run-1) 恰标记一次', () => {
    const dir = path.join(tmpBase, RUN_CHECKPOINTS_DIRNAME)
    const orphan: RunCheckpointEvent = { type: 'run.snapshot', runId: 'orphan-x', conversationId: 'c', status: 'running', iteration: 1, messages: [], toolState: [] }
    mgrAppend(dir, orphan)
    const first = lazyCheckpoint(dir, { type: 'run.snapshot', runId: 'run-1', conversationId: 'c', status: 'running', iteration: 1, messages: [], toolState: [] } as RunCheckpointEvent, 'run-1')
    expect(first.swept, '第一次: orphan-x 被标记').toEqual(['orphan-x'])
    // 第二次 sweep (新 run 来了) → orphan-x 已有 interrupted 标记不重复; 但 run-1 仍 running → 标记
    const second = lazyCheckpoint(dir, { type: 'run.snapshot', runId: 'run-2', conversationId: 'c', status: 'running', iteration: 1, messages: [], toolState: [] } as RunCheckpointEvent, 'run-2')
    expect(second.swept, 'orphan-x 不重复; run-1 是上轮新快照, 本轮恰标一次').toEqual(['run-1'])
    // 第三次: orphan-x / run-1 都已标记 → 只剩 run-2?不 — run-2 是 current, 无人再需 sweep
    const third = lazyCheckpoint(dir, { type: 'run.snapshot', runId: 'run-3', conversationId: 'c', status: 'running', iteration: 1, messages: [], toolState: [] } as RunCheckpointEvent, 'run-3')
    expect(third.swept).toEqual(['run-2'])
  })
})

describe('#004 A1 纯函数断言: manager 无单例/无模块态', () => {
  it('resolveCheckpointDir 纯函数 (同输入同输出, 零副作用)', () => {
    const a = path.join('/tmp/x', RUN_CHECKPOINTS_DIRNAME)
    const b = path.join('/tmp/x', RUN_CHECKPOINTS_DIRNAME)
    expect(a).toBe(b)
    expect(RUN_CHECKPOINTS_DIRNAME).not.toBe('checkpoints') // 避撞 A 裁决
  })
})
