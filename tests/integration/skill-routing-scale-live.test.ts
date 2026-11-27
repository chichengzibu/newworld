/**
 * New World — 技能规模档实跑基准（M4-AB）
 * ═══════════════════════════════════════════════════════════════════════
 * 【这一批在测什么】
 * M4-W 量出「AI 选对率 100%」—— 但那是在 **4 个技能**上量的。
 * 而 M4-X 的开源技能库一次能装 30+ 个。**列表一变长，选得准不准没人知道。**
 *
 * 本基准把技能数推到 **24 个**（10 个目标 + 14 个填充），追问同一组问题：
 * 选对率会不会退化？会不会开始多选？负样本还稳不稳？
 *
 * 【为什么填充集是**固定**的（而不是每次从网上拉）】
 * 第一版从开源索引实时拉填充 —— 实测每轮可用条目在 11~18 个之间波动，
 * **基准本身就不稳定**，跑出来的数没法对比。故把 14 个填充**写死**：
 * 主题各异、描述按真实技能写法、且**不含目标关键词**（避免"选错"分不清
 * 是规模问题还是主题歧义）。代价是少一点"真实数据"味道，换来**同一道题**。
 *
 * 【与 M4-W 基准的关系】
 * 同一套指标、同一条生产路径（LlmAgentBrain.run）、同样的四条约束
 * （id≠name / 每任务只匹配一个 / 带负样本 / 措辞不提技能名）。
 * 唯一的变量是**技能数量**（4 → 24）。
 *
 * 【怎么跑】
 *   NW_SKILL_SCALE=1 npx vitest run tests/integration/skill-routing-scale-live.test.ts
 *   # 换模型:
 *   NW_SKILL_SCALE=1 NW_SKILL_ROUTING_MODEL=qwen3.8-27b-q4km:latest \
 *     npx vitest run tests/integration/skill-routing-scale-live.test.ts
 *
 * 【默认不跑】要打真模型（慢且烧算力）。
 */
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

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

const ENABLED = process.env.NW_SKILL_SCALE === '1'
const MODEL = process.env.NW_SKILL_ROUTING_MODEL || 'qwen3.5:9b'
const OLLAMA_BASE = 'http://localhost:11434/v1'
const OLLAMA_HOST = 'http://localhost:11434'
const SKILLS_DIR = join(TEST_USER_DATA, 'skills')

/** 10 个目标技能 —— id ≠ name（与 M4-W 同一约束） */
const TARGET_SKILLS = [
  { id: 'pdf-table-extract', name: 'PDF 表格提取器', desc: '从 PDF 中提取文本与表格，导出为 CSV 或 Markdown', when: '用户提到 PDF、提取 PDF 里的表格' },
  { id: 'excel-monthly-report', name: 'Excel 月度报表生成器', desc: '读取 Excel 表格，统计并生成月度汇总报表', when: '用户提到 Excel、表格统计、生成报表、合并表格' },
  { id: 'commit-msg-writer', name: '规范提交信息撰写器', desc: '按项目约定生成 git 提交信息', when: '用户提到 commit、提交信息、commit message' },
  { id: 'image-batch-compress', name: '图片批量压缩工具', desc: '批量压缩图片并统一调整尺寸与格式', when: '用户提到 图片、压缩、缩放、格式转换' },
  { id: 'slide-deck-builder', name: '幻灯片生成器', desc: '把文档或要点整理成一套演示幻灯片', when: '用户提到 幻灯片、PPT、演示文稿' },
  { id: 'log-anomaly-scanner', name: '日志异常扫描器', desc: '扫描日志文件，找出异常与错误模式并汇总', when: '用户提到 日志、报错、异常排查' },
  { id: 'sql-query-optimizer', name: 'SQL 查询优化器', desc: '分析并重写慢 SQL 查询，给出索引建议', when: '用户提到 SQL、慢查询、索引' },
  { id: 'docker-debug-helper', name: 'Docker 排障助手', desc: '排查容器启动失败、网络不通与镜像问题', when: '用户提到 Docker、容器、镜像' },
  { id: 'json-schema-validator', name: 'JSON 结构校验器', desc: '为 JSON 数据生成并校验 schema 规则', when: '用户提到 JSON、schema、数据结构校验' },
  { id: 'regex-builder', name: '正则表达式构造器', desc: '根据需求构造并解释正则表达式', when: '用户提到 正则、regex、匹配规则' },
]

