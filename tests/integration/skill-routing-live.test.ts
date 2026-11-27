/**
 * New World — AI 技能路由实跑基准（M4-W）
 * ═══════════════════════════════════════════════════════════════════════
 * 【这一批在测什么】
 * 「**技能要由 AI 自行判断用哪个**」—— 这件事在本项目里**实现过，但从没验过**。
 *
 * 机制早就有了（M4-A 渐进披露）：
 *   L1 技能摘要常驻注入系统提示 → 模型自己判断相关 → 调 load_skill 取正文(L2)。
 * 代码里**没有任何关键词匹配**替 AI 做决定（旧实现才有，M4-A 已删）。
 *
 * 但既有测试只验了**管道**：
 *   - 摘要里有没有 name/description（unit）
 *   - 模型调 load_skill 后能不能拿到正文（unit）
 *   - 模型调了之后 appliedSkills 有没有记上（integration，用 mock LLM）
 * **没有一条验「模型面对真实任务时，会不会挑对那个技能」。**
 *
 * 【为什么必须真跑】
 * 路由是**模型行为**，不是代码行为。mock 掉模型，测的就是 mock 自己。
 * 故这里接**真模型**（本机 ollama），把「选对率/漏选率/误选率」量出来。
 *
 * 【基准怎么设计才算公平】
 * ① 技能 **id ≠ name**（复现真实缺陷：很多技能的目录名与展示名不同）
 * ② 每个任务**只匹配一个**技能 —— "正确"才有唯一定义
 * ③ 带**负样本**（不匹配任何技能）—— 正确行为是**不加载任何技能**
 * ④ 任务措辞里**不提技能名** —— 否则测的是"认字",不是"判断"
 *
 * 【怎么跑】
 *   NW_SKILL_ROUTING=1 npx vitest run tests/integration/skill-routing-live.test.ts
 *   # 换模型:
 *   NW_SKILL_ROUTING=1 NW_SKILL_ROUTING_MODEL=qwen3.8-27b-q4km:latest \
 *     npx vitest run tests/integration/skill-routing-live.test.ts
 *
 * 【默认不跑】
 * 每次跑都要打真模型（慢且烧算力）。必须显式开启。
 */
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/** 【重要】用仓库自带的 TestHost 路径 —— 测试 setup 已把 getHost() 指向它,
 *  自造 userData 不会被 SkillManager.getSkillsDir() 看到(实测技能数=0)。 */
import { TEST_USER_DATA } from '../unit/test-host'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((k: string) => `${TEST_USER_DATA}/${k}`),
    getName: () => 'newworld',
    getVersion: () => '4.5.0',
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn((s: string) => Buffer.from(s, 'utf-8')),
    decryptString: vi.fn((b: Buffer) => b.toString('utf-8')),
  },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}))

vi.mock('electron-log', () => ({
  default: {
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
    transports: { file: { resolvePathFn: () => {}, maxSize: 0, format: '' }, console: { level: 'info' } },
  },
}))

import { LlmAgentBrain } from '../../electron/agent/LlmAgentBrain'
import { SkillLoader } from '../../electron/skill/SkillLoader'
import { LlmConfigStore } from '../../electron/llm/LlmConfigStore'

const ENABLED = process.env.NW_SKILL_ROUTING === '1'
const MODEL = process.env.NW_SKILL_ROUTING_MODEL || 'qwen3.5:9b'
/**
 * 变体:`fixed` = 现状;`legacy` = **复现修前行为**(在测试内打补丁,不改产品代码)。
 *
 * 【为什么要留 legacy 变体】
 * 修前/修后要能**在同一套条件下**对比,才说明得了是修带来的。
 * 做法:在测试内把「摘要格式 / 系统提示 / 加载兜底」三处打回旧行为,
 * 而不是去改产品代码再改回来 —— 后者容易把改动弄丢,也没法并行对比。
 */
const VARIANT = (process.env.NW_SKILL_ROUTING_VARIANT || 'fixed') as 'fixed' | 'legacy'
const OLLAMA_BASE = 'http://localhost:11434/v1'
const OLLAMA_HOST = 'http://localhost:11434'
const SKILLS_DIR = join(TEST_USER_DATA, 'skills')

