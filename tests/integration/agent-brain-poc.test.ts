/**
 * PiPiClaw - LlmAgentBrain v0.1 端到端 PoC (M1 v0.1)
 *
 * 验证 LlmAgentBrain.run() + LlmClient.streamChat() + 5 工具 端到端集成
 *
 * 策略:
 *   - mock LlmClient.streamChat (因为 vitest 跑没 llm-config, 无法调真 Ollama)
 *   - mock 返 2 轮 stream: 第 1 轮 tool_call(Glob) → 跑工具 → 第 2 轮 final content
 *   - 验证 final_answer + tool_call/tool_result 事件 + 工具执行结果
 *
 * 跟单测区别: 单测测 5 工具独立行为, 本 spec 测 LlmAgentBrain loop 编排 + 5 工具集成
 *
 * 真链路 (Ollama 11434) 端到端留给 scripts/agent-tool-call-poc.mjs (在 dist-electron 跑)
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import * as fsSync from 'node:fs'
import * as path from 'node:path'

// 路径必须与实现一致:工具走 getHost().getPath('userData') → TestHost 目录。
// 旧版此处 mkdtemp + vi.spyOn(app,'getPath') 因模块陈旧绑定不生效,
// 工具落到真 userData、测试在假目录找文件,全挂。
// 注:setup 在每用例前清空该共享目录,种子文件须在 beforeEach 重播种。
import { TEST_USER_DATA } from '../unit/test-host'
const TEST_ROOT = TEST_USER_DATA
const SANDBOX_DIR = path.join(TEST_ROOT, 'sandbox')
const WORKSPACE_DIR = path.join(TEST_ROOT, 'workspace')

function seedSandboxFiles(): void {
  fsSync.mkdirSync(SANDBOX_DIR, { recursive: true })
  fsSync.mkdirSync(WORKSPACE_DIR, { recursive: true })
  fsSync.writeFileSync(path.join(SANDBOX_DIR, 'hello.txt'), 'PiPiClaw is great\n', 'utf-8')
  fsSync.writeFileSync(path.join(SANDBOX_DIR, 'app.ts'), 'export const version = "1.0"\n', 'utf-8')
  fsSync.writeFileSync(path.join(SANDBOX_DIR, 'readme.md'), '# Notes\nversion 1.0 draft\n', 'utf-8')
}

/**
 * 【M2-B】工具权限门测试桥 —— 本文件的验证主题不是权限,只是顺带调了
 * Edit/Bash 写工具。装一个"总是同意"的桥,避免新加的 fail-safe 安全门
 * 把这些无关测试拦下。
 *
 * 护栏:主题为权限的测试【不得】使用本桥(见 ToolGate.test.ts,
 *       以及 harness-wiring 的 G3 用户拒绝用例)。
 */


import { LlmAgentBrain, LlmAgentBrainEvents, type LlmAgentEvent } from '../../electron/agent/LlmAgentBrain'
import { LlmClient } from '../../electron/llm/LlmClient'
import type { LlmStreamChunk, LlmToolCall } from '../../electron/llm/types'
import { installToolConfirmation } from '../unit/auto-confirm'

/** 【M2-B】确认桥 —— 显式传入 run(),不写全局。护栏见 auto-confirm.ts。 */
const CONFIRM_ALL = installToolConfirmation();

beforeEach(() => {
  seedSandboxFiles()
})