/** 14 个填充技能 —— 主题与目标技能**不重叠** */
const FILLER_SKILLS = [
  { id: 'filler-code-review', name: '代码审查助手', desc: '审查代码变更，指出风格问题与潜在缺陷', when: '用户要求审查代码、review 变更' },
  { id: 'filler-api-doc', name: 'API 文档生成器', desc: '从源码注释生成接口文档', when: '用户要生成或更新接口文档' },
  { id: 'filler-db-migration', name: '数据库迁移脚本生成器', desc: '生成安全的表结构变更脚本并检查回滚路径', when: '用户要改表结构、做数据库迁移' },
  { id: 'filler-markdown-toc', name: 'Markdown 目录生成器', desc: '为长文档生成并维护目录', when: '用户要给长文档加目录' },
  { id: 'filler-chart-maker', name: '图表生成器', desc: '把数据整理成柱状图、折线图等可视化图形', when: '用户要把数据画成图表' },
  { id: 'filler-web-scraper', name: '网页抓取助手', desc: '抓取网页中的结构化内容并整理', when: '用户要抓取网页内容' },
  { id: 'filler-email-drafter', name: '邮件起草助手', desc: '根据要点起草商务邮件', when: '用户要写邮件、回复邮件' },
  { id: 'filler-meeting-notes', name: '会议纪要整理器', desc: '把会议记录整理成结构化纪要', when: '用户要整理会议记录' },
  { id: 'filler-refactor-planner', name: '重构规划器', desc: '为大型改动制定分步重构计划', when: '用户要重构一段较大的代码' },
  { id: 'filler-security-audit', name: '安全审计助手', desc: '检查依赖与配置中的常见安全问题', when: '用户要做安全检查、依赖审计' },
  { id: 'filler-test-case-designer', name: '测试用例设计器', desc: '为功能设计边界与异常场景的用例', when: '用户要设计测试用例' },
  { id: 'filler-release-checklist', name: '发布检查清单', desc: '上线前逐项核对清单项', when: '用户要准备发布、做上线检查' },
  { id: 'filler-doc-summarizer', name: '文档摘要器', desc: '把长文档压缩成要点摘要', when: '用户要总结长文档' },
  { id: 'filler-cron-scheduler', name: '定时任务配置助手', desc: '帮用户配置周期任务与调度表达式', when: '用户要设定时任务、周期任务' },
]

/** 任务：每个只匹配一个目标技能；措辞不提技能名 */
const TASKS: Array<{ task: string; target: string | null }> = [
  { task: '把这个PDF里的表格提取成CSV', target: 'pdf-table-extract' },
  { task: '扫一份扫描版PDF，把里面的文字识别出来', target: 'pdf-table-extract' },
  { task: '把这几个Excel表合并成一份月度汇总', target: 'excel-monthly-report' },
  { task: '统计一下这个Excel里的销售额并做成报表', target: 'excel-monthly-report' },
  { task: '帮我为这些改动写一条规范的提交信息', target: 'commit-msg-writer' },
  { task: '生成一条git commit message', target: 'commit-msg-writer' },
  { task: '把这批图片批量压缩一下', target: 'image-batch-compress' },
  { task: '把这份文档做成一套演示幻灯片', target: 'slide-deck-builder' },
  { task: '看看这份日志里有没有异常', target: 'log-anomaly-scanner' },
  { task: '这条SQL跑得太慢了，帮我优化一下', target: 'sql-query-optimizer' },
  { task: '容器起不来，帮我排查下原因', target: 'docker-debug-helper' },
  { task: '帮我写个校验 JSON 结构的规则', target: 'json-schema-validator' },
  { task: '写个正则把邮箱地址找出来', target: 'regex-builder' },
  // 负样本 —— 正确行为是**不加载任何技能**
  { task: '帮我把这段英文翻译成中文', target: null },
  { task: '现在几点了', target: null },
  { task: '解释一下什么是二分查找', target: null },
]

function writeSkillFile(id: string, name: string, description: string, whenToUse: string): void {
  const dir = join(SKILLS_DIR, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'SKILL.md'),
    [
      '---',
      `name: ${name}`,
      `description: ${description}`,
      '---',
      '',
      '## 触发条件',
      whenToUse,
      '',
      '## 操作步骤',
      '1. 按本技能约定的流程处理',
      '2. 交付结果',
      '',
    ].join('\n'),
    'utf-8',
  )
}

