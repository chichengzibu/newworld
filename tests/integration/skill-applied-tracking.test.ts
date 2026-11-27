/**
 * New World — M4-D 接线验证:「技能被应用」这件事要能被记录下来
 * ═══════════════════════════════════════════════════════════════
 * 【这一份锁的是三段链里最容易断的一段】
 *
 *   LoadSkillTool --声明--> ToolExecResult.appliedEntity
 *            ↓
 *   LlmAgentBrain --汇总--> run().appliedSkills
 *            ↓
 *   ChatManager --记账--> tracker.record({unitType:'skill', ...})
 *
 * 中间那段(brain 汇总)断了,两端各自都对,但技能效用信号永远为空 ——
 * 而"技能被应用后有没有用"正是整个学习闭环要回答的最后一个问题。
 *
 * 【本测试不联网】LlmClient.prototype.streamChat 被替换为本地 mock generator。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { TEST_USER_DATA } from '../unit/test-host'

const SKILLS_DIR = path.join(TEST_USER_DATA, 'skills')

function writeSkill(id: string, content: string): void {
  const dir = path.join(SKILLS_DIR, id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), content, 'utf-8')
}

import { LlmAgentBrain } from '../../electron/agent/LlmAgentBrain'
import { SkillLoader } from '../../electron/skill/SkillLoader'
import { LlmClient } from '../../electron/llm/LlmClient'
import type { LlmStreamChunk, LlmToolCall } from '../../electron/llm/types'

describe('M4-D — agent run 汇总「本次应用了哪些技能」', () => {
  let origStream: typeof LlmClient.prototype.streamChat

  beforeEach(() => {
    origStream = LlmClient.prototype.streamChat
    fs.mkdirSync(SKILLS_DIR, { recursive: true })
    writeSkill('pdf-extract', `---
name: pdf-extract
description: 从 PDF 抽取表格
---
## 操作步骤
1. 读 PDF
2. 抽表格
`)
    ;(SkillLoader as any).instance = null
    SkillLoader.getInstance().loadAllSkills()
  })

  afterEach(() => {
    LlmClient.prototype.streamChat = origStream
  })

  it('模型调 load_skill → appliedSkills 里有该技能 id', async () => {
    const mockStream = async function* () {
      const tc: LlmToolCall = {
        id: 'c1', type: 'function',
        function: { name: 'load_skill', arguments: JSON.stringify({ skill_id: 'pdf-extract' }) },
      }
      yield { type: 'tool_call', toolCall: tc } as LlmStreamChunk
      yield { type: 'done' } as LlmStreamChunk
    }
    LlmClient.prototype.streamChat = mockStream as never

    const r = await LlmAgentBrain.getInstance().run('抽表格', { maxIterations: 2 })

    expect(r.appliedSkills).toContain('pdf-extract')
    // 工具调用日志里带上 entity —— 可溯源到"动了什么"
    const skillCall = r.toolCalls.find(c => c.name === 'load_skill')
    expect(skillCall?.entity).toEqual({ kind: 'skill', id: 'pdf-extract' })
  })

  it('没有调技能 → appliedSkills 为空(不凭空记技能应用)', async () => {
    const mockStream = async function* () {
      const tc: LlmToolCall = {
        id: 'c2', type: 'function',
        function: { name: 'Glob', arguments: JSON.stringify({ pattern: '*' }) },
      }
      yield { type: 'tool_call', toolCall: tc } as LlmStreamChunk
      yield { type: 'done' } as LlmStreamChunk
    }
    LlmClient.prototype.streamChat = mockStream as never

    const r = await LlmAgentBrain.getInstance().run('列目录', { maxIterations: 2 })
    expect(r.appliedSkills).toEqual([])
    expect(r.toolCalls.find(c => c.name === 'Glob')?.entity).toBeUndefined()
  })

  it('加载失败 → 不记入 appliedSkills(没真应用就不算应用)', async () => {
    const mockStream = async function* () {
      const tc: LlmToolCall = {
        id: 'c3', type: 'function',
        function: { name: 'load_skill', arguments: JSON.stringify({ skill_id: '不存在的技能' }) },
      }
      yield { type: 'tool_call', toolCall: tc } as LlmStreamChunk
      yield { type: 'done' } as LlmStreamChunk
    }
    LlmClient.prototype.streamChat = mockStream as never

    const r = await LlmAgentBrain.getInstance().run('抽表格', { maxIterations: 2 })
    expect(r.appliedSkills).toEqual([])
    // 工具调用本身失败,日志里要有
    expect(r.toolCalls.find(c => c.name === 'load_skill')?.ok).toBe(false)
  })

  it('同一技能加载多次 → appliedSkills 去重', async () => {
    const mockStream = async function* () {
      const tc: LlmToolCall = {
        id: 'c4', type: 'function',
        function: { name: 'load_skill', arguments: JSON.stringify({ skill_id: 'pdf-extract' }) },
      }
      yield { type: 'tool_call', toolCall: tc } as LlmStreamChunk
      yield { type: 'tool_call', toolCall: tc } as LlmStreamChunk
      yield { type: 'done' } as LlmStreamChunk
    }
    LlmClient.prototype.streamChat = mockStream as never

    const r = await LlmAgentBrain.getInstance().run('抽表格', { maxIterations: 3 })
    expect(r.appliedSkills.filter(s => s === 'pdf-extract').length).toBe(1)
  })
})