/** 【M4-W 修前】的系统提示 —— 技能规则排在最后一条,与「优先用工具拿真实数据」打架 */
const LEGACY_SYSTEM_PROMPT = `你是 New World 代码助手, 跟 ClaudeCode 一样能用 6 个工具:
- Read: 读文件 (file_path, encoding?)
- Edit: 精确编辑文件 (file_path, old_string, new_string, replace_all?)
- Bash: 跑命令 (command, args?, cwd?, timeout_ms?)
- Glob: 文件匹配 (pattern, cwd?)
- Grep: 内容搜索 (pattern, cwd?, include?)
- load_skill: 加载某个技能的完整操作说明 (skill_id)

工作准则:
1. 优先用工具拿真实数据, 不要靠记忆编
2. Edit 工具要求 old_string 唯一, 不唯一就报错让你加上下文
3. Bash 走白名单, 不在白名单的命令会拒绝
4. 任务完成直接给最终答复, 不要无谓地继续调工具
5. 答复简洁, 中文, 1-3 句能说清就不啰嗦
6. 路径默认是 sandbox 内 (用户数据隔离), 不要试图读 ~/.ssh 或 C:\\Windows
7. 若系统提示里有"可用技能"清单, 且某技能与用户需求相关, 先调 load_skill 拿到它的步骤再动手, 不要凭猜测执行`

/**
 * 把 SkillLoader 打回【修前】行为 —— 三处:
 *   ① 摘要只给 name(不给 skill_id)
 *   ② getSkillBody 不按 name 兜底(只认 id)
 *   ③ 错误信息只列 id
 */
function applyLegacyVariant(): void {
  const proto = SkillLoader.prototype as any
  proto.getSkillSummaries = function (this: any): string {
    const enabled = Array.from(this.skills.values()).filter((s: any) => s.enabled)
    if (enabled.length === 0) return ''
    const lines: string[] = []
    for (const s of enabled) {
      const parts = [`- ${s.name}: ${s.description}`]
      if (s.whenToUse) parts.push(`  (适用:${s.whenToUse})`)
      lines.push(parts.join(''))
    }
    return lines.join('\n')
  }
  proto.getSkillBody = function (this: any, skillId: string): string {
    const s = this.skills.get(skillId)
    if (!s) {
      const available = Array.from(this.skills.keys()).join(', ')
      return `技能 "${skillId}" 不存在。可用技能:${available || '(无)'}`
    }
    return s.fullInstructions
  }
}

/**
 * 基准技能 —— **刻意让 id ≠ name**。
 *
 * 【为什么】
 * 真实技能目录名与展示名常常不同（如 `sample-web-summary` / `Web Page Summarizer`）。
 * 若基准里 id === name，就测不出「模型选对了却加载不了」这一类问题。
 */
interface BenchSkill {
  id: string
  name: string
  description: string
  whenToUse: string
}

const BENCH_SKILLS: BenchSkill[] = [
  {
    id: 'pdf-extract',
    name: 'PDF 表格提取器',
    description: '从 PDF 文件中提取文本与表格,转成 CSV 或 Markdown',
    whenToUse: '用户提到 PDF、提取 PDF 里的表、把 PDF 转成表格',
  },
  {
    id: 'excel-report',
    name: 'Excel 月度报表生成器',
    description: '读取 Excel 表格,统计并生成汇总报表',
    whenToUse: '用户提到 Excel、表格统计、生成报表、合并表格',
  },
  {
    id: 'git-commit-msg',
    name: '规范提交信息撰写器',
    description: '按项目约定生成 git 提交信息',
    whenToUse: '用户提到 commit、提交信息、commit message',
  },
  {
    id: 'image-resize',
    name: '图片批量压缩工具',
    description: '批量压缩图片并统一调整尺寸与格式',
    whenToUse: '用户提到 图片、压缩、缩放、格式转换',
  },
]

