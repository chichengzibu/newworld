// New World + Ollama 真链路集成测试
// 跑 6 个真实场景,验证 LlmClient 在 Ollama 上的表现
// 环境预检(NOVA #003-A / DEV-029): 指定模型 tag 不在本机 → S1-S6 显式 SKIP + [SKIP] 日志, 不污染电池信号;
// 模型在位时 S1-S6 断言一字不动(非放宽, 仅前置条件显式化)。

import { describe, it, expect, beforeAll } from 'vitest'
import { vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((k: string) => `/tmp/newworld-ollama-test-${k}`),
    getName: () => 'newworld',
    getVersion: () => '4.2.0',
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn((s: string) => Buffer.from(s, 'utf-8')),
    decryptString: vi.fn((b: Buffer) => b.toString('utf-8')),
  },
}))

vi.mock('electron-log', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, transports: { file: { resolvePathFn: () => {}, maxSize: 0, format: '' }, console: { level: 'info' } } },
}))

import { LlmConfigStore } from '../../electron/llm/LlmConfigStore'
import { LlmClient } from '../../electron/llm/LlmClient'

const OLLAMA_BASE = 'http://localhost:11434/v1'
const OLLAMA_HOST = 'http://localhost:11434'
const MODEL = process.env.OLLAMA_MODEL || 'qwen3:14b'

// === NOVA #003-A / DEV-029: 环境预检 (前置条件显式化, 非放宽) ===
// 时序关键(vitest runner 实测 node_modules/@vitest/runner/dist/index.js:518-520):
//   it.skipIf(condition) 声明只 1 参, 多余 rest 全部被 JS 忽略 —— 实测它只返回 this / this.skip
//   不能带 name/timeout, 会全部丢失(12ms 假通过)。
// 因此 S1-S6 改用官方 context.skip(condition, message) 模式(vitest 文档明确标注):
//   it('S#', async (ctx) => { if (!MODEL_PRESENT) return ctx.skip('[SKIP] ... <tag>') ... })
// 该 API 执行时判 condition, 触发 vitest SKIP 语义(用例显示为 skip, 后续断言不执行),
// 且 name/timeout 都正常保留。
//
// 探测端点: http://localhost:11434/api/tags (Ollama 原生模型列举端点, 3s 超时)
// 语义: 仅决定 MODEL_PRESENT(S1-S6 是否显式 SKIP), 不决定 host 可达性 —— 后者仍由 beforeAll 硬断言 /api/version(既有语义保持)。
//   · host 不可达(连不上 / 3s 超时)→ 顶层 fetch 抛, catch 兜底 MODEL_PRESENT=true; beforeAll 仍硬断言 /api/version 先失败 → 用例根本跑不了, 显式暴露(A 分支, host 可达性判定保持既有语义)。
//   · host 可达 / tag 在位  → MODEL_PRESENT=true  → S1-S6 正常执行(name/timeout/断言均与 pre-#003-A 一致)。
//   · host 可达 / tag 缺位  → MODEL_PRESENT=false → S1-S6 显式 SKIP + [SKIP] 日志(执行时判)。
//   · /api/tags 接口异常(host 可达但 tags 5xx/不可解析)→ MODEL_PRESENT=true 兜底: 让 S1-S6 正常执行(host 可达 + 模型在位的可能性下, 不应因 tags 单点故障把真链路误判为缺位)。
let MODEL_PRESENT = true // 默认 true = 不干扰既有行为; tags 验证明确缺位时才置 false
try {
  const res = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: AbortSignal.timeout(3000) })
  if (res.ok) {
    const body = (await res.json().catch(() => null)) as { models?: { name: string }[] } | null
    const tags = (body?.models ?? []).map((m) => m.name)
    if (!tags.includes(MODEL)) {
      MODEL_PRESENT = false
      console.warn(`[SKIP] Ollama host lacks model ${MODEL} (in place: ${tags.length ? tags.join(', ') : 'none'}) — S1-S6 显式 SKIP, 非放宽: 模型在位时断言不变`)
    }
    // tags.ok 且 MODEL 在位 → MODEL_PRESENT 保持 true
  }
  // res.ok=false / json 失败 → MODEL_PRESENT 保持 true(兜底, 不干扰 host 可达场景)
} catch {
  // host 不可达(连不上 / 3s 超时)→ MODEL_PRESENT 保持 true 兜底, 交给 beforeAll 硬抛
}