interface ScaleResult {
  task: string
  target: string | null
  loaded: string[]
  attempted: string[]
  failedCalls: number
}

describe('M4-AB 技能规模档实跑基准', () => {
  let skillCount = 0

  beforeAll(async () => {
    if (!ENABLED) return

    const ver = await fetch(`${OLLAMA_HOST}/api/version`)
    expect(ver.ok).toBe(true)
    const tagsBody = (await (await fetch(`${OLLAMA_HOST}/api/tags`)).json().catch(() => null)) as { models?: { name: string }[] } | null
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

    for (const s of [...TARGET_SKILLS, ...FILLER_SKILLS]) {
      writeSkillFile(s.id, s.name, s.desc, s.when)
    }

    ;(SkillLoader as any).instance = null
    const loader = SkillLoader.getInstance()
    loader.reloadSkills()
    skillCount = loader.getAllSkills().filter(s => s.enabled).length

    const summaries = loader.getSkillSummaries()
    console.log(`\n[scale] 技能数=${skillCount}（目标 ${TARGET_SKILLS.length} + 填充 ${FILLER_SKILLS.length}）`)
    console.log(`[scale] 技能清单注入长度=${summaries.length} 字（约 ${Math.round(summaries.length / 2)} tokens）`)
  }, 600_000)

  it('量出 24 技能规模下的选对率 / 漏选 / 误选 / 多选 / 负样本', async (ctx) => {
    if (!ENABLED) {
      return ctx.skip('[SKIP] 规模档基准需显式开启: NW_SKILL_SCALE=1（要打真模型）')
    }

    const results: ScaleResult[] = []
    for (const t of TASKS) {
      let loaded: string[] = []
      const attempted: string[] = []
      let failedCalls = 0
      try {
        const r = await LlmAgentBrain.getInstance().run(t.task, { maxIterations: 3 })
        loaded = r.appliedSkills ?? []
        for (const c of r.toolCalls ?? []) {
          if (c.name !== 'load_skill') continue
          attempted.push(c.entity?.id ?? '?')
          if (!c.ok) failedCalls++
        }
      } catch (e) {
        console.log(`[scale] 任务失败: ${t.task} —— ${String(e).slice(0, 100)}`)
      }
      results.push({ task: t.task, target: t.target, loaded, attempted, failedCalls })

      const correct = t.target !== null ? loaded.includes(t.target) : loaded.length === 0
      const missed = t.target !== null && loaded.length === 0
      const verdict = correct
        ? '✅'
        : t.target === null
          ? '❌ 负样本误触发'
          : missed
            ? '⚠ 漏选'
            : '❌ 误选/多选'
      console.log(`[scale] 期望=${String(t.target).padEnd(22)} 加载=${JSON.stringify(loaded).padEnd(30)} ${verdict}`)
    }

    const positives = results.filter(r => r.target !== null)
    const negatives = results.filter(r => r.target === null)
    const correct = positives.filter(r => r.target !== null && r.loaded.includes(r.target)).length
    const missed = positives.filter(r => r.loaded.length === 0).length
    const over = positives.filter(r => r.loaded.some(id => id !== r.target)).length
    const negTriggered = negatives.filter(r => r.loaded.length > 0).length
    const failedCalls = results.reduce((a, r) => a + r.failedCalls, 0)
    const pct = (n: number, d: number) => (d > 0 ? `${((n / d) * 100).toFixed(1)}%` : 'n/a')

    console.log(`\n===== [M4-AB 规模档] ${MODEL} · ${skillCount} 个技能 =====`)
    console.log(`选对率       ${correct}/${positives.length} = ${pct(correct, positives.length)}`)
    console.log(`漏选率       ${missed}/${positives.length} = ${pct(missed, positives.length)}`)
    console.log(`多选率       ${over}/${positives.length} = ${pct(over, positives.length)}`)
    console.log(`负样本误触发 ${negTriggered}/${negatives.length} = ${pct(negTriggered, negatives.length)}`)
    console.log(`load_skill 失败 ${failedCalls} 次`)

    // 断言只钉"基准跑通了" —— 选对率是**结论**,不是通过条件
    expect(skillCount).toBe(TARGET_SKILLS.length + FILLER_SKILLS.length)
    expect(results.length).toBe(TASKS.length)
  }, 1_800_000)
})