/** 任务 —— 措辞里**不提技能名**，否则测的是"认字"不是"判断" */
const BENCH_TASKS: Array<{ task: string; target: string | null }> = [
  { task: '把这个PDF里的表格提取成CSV', target: 'pdf-extract' },
  { task: '帮我把这份扫描版PDF的文字识别出来', target: 'pdf-extract' },
  { task: '把这几个Excel表合并成一份月度汇总', target: 'excel-report' },
  { task: '统计一下这个Excel里的销售额并做成报表', target: 'excel-report' },
  { task: '帮我为这些改动写一条规范的提交信息', target: 'git-commit-msg' },
  { task: '生成一条git commit message', target: 'git-commit-msg' },
  { task: '把这批图片批量压缩一下', target: 'image-resize' },
  { task: '把这些照片统一缩放到800宽', target: 'image-resize' },
  // 负样本 —— 正确行为是**不加载任何技能**
  { task: '帮我把这段英文翻译成中文', target: null },
  { task: '现在几点了', target: null },
]

function writeSkills(): void {
  if (existsSync(SKILLS_DIR)) rmSync(SKILLS_DIR, { recursive: true, force: true })
  mkdirSync(SKILLS_DIR, { recursive: true })
  for (const s of BENCH_SKILLS) {
    const dir = join(SKILLS_DIR, s.id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), [
      '---',
      `name: ${s.name}`,
      `description: ${s.description}`,
      '---',
      '',
      '## 触发条件',
      s.whenToUse,
      '',
      '## 操作步骤',
      `1. 按「${s.name}」的流程处理`,
      '2. 交付结果',
      '',
    ].join('\n'), 'utf-8')
  }
}

interface RoutingResult {
  task: string
  target: string | null
  loaded: string[]
  /** 模型**尝试**调 load_skill 时用的 skill_id（可能调了但失败了） */
  attempted: string[]
  /** load_skill 调用失败时的原因（用来区分"没调"与"调了但加载不了"） */
  errors: string[]
  correct: boolean
  missed: boolean
  wrong: boolean
}

