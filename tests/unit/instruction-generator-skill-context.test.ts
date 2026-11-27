/**
 * New World — M2-C 回归测试:systemPrompt 不得含 "[object Promise]"
 *
 * 【这个 bug 的性质】
 * InstructionGenerator.ts:256 调用 async 的 getSkillContext 时漏了 await,
 * 于是 matchedSkillContext 是一个 Promise 对象而非字符串。
 * 后果:
 *   - L311 `if (matchedSkillContext)` 恒为真(Promise 对象永不为空)
 *   - 模板插值把 Promise 字符串化 → systemPrompt 里出现字面量
 *     "[object Promise]"
 *   - 用户的每一轮对话都在向 LLM 发送这段垃圾
 *
 * 这类 bug 不会被"功能测试失败"发现 —— 它让程序仍然跑通,只是变蠢。
 * 所以必须有一条断言直接盯住 prompt 内容。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { TestHost } from './test-host'

describe('M2-C InstructionGenerator prompt 洁净性', () => {
  beforeEach(async () => {
    // 同 plan-confirmation.test: 不能用 vi.resetModules(),它会清掉
    // electron-setup 注入的 PlatformHost,导致 getHost() 抛未初始化
    const { setHost } = await import('../../electron/platform/runtime')
    setHost(new TestHost())
  })

  it('await 到位后,注入的技能上下文是真实字符串而非 [object Promise]', async () => {
    // 直接验证 SkillLoader 的契约:它返回 string,调用方 await 后才拿到
    const { SkillLoader } = await import('../../electron/skill/SkillLoader')
    const loader = SkillLoader.getInstance()

    const promise = loader.getSkillContext('帮我整理文件')
    expect(typeof (promise as unknown as { then?: unknown }).then).toBe('function')

    const resolved = await promise
    expect(typeof resolved).toBe('string')
    expect(resolved).not.toContain('[object Promise]')
  })

  it('InstructionGenerator 源码层面不得存在无 await 的 getSkillContext 调用', async () => {
    // 静态护栏:防止有人再把 await 删掉。
    // 匹配 "getSkillContext(" 但前面(同一行)没有 await 的调用。
    const fs = await import('node:fs')
    const path = await import('node:path')
    const src = fs.readFileSync(
      path.join(process.cwd(), 'electron/task/InstructionGenerator.ts'),
      'utf-8',
    )
    const badLines = src
      .split('\n')
      .map((line, i) => ({ line: line.trim(), no: i + 1 }))
      .filter(({ line }) => line.includes('getSkillContext('))
      // 排除函数定义与注释行
      .filter(({ line }) => !line.startsWith('//') && !line.startsWith('*') && !line.startsWith('public'))
      .filter(({ line }) => !/await\s+[\w.]*getSkillContext\(/.test(line))
      .filter(({ line }) => !/=\s*this\.skillLoader\.getSkillContext/.test(line))

    expect(
      badLines,
      `发现未 await 的 getSkillContext 调用: ${badLines.map(b => `L${b.no}: ${b.line}`).join(' | ')}`,
    ).toHaveLength(0)
  })
})