// S1-S6 共用的 skipif shim: NOVA #003-A — 模型不在则显式 SKIP, 模型在位则 return undefined 由调用方继续
function maybeSkipModel(ctx: { skip: (msg?: string) => void }): void {
  if (!MODEL_PRESENT) {
    ctx.skip(`[SKIP] Ollama host lacks model ${MODEL} (见 [SKIP] 日志) — 非放宽: 模型在位时断言不变`)
  }
}

describe('P5-UX: New World + Ollama 真链路 e2e', () => {
  beforeAll(async () => {
    // 既有硬失败语义保持: host 不可达时 beforeAll 硬断言失败 → 用例根本不跑, 显式暴露(A 分支)
    const r = await fetch(`${OLLAMA_HOST}/api/version`)
    expect(r.ok).toBe(true)
    const store = LlmConfigStore.getInstance()
    store.set('openai', {
      apiKey: 'ollam...ed',
      apiBaseUrl: OLLAMA_BASE,
      defaultModel: MODEL,
      enabled: true,
    })
  })

  it('S1: 简单问答', async (ctx) => {
    maybeSkipModel(ctx)
    const client = LlmClient.getInstance()
    const r = await client.chat({
      model: MODEL,
      messages: [{ role: 'user', content: '用一句话(不超过 50 字)解释 New World' }],
      maxTokens: 200,
      temperature: 0.7,
    })
    expect(r.ok).toBe(true)
    expect(r.content.length).toBeGreaterThan(0)
    console.log(`  S1: ${r.durationMs}ms, content="${r.content.slice(0, 100)}"`)
    if (r.usage) {
      console.log(`  S1 usage: prompt=${r.usage.promptTokens} completion=${r.usage.completionTokens}`)
    }
  }, 60000)

  it('S2: 工具调用(完整透传 + 解析)', async (ctx) => {
    maybeSkipModel(ctx)
    const client = LlmClient.getInstance()
    const r = await client.chat({
      model: MODEL,
      messages: [{ role: 'user', content: '北京今天天气怎么样?' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: '获取指定城市的天气',
            parameters: {
              type: 'object',
              properties: { city: { type: 'string' } },
              required: ['city'],
            },
          },
        },
      ],
      maxTokens: 500,
    })
    expect(r.ok).toBe(true)
    console.log(`  S2: ${r.durationMs}ms`)
    console.log(`  S2 content: ${r.content.slice(0, 80)}`)
    if (r.toolCalls && r.toolCalls.length > 0) {
      console.log(`  S2 ✓ tool_calls: ${r.toolCalls.length} 个`)
      r.toolCalls.forEach((tc, i) => {
        console.log(`    [${i}] ${tc.function.name}(${tc.function.arguments})`)
      })
      // 验证参数是北京
      const args = JSON.parse(r.toolCalls[0].function.arguments)
      expect(args.city).toContain('北京')
    } else {
      console.log(`  S2 ✗ 模型未调工具(降级为普通回答)`)
    }
  }, 60000)

  it('S3: 长 prompt', async (ctx) => {
    maybeSkipModel(ctx)
    const client = LlmClient.getInstance()
    const r = await client.chat({
      model: MODEL,
      messages: [
        { role: 'system', content: '你是 New World,简洁桌面 AI 助手' },
        { role: 'user', content: '帮我写 200 字 PR 描述,主题:统一 5 套主题为 light/dark' },
      ],
      maxTokens: 400,
    })
    expect(r.ok).toBe(true)
    expect(r.content.length).toBeGreaterThan(20)
    console.log(`  S3: ${r.durationMs}ms, ${r.content.length} chars`)
  }, 60000)

  it('S4: 多轮上下文保留', async (ctx) => {
    maybeSkipModel(ctx)
    const client = LlmClient.getInstance()
    const ctx_2: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
      { role: 'system', content: '你是 New World' },
      { role: 'user', content: '我叫什么?' },
    ]
    const r1 = await client.chat({ model: MODEL, messages: ctx_2, maxTokens: 80 })
    ctx_2.push({ role: 'assistant', content: r1.content })
    ctx_2.push({ role: 'user', content: '我叫小明,做 Python' })
    const r2 = await client.chat({ model: MODEL, messages: ctx_2, maxTokens: 80 })
    ctx_2.push({ role: 'assistant', content: r2.content })
    ctx_2.push({ role: 'user', content: '你还记得我叫什么?' })
    const r3 = await client.chat({ model: MODEL, messages: ctx_2, maxTokens: 200 })
    // 记住名字 OR 提到上下文(模型在思考)
    const remember = r3.content.includes('小明')
    const acknowledgesContext = r3.content.includes('你还记得') || r3.content.includes('之前') || r3.content.includes('小明')
    console.log(`  S4 R1: ${r1.durationMs}ms "${r1.content.slice(0, 50)}"`)
    console.log(`  S4 R2: ${r2.durationMs}ms "${r2.content.slice(0, 50)}"`)
    console.log(`  S4 R3: ${r3.durationMs}ms "${r3.content.slice(0, 50)}"`)
    console.log(`  S4 记住名字: ${remember ? 'YES' : 'NO'}, 提及上下文: ${acknowledgesContext ? 'YES' : 'NO'}`)
    // 至少要在尝试回答(不是空)
    expect(r3.content.length).toBeGreaterThan(5)
  }, 120000)

  it('S5: 错误处理 — 不存在的模型', async (ctx) => {
    maybeSkipModel(ctx)
    const client = LlmClient.getInstance()
    const r = await client.chat({
      model: 'nonexistent-model-xxx',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 50,
    })
    expect(r.ok).toBe(false)
    expect(r.error).toBeDefined()
    console.log(`  S5 error: ${(r.error || '').slice(0, 150)}`)
  }, 30000)

  it('S6: 流式响应(直接走 Ollama API,带 reasoning 兼容)', async (ctx) => {
    maybeSkipModel(ctx)
    const start = Date.now()
    let firstChunkAt: number | null = null
    let chunks = 0
    let content = ''
    let reasoning = ''
    const res = await fetch(`${OLLAMA_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: '写一首 4 句关于秋天的小诗' }],
        stream: true,
        max_tokens: 500,
      }),
    })
    expect(res.ok).toBe(true)
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (firstChunkAt === null) firstChunkAt = Date.now() - start
      chunks++
      const text = decoder.decode(value, { stream: true })
      for (const line of text.split('\n').filter(Boolean)) {
        if (line.startsWith('data: ')) {
          const payload = line.slice(6)
          if (payload === '[DONE]') continue
          try {
            const j = JSON.parse(payload)
            const d = j.choices?.[0]?.delta
            if (d?.content) content += d.content
            if (d?.reasoning) reasoning += d.reasoning
          } catch {}
        }
      }
    }
    const total = content.length + reasoning.length
    console.log(`  S6: TTFB ${firstChunkAt}ms, total ${Date.now() - start}ms, ${chunks} chunks`)
    console.log(`  S6 content: ${content.length} chars, reasoning: ${reasoning.length} chars`)
    if (content) console.log(`  S6 content 预览: ${content.slice(0, 100)}`)
    if (reasoning && !content) console.log(`  S6 reasoning 预览: ${reasoning.slice(0, 100)}`)
    expect(total).toBeGreaterThan(10)
  }, 60000)
})