describe('M4-W AI 技能路由实跑基准', () => {
  beforeAll(async () => {
    if (!ENABLED) return
    const r = await fetch(`${OLLAMA_HOST}/api/version`)
    expect(r.ok).toBe(true)
    const tagsRes = await fetch(`${OLLAMA_HOST}/api/tags`)
    const tagsBody = (await tagsRes.json().catch(() => null)) as { models?: { name: string }[] } | null
    const tags = (tagsBody?.models ?? []).map(m => m.name)
    if (tags.length && !tags.includes(MODEL)) {
      throw new Error(`本机 ollama 没有模型 tag "${MODEL}"。可用: ${tags.join(', ')}`)
    }
    LlmConfigStore.getInstance().set('openai-compatible', {
      apiKey: 'ollama',
      apiBaseUrl: OLLAMA_BASE,
      defaultModel: MODEL,
      enabled: true,
    })
    writeSkills()
    ;(SkillLoader as any).instance = null
    SkillLoader.getInstance().loadAllSkills()
    if (VARIANT === 'legacy') applyLegacyVariant()
    // 【诊断】技能到底有没有进到系统提示里 —— 没有的话,模型当然不会去调 load_skill
    const loader = SkillLoader.getInstance() as any
    console.log(`[routing] 技能目录=${loader.skillsDir}`)
    console.log(`[routing] 已加载技能数=${loader.skills?.size ?? 0} → ${JSON.stringify([...(loader.skills?.values() ?? [])].map((s: any) => `${s.id}/${s.name}`))}`)
    console.log(`[routing] L1 摘要:\n${loader.getSkillSummaries()}`)
  })

  it('量出选对率 / 漏选率 / 误选率 / 负样本误触发率', async (ctx) => {
    if (!ENABLED) {
      return ctx.skip('[SKIP] 路由基准需显式开启:NW_SKILL_ROUTING=1（否则每次 npm test 都打真模型）')
    }

    const results: RoutingResult[] = []
    for (const t of BENCH_TASKS) {
      let loaded: string[] = []
      const attempted: string[] = []
      const errors: string[] = []
      try {
        const r = await LlmAgentBrain.getInstance().run(t.task, {
          maxIterations: 3,
          // legacy 变体:把系统提示也打回修前那条(技能规则排在最后)
          ...(VARIANT === 'legacy' ? { systemPrompt: LEGACY_SYSTEM_PROMPT } : {}),
        })
        loaded = r.appliedSkills ?? []
        // 【关键】appliedSkills 只记**成功**加载的 —— 分不清"没调"与"调了但失败"。
        // 故把 load_skill 的调用与错误也捞出来:这才是"AI 判断得对不对"的证据。
        for (const c of r.toolCalls ?? []) {
          if (c.name !== 'load_skill') continue
          attempted.push(c.entity?.id ?? '(未记录 id)')
          if (!c.ok) errors.push(c.error ?? '(无错误信息)')
        }
      } catch (e) {
        console.log(`[routing] 任务失败: ${t.task} —— ${String(e).slice(0, 120)}`)
      }
      const correct = t.target !== null ? loaded.includes(t.target) : loaded.length === 0
      const missed = t.target !== null && loaded.length === 0
      const wrong = loaded.some(id => id !== t.target)
      results.push({ task: t.task, target: t.target, loaded, attempted, errors, correct, missed, wrong })
      const verdict = correct
        ? '✅'
        : t.target === null
          ? '❌ 负样本误触发'
          : missed
            ? (attempted.length ? '⚠ 调了但没加载上' : '⚠ 漏选(没调用)')
            : '❌ 误选'
      console.log(`[routing] 期望=${String(t.target).padEnd(16)} 加载=${JSON.stringify(loaded).padEnd(18)} 尝试=${JSON.stringify(attempted).padEnd(20)} ${verdict}`)
      for (const err of errors) console.log(`           ↳ load_skill 失败: ${String(err).slice(0, 100)}`)
    }

    const positives = results.filter(r => r.target !== null)
    const negatives = results.filter(r => r.target === null)
    const correct = positives.filter(r => r.correct).length
    const missed = positives.filter(r => r.missed).length
    const wrong = positives.filter(r => r.wrong && !r.correct).length
    // 【多选】除了目标技能还加载了别的 —— 同样是缺陷:
    // 多余的技能正文会被塞进上下文,可能带偏执行(而且多花模型往返)。
    const over = positives.filter(r => r.loaded.some(id => id !== r.target)).length
    const negTriggered = negatives.filter(r => r.loaded.length > 0).length
    // 【重试税】load_skill 调用**失败**的次数 —— 每次失败都要模型再读一遍错误信息、
    // 再花一轮往返重试。这是"id 给了名字"造成的白花成本。
    const failedCalls = results.reduce((a, r) => a + r.errors.length, 0)
    const totalCalls = results.reduce((a, r) => a + r.attempted.length, 0)

    console.log(`\n===== [M4-W 路由基准] ${MODEL} · 变体=${VARIANT} =====`)
    console.log(`选对率       ${correct}/${positives.length} = ${(correct / positives.length * 100).toFixed(1)}%`)
    console.log(`漏选率       ${missed}/${positives.length} = ${(missed / positives.length * 100).toFixed(1)}%`)
    console.log(`误选率       ${wrong}/${positives.length} = ${(wrong / positives.length * 100).toFixed(1)}%`)
    console.log(`多选率       ${over}/${positives.length} = ${(over / positives.length * 100).toFixed(1)}%`)
    console.log(`负样本误触发 ${negTriggered}/${negatives.length} = ${(negTriggered / negatives.length * 100).toFixed(1)}%`)
    console.log(`load_skill 调用 ${totalCalls} 次，其中**失败** ${failedCalls} 次（每次失败=一轮白花的模型往返）`)
    console.log(JSON.stringify(results, null, 2))

    // 断言只钉「基准跑通了」，不钉「模型选得多准」——
    // 选对率是**结论**，不是测试断言；断言它会把"模型变好"变成"测试变红"。
    expect(results.length).toBe(BENCH_TASKS.length)
    expect(positives.length).toBeGreaterThan(0)
    expect(negatives.length).toBeGreaterThan(0)
  }, 1_800_000)
})
