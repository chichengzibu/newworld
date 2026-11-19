#!/usr/bin/env node
/**
 * PiPiClaw Mock LLM Server (P1-T1.4)
 *
 * 模拟 OpenAI chat/completions 端点,返回可控响应。
 * 用法:
 *   node scripts/mock-llm-server.mjs [port]
 *   默认端口 9999,可通过 MOCK_LLM_PORT 环境变量覆盖
 *
 * 行为:
 *   - POST /v1/chat/completions:返回 { choices: [{ message: { content: "MOCK_RESPONSE_<ts>" } }] }
 *   - 记录所有请求到 stdout(便于 e2e 验证)
 *   - 健康检查 GET /health:返回 { status: "ok" }
 *
 * 用途:
 *   - E2E 测试"LLM 真回了" — 不用真 OpenAI API
 *   - CI 中无外网时也能跑 LLM 链路验证
 */

import { createServer } from 'node:http'

const port = parseInt(process.env.MOCK_LLM_PORT || process.argv[2] || '9999', 10)
let requestCount = 0

const server = createServer((req, res) => {
  const ts = new Date().toISOString()
  requestCount += 1

  // CORS 允许(测试期间前端可能跨域访问)
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')

  if (req.method === 'OPTIONS') {
    res.statusCode = 204
    res.end()
    return
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ status: 'ok', requestCount, uptime: process.uptime() }))
    return
  }

  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    let body = ''
    req.on('data', (chunk) => { body += chunk.toString('utf-8') })
    req.on('end', () => {
      let payload
      try {
        payload = JSON.parse(body)
      } catch {
        res.statusCode = 400
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ error: { message: 'invalid JSON' } }))
        return
      }

      // 取出 user message,生成可验证的 echo 响应
      const userMsg = (payload.messages || []).find((m) => m.role === 'user')?.content || '';
      const hasToolResult = (payload.messages || []).some((m) => m.role === 'tool');
      const marker = `MOCK_LLM_OK_${requestCount}_${userMsg.length > 0 ? 'WITH_INPUT' : 'NO_INPUT'}`
      const responseContent = `${marker}: 收到 "${userMsg.slice(0, 50)}"`

      console.log(
        `[${ts}] POST /v1/chat/completions #${requestCount} model=${payload.model} userMsgLen=${userMsg.length} -> ${responseContent.slice(0, 80)}`,
      )

      // 【M4-Q 修】支持 SSE 流式。
      // 为什么必须:app 的聊天路径走 `streamChat`,而适配器**只解析 `data:` 行**
      // (openai-compatible.ts:「if (!trimmed.startsWith('data:')) continue」)。
      // mock 原来只回普通 JSON → 一行 data: 都解析不到 → **内容永远进不来**
      // (助手气泡只有时间戳)→ 依赖 mock 的 e2e 一直在假通过。
      // 【M4-S】工具调用模式:用户消息里带 __TOOL_CALL__ → 首轮回一个 tool_calls
      // (让 agent 真的去调工具),第二轮(带 tool 结果回来)再回正文。
      // 用途:端到端验「LLM → 工具调用 → 工具执行 → 观察落盘 → tracker 记录」
      // 这条链 —— 否则 mock 只会回文本,agent 的 tool loop 永远走不到。
      const wantsToolCall = !hasToolResult && String(userMsg).includes('__TOOL_CALL__');
      if (wantsToolCall) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        const toolArgs = JSON.stringify({ pattern: '**/*.md' });
        res.write(`data: ${JSON.stringify({
          id: `mock-chatcmpl-${requestCount}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: payload.model || 'mock-gpt',
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: 0,
                id: `call_mock_${requestCount}`,
                type: 'function',
                function: { name: 'Glob', arguments: toolArgs },
              }],
            },
            finish_reason: null,
          }],
        })}\n\n`);
        res.write(`data: ${JSON.stringify({
          id: `mock-chatcmpl-${requestCount}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: payload.model || 'mock-gpt',
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      if (payload.stream === true) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        const chunks = responseContent.match(/.{1,24}/gs) ?? [responseContent];
        for (const c of chunks) {
          res.write(`data: ${JSON.stringify({
            id: `mock-chatcmpl-${requestCount}`,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: payload.model || 'mock-gpt',
            choices: [{ index: 0, delta: { content: c }, finish_reason: null }],
          })}\n\n`);
        }
        res.write(`data: ${JSON.stringify({
          id: `mock-chatcmpl-${requestCount}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: payload.model || 'mock-gpt',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: userMsg.length, completion_tokens: responseContent.length, total_tokens: userMsg.length + responseContent.length },
        })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      res.setHeader('Content-Type', 'application/json')
      res.end(
        JSON.stringify({
          id: `mock-chatcmpl-${requestCount}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: payload.model || 'mock-gpt',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: responseContent },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: userMsg.length, completion_tokens: responseContent.length, total_tokens: userMsg.length + responseContent.length },
        }),
      )
    })
    return
  }

  // 404
  res.statusCode = 404
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify({ error: { message: `not found: ${req.method} ${req.url}` } }))
})

server.listen(port, '127.0.0.1', () => {
  console.log(`[mock-llm] listening on http://127.0.0.1:${port}`)
  console.log(`[mock-llm] POST /v1/chat/completions -> mock response`)
  console.log(`[mock-llm] GET /health -> ok`)
  console.log(`[mock-llm] press Ctrl+C to stop`)
})

// 优雅关闭
process.on('SIGINT', () => {
  console.log('\n[mock-llm] shutting down...')
  server.close(() => process.exit(0))
})

process.on('SIGTERM', () => {
  server.close(() => process.exit(0))
})