describe('LlmAgentBrain v0.1 端到端 (mock LLM)', () => {
  it('run → mock LLM 返 Glob tool_call → 调 Glob tool → mock LLM 返 final', async () => {
    // 1) mock LlmClient.streamChat: 第 1 轮 tool_call(Glob), 第 2 轮 final
    let callCount = 0
    const mockStream = async function* (this: LlmClient, _req: any, _signal?: AbortSignal) {
      callCount++
      if (callCount === 1) {
        const tc: LlmToolCall = {
          id: 'call_glob_1',
          type: 'function',
          function: {
            name: 'Glob',
            arguments: JSON.stringify({ pattern: '**/*.txt' }),
          },
        }
        yield { type: 'tool_call', toolCall: tc, provider: 'openai-compatible', model: 'qwen3.5:9b' } as LlmStreamChunk
        yield { type: 'done', provider: 'openai-compatible', model: 'qwen3.5:9b' } as LlmStreamChunk
      } else {
        const text = '在 sandbox 找到 1 个 .txt 文件: hello.txt (内容: "PiPiClaw is great")'
        yield { type: 'content', delta: text, accumulated: text, provider: 'openai-compatible', model: 'qwen3.5:9b' } as LlmStreamChunk
        yield { type: 'done', provider: 'openai-compatible', model: 'qwen3.5:9b' } as LlmStreamChunk
      }
    }
    const origStream = LlmClient.prototype.streamChat
    // @ts-ignore 替换方法
    LlmClient.prototype.streamChat = mockStream

    const events: LlmAgentEvent[] = []
    const unsub = LlmAgentBrainEvents.subscribe((e) => events.push(e))

    try {
      const brain = LlmAgentBrain.getInstance()
      const result = await brain.run('列出 sandbox 下的所有 .txt 文件', {
        provider: 'openai-compatible',
        model: 'qwen3.5:9b',
        tools: ['Glob'],
        maxIterations: 3,
      })

      // 验证
      expect(result.iterations).toBe(2)  // 1 tool_call iter + 1 final iter
      expect(result.toolCalls).toHaveLength(1)
      expect(result.toolCalls[0].name).toBe('Glob')
      expect(result.toolCalls[0].ok).toBe(true)
      expect(result.content).toContain('hello.txt')

      // 事件验证
      expect(events.some(e => e.type === 'run_start')).toBe(true)
      const toolCallEvents = events.filter(e => e.type === 'tool_call')
      expect(toolCallEvents).toHaveLength(1)
      expect((toolCallEvents[0] as any).name).toBe('Glob')
      expect((toolCallEvents[0] as any).args).toEqual({ pattern: '**/*.txt' })

      const toolResultEvents = events.filter(e => e.type === 'tool_result')
      expect(toolResultEvents).toHaveLength(1)
      expect((toolResultEvents[0] as any).name).toBe('Glob')
      expect((toolResultEvents[0] as any).ok).toBe(true)
      expect((toolResultEvents[0] as any).result).toContain('hello.txt')

      const finalEvents = events.filter(e => e.type === 'final_answer')
      expect(finalEvents).toHaveLength(1)
      expect((finalEvents[0] as any).content).toContain('hello.txt')
    } finally {
      // @ts-ignore 还原
      LlmClient.prototype.streamChat = origStream
      unsub()
    }
  }, 30000)

  it('run → mock LLM 返 Read tool_call → 调 Read tool → 返文件内容', async () => {
    let callCount = 0
    const mockStream = async function* (this: LlmClient) {
      callCount++
      if (callCount === 1) {
        const tc: LlmToolCall = {
          id: 'call_read_1',
          type: 'function',
          function: { name: 'Read', arguments: JSON.stringify({ file_path: 'hello.txt' }) },
        }
        yield { type: 'tool_call', toolCall: tc, provider: 'openai-compatible', model: 'qwen3.5:9b' } as LlmStreamChunk
        yield { type: 'done', provider: 'openai-compatible', model: 'qwen3.5:9b' } as LlmStreamChunk
      } else {
        const text = 'hello.txt 内容: "PiPiClaw is great"'
        yield { type: 'content', delta: text, accumulated: text, provider: 'openai-compatible', model: 'qwen3.5:9b' } as LlmStreamChunk
        yield { type: 'done', provider: 'openai-compatible', model: 'qwen3.5:9b' } as LlmStreamChunk
      }
    }
    const origStream = LlmClient.prototype.streamChat
    // @ts-ignore
    LlmClient.prototype.streamChat = mockStream

    try {
      const brain = LlmAgentBrain.getInstance()
      const result = await brain.run('读 hello.txt 内容', {
        provider: 'openai-compatible',
        model: 'qwen3.5:9b',
        tools: ['Read'],
        maxIterations: 3,
      })

      expect(result.iterations).toBe(2)
      expect(result.toolCalls[0].name).toBe('Read')
      expect(result.toolCalls[0].ok).toBe(true)
      expect(result.content).toContain('PiPiClaw is great')
    } finally {
      // @ts-ignore
      LlmClient.prototype.streamChat = origStream
    }
  }, 30000)

  it('run → mock LLM 返 Edit tool_call → 调 Edit tool → 验证文件已改', async () => {
    // 先备份
    const file = path.join(SANDBOX_DIR, 'edit-target.txt')
    fsSync.writeFileSync(file, 'name=old\nname=other\n', 'utf-8')

    let callCount = 0
    const mockStream = async function* (this: LlmClient) {
      callCount++
      if (callCount === 1) {
        const tc: LlmToolCall = {
          id: 'call_edit_1',
          type: 'function',
          function: {
            name: 'Edit',
            arguments: JSON.stringify({
              file_path: 'edit-target.txt',
              old_string: 'name=other',
              new_string: 'name=new',
            }),
          },
        }
        yield { type: 'tool_call', toolCall: tc, provider: 'openai-compatible', model: 'qwen3.5:9b' } as LlmStreamChunk
        yield { type: 'done', provider: 'openai-compatible', model: 'qwen3.5:9b' } as LlmStreamChunk
      } else {
        const text = '已修改 edit-target.txt, name=other 改为 name=new'
        yield { type: 'content', delta: text, accumulated: text, provider: 'openai-compatible', model: 'qwen3.5:9b' } as LlmStreamChunk
        yield { type: 'done', provider: 'openai-compatible', model: 'qwen3.5:9b' } as LlmStreamChunk
      }
    }
    const origStream = LlmClient.prototype.streamChat
    // @ts-ignore
    LlmClient.prototype.streamChat = mockStream

    try {
      const brain = LlmAgentBrain.getInstance()
      const result = await brain.run('把 edit-target.txt 里的 name=other 改为 name=new', {
        provider: 'openai-compatible',
        model: 'qwen3.5:9b',
        tools: ['Edit'],
        maxIterations: 3,
        // 【M2-B】EditTool 是写操作,权限门要求确认桥 + UI 上下文。
        // 本用例主题是"EditTool 真的能改文件",不是权限 ——
        // 故显式声明有人在旁边并已同意(护栏见 auto-confirm.ts)。
        contextKind: 'ui',
        requestToolConfirmation: CONFIRM_ALL,
      })

      expect(result.iterations).toBe(2)
      expect(result.toolCalls[0].name).toBe('Edit')
      expect(result.toolCalls[0].ok).toBe(true)

      // 验证文件真改了
      const content = fsSync.readFileSync(file, 'utf-8')
      expect(content).toBe('name=old\nname=new\n')
    } finally {
      // @ts-ignore
      LlmClient.prototype.streamChat = origStream
      // 还原
      fsSync.writeFileSync(file, 'name=old\nname=other\n', 'utf-8')
    }
  }, 30000)

  it('run → mock LLM 立即 final → 0 tool calls, 1 iter', async () => {
    const mockStream = async function* (this: LlmClient) {
      const text = '你好, 我是 PiPiClaw 代码助手.'
      yield { type: 'content', delta: text, accumulated: text, provider: 'openai-compatible', model: 'qwen3.5:9b' } as LlmStreamChunk
      yield { type: 'done', provider: 'openai-compatible', model: 'qwen3.5:9b' } as LlmStreamChunk
    }
    const origStream = LlmClient.prototype.streamChat
    // @ts-ignore
    LlmClient.prototype.streamChat = mockStream

    try {
      const brain = LlmAgentBrain.getInstance()
      const result = await brain.run('简单打招呼', {
        provider: 'openai-compatible',
        model: 'qwen3.5:9b',
        maxIterations: 3,
      })

      expect(result.iterations).toBe(1)
      expect(result.toolCalls).toHaveLength(0)
      expect(result.content).toContain('PiPiClaw')
    } finally {
      // @ts-ignore
      LlmClient.prototype.streamChat = origStream
    }
  }, 30000)

  it('run → maxIterations=2 强制结束 (mock 一直 tool_call)', async () => {
    let callCount = 0
    const mockStream = async function* (this: LlmClient) {
      callCount++
      // 每轮都返 tool_call, 不 final
      const tc: LlmToolCall = {
        id: `call_loop_${callCount}`,
        type: 'function',
        function: { name: 'Glob', arguments: JSON.stringify({ pattern: '*.txt' }) },
      }
      yield { type: 'tool_call', toolCall: tc, provider: 'openai-compatible', model: 'qwen3.5:9b' } as LlmStreamChunk
      yield { type: 'done', provider: 'openai-compatible', model: 'qwen3.5:9b' } as LlmStreamChunk
    }
    const origStream = LlmClient.prototype.streamChat
    // @ts-ignore
    LlmClient.prototype.streamChat = mockStream

    const events: LlmAgentEvent[] = []
    const unsub = LlmAgentBrainEvents.subscribe((e) => events.push(e))

    try {
      const brain = LlmAgentBrain.getInstance()
      const result = await brain.run('一直找文件', {
        provider: 'openai-compatible',
        model: 'qwen3.5:9b',
        maxIterations: 2,
      })

      expect(result.iterations).toBe(2)
      expect(result.toolCalls).toHaveLength(2)
      expect(events.some(e => e.type === 'run_error' && (e as any).error.includes('超过 max iterations'))).toBe(true)
    } finally {
      // @ts-ignore
      LlmClient.prototype.streamChat = origStream
      unsub()
    }
  }, 30000)
})

describe('LlmAgentBrain v0.1 工具列表 (5 工具)', () => {
  it('listTools 返 6 工具 metadata (Read/Edit/Bash/Glob/Grep/load_skill)', () => {
    const brain = LlmAgentBrain.getInstance()
    const tools = brain.listTools()
    // 【M4-A】新增 load_skill —— 渐进披露的 L2 加载入口
    expect(tools).toHaveLength(6)
    const names = tools.map(t => t.name).sort()
    expect(names).toEqual(['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'load_skill'])
    // 验证每个有 description + parameters
    for (const t of tools) {
      expect(t.description).toBeTruthy()
      expect(t.parameters).toBeTruthy()
      expect(typeof t.requiresPermission).toBe('boolean')
    }
  })
})
