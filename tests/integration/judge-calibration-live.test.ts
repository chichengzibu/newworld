/**
 * PiPiClaw — 裁判校准实跑（M4-J）
 * ═══════════════════════════════════════════════════════════════════════
 * 【这一批在测什么】
 * 不是"测试通过/失败",而是**跑一次校准并把结论落盘**。
 * 裁判层在 M4-F 交付时留了一句遗留:「裁判未做校准 —— 业界要求先在人工
 * 标注样本上校准 judge 与人的一致度,再放量」。本文件就是那句遗留的兑现。
 *
 * 【为什么默认不跑】
 * 一次校准要打模型(每条样本跑两遍:换序)。普通测试电池里跑这个 =
 * 每次 npm test 都烧几分钟算力,还会让「测试是否通过」依赖本机有没有
 * ollama。因此:
 *   - 默认 SKIP(必须显式 PIPICLAW_CALIBRATION=1 才跑)
 *   - 跑出来的结论落在 .tmp-calibration/out/ 下,不入仓
 *
 * 【怎么跑】
 *   # 1) 准备标注集(一次即可)
 *   python scripts/calibration/prepare_datasets.py
 *
 *   # 2) 校准默认裁判模型
 *   PIPICLAW_CALIBRATION=1 npx vitest run tests/integration/judge-calibration-live.test.ts
 *
 *   # 3) 换一个裁判模型再跑一遍(量 judge drift)
 *   PIPICLAW_CALIBRATION=1 PIPICLAW_CALIBRATION_MODEL=qwen3.8:27b-q4km \
 *     npx vitest run tests/integration/judge-calibration-live.test.ts
 *
 * 【断点续跑】裁决落 verdicts-<model>.jsonl,已判过的样本跳过。
 *
 * 【口径诚实】样本量、排除项、门槛全部写进报告;抽样绝不静默截断。
 */
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((k: string) => `/tmp/pipiclaw-calibration-${k}`),
    getName: () => 'pipiclaw',
    getVersion: () => '4.5.0',
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn((s: string) => Buffer.from(s, 'utf-8')),
    decryptString: vi.fn((b: Buffer) => b.toString('utf-8')),
  },
}))

vi.mock('electron-log', () => ({
  default: {
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
    transports: { file: { resolvePathFn: () => {}, maxSize: 0, format: '' }, console: { level: 'info' } },
  },
}))

import { LlmConfigStore } from '../../electron/llm/LlmConfigStore'
import {
  createPairwiseJudge,
  parsePairwiseJudgeOutput,
  type DisplayedPick,
} from '../../electron/learning/RunJudge'
import {
  calibrate,
  renderCalibrationReport,
  type CalibrationItem,
  type JudgeVerdictRecord,
} from '../../electron/learning/JudgeCalibration'
import {
  DATASET_DIR,
  OUTPUT_DIR,
  loadCalibrationFile,
  findDuplicateIds,
  sampleStratified,
} from '../helpers/calibration-dataset'

const ENABLED = process.env.PIPICLAW_CALIBRATION === '1'
const MODEL = process.env.PIPICLAW_CALIBRATION_MODEL || 'qwen3.5:9b'
/** 每个类别抽多少条 —— 想要统计显著性就调大(每条样本要打两遍模型) */
const PER_CATEGORY = Number(process.env.PIPICLAW_CALIBRATION_PER_CATEGORY || 20)
/** 用哪套标注集 */
const DATASETS = (process.env.PIPICLAW_CALIBRATION_DATASET || 'panel').split(',').map(s => s.trim())
const OLLAMA_BASE = 'http://localhost:11434/v1'
const OLLAMA_HOST = 'http://localhost:11434'
/** 并发度 —— ollama 自己会排队,太高只是把请求堆在服务端 */
const CONCURRENCY = Number(process.env.PIPICLAW_CALIBRATION_CONCURRENCY || 4)

const VERDICT_FILE = join(OUTPUT_DIR, `verdicts-${MODEL.replace(/[:/]/g, '_')}.jsonl`)

/** 把内容包装成一次可判定的执行(标定集只有指令 + 答复,没有工具轨迹) */
function toRun(item: CalibrationItem, side: 'A' | 'B') {
  return {
    instruction: item.question,
    answer: side === 'A' ? item.answerA : item.answerB,
    toolsUsed: [] as string[],
    hadToolFailure: false,
    hadError: false,
    producedAnswer: true,
  }
}

/**
 * 把裁判的"内容身份"选择翻译回"展示位"选择。
 *
 * 【实现期踩到的坑】裁判解析出来的 winner 是**小写** 'a'/'b',
 * 而这里最初按大写 'A'/'B' 比对 → 全部落进 'second' → 指标显示
 * "换序改口率 100%"。**那是 harness 的映射错,不是模型的偏置。**
 * 教训:指标异常时先看原始输出,别先信指标(与 DEV-036「自证不算证」同向)。
 */
function toDisplayedPick(winner: string, order: 'AFirst' | 'BFirst'): DisplayedPick {
  const w = (winner || '').toLowerCase()
  if (w === 'tie' || w === 'unknown') return w as DisplayedPick
  if (order === 'AFirst') return w === 'a' ? 'first' : 'second'
  return w === 'b' ? 'first' : 'second'
}

function loadExistingVerdicts(): Map<string, JudgeVerdictRecord> {
  const map = new Map<string, JudgeVerdictRecord>()
  if (!existsSync(VERDICT_FILE)) return map
  for (const line of readFileSync(VERDICT_FILE, 'utf-8').split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      const rec = JSON.parse(t) as JudgeVerdictRecord
      map.set(rec.id, rec)
    } catch {
      // 坏行跳过 —— 续跑文件里可能有半行
    }
  }
  return map
}

async function runWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await fn(items[index])
    }
  })
  await Promise.all(workers)
  return results
}

describe('M4-J 裁判校准实跑', () => {
  beforeAll(async () => {
    if (!ENABLED) return
    const r = await fetch(`${OLLAMA_HOST}/api/version`)
    expect(r.ok).toBe(true)

    // 【环境预检 —— 实跑踩到】模型 tag 写错时,每一次调用都返回
    // "model 'xxx' not found" → content 为空 → 全部记 unknown →
    // 报告变成"计入 0 条"。报告本身是诚实的,但**看不出是模型名写错了**。
    // 故:跑之前先查 tag 在不在,不在就直接报错并列出可用 tag。
    const tagsRes = await fetch(`${OLLAMA_HOST}/api/tags`)
    const tagsBody = (await tagsRes.json().catch(() => null)) as { models?: { name: string }[] } | null
    const tags = (tagsBody?.models ?? []).map(m => m.name)
    if (tags.length && !tags.includes(MODEL)) {
      throw new Error(`本机 ollama 没有模型 tag "${MODEL}"。可用: ${tags.join(', ')}（tag 名要与 /api/tags 完全一致，如 "qwen3.8-27b-q4km:latest"）`)
    }

    LlmConfigStore.getInstance().set('openai-compatible', {
      apiKey: 'ollama',
      apiBaseUrl: OLLAMA_BASE,
      defaultModel: MODEL,
      enabled: true,
    })
    mkdirSync(OUTPUT_DIR, { recursive: true })
  })

  it('跑一轮校准并落盘结论', async (ctx) => {
    if (!ENABLED) {
      return ctx.skip('[SKIP] 校准需显式开启：PIPICLAW_CALIBRATION=1（否则每次 npm test 都烧算力）')
    }

    // ── 取标注集 ──
    const all: CalibrationItem[] = []
    for (const name of DATASETS) {
      const items = loadCalibrationFile(join(DATASET_DIR, `${name}.jsonl`))
      if (items.length === 0) {
        throw new Error(`标注集缺失：${name}.jsonl —— 先跑 python scripts/calibration/prepare_datasets.py`)
      }
      all.push(...items)
    }
    const sampled = sampleStratified(all, PER_CATEGORY)
    console.log(`[calib] 数据集=${DATASETS.join(',')} 全量=${all.length} 抽样=${sampled.length} (每类 ${PER_CATEGORY} 条)`)

    // id 撞号 = 那一批样本会对着错的题算一致度,且报告里看不出来 → 直接报错
    const dupes = findDuplicateIds(all)
    expect(dupes.length === 0 ? '' : `标注集 id 撞号:${dupes.slice(0, 5).join(', ')}`).toBe('')
    expect(findDuplicateIds(sampled).length).toBe(0)

    // ── 续跑 ──
    const done = loadExistingVerdicts()
    const todo = sampled.filter(i => !done.has(i.id))
    console.log(`[calib] 已判=${done.size} 待判=${todo.length} 裁决文件=${VERDICT_FILE}`)

    // ── 逐条跑两种顺序 ──
    const judge = createPairwiseJudge({ model: MODEL })
    const fresh = await runWithConcurrency(todo, CONCURRENCY, async (item) => {
      const t0 = Date.now()
      const vA = await judge(toRun(item, 'A'), toRun(item, 'B'))
      const vB = await judge(toRun(item, 'B'), toRun(item, 'A'))
      const rec: JudgeVerdictRecord = {
        id: item.id,
        pickWhenAFirst: toDisplayedPick(vA.winner, 'AFirst'),
        pickWhenBFirst: toDisplayedPick(vB.winner, 'BFirst'),
        model: MODEL,
        rawWhenAFirst: vA.raw,
        rawWhenBFirst: vB.raw,
        reasonWhenAFirst: vA.reason,
        reasonWhenBFirst: vB.reason,
        durationMs: Date.now() - t0,
      }
      appendVerdict(rec)
      return rec
    })

    const records = [...done.values(), ...fresh]

    // ── 算指标 + 出报告 ──
    const report = calibrate(sampled, records)
    const md = renderCalibrationReport(report, {
      model: MODEL,
      dataset: DATASETS.join(','),
      generatedAt: new Date().toISOString(),
    })
    const reportFile = join(OUTPUT_DIR, `report-${MODEL.replace(/[:/]/g, '_')}.md`)
    writeFileSync(reportFile, md, 'utf-8')
    writeFileSync(join(OUTPUT_DIR, `report-${MODEL.replace(/[:/]/g, '_')}.json`), JSON.stringify(report, null, 2), 'utf-8')

    console.log('\n' + md)
    console.log(`[calib] 报告已写: ${reportFile}`)

    // 【基础设施失败 vs 裁判质量差】大半裁决无法解析 = 模型/链路出了问题,
    // 不是"裁判能力差"。这两种结论的含义完全相反,不能混进同一份报告。
    if (report.n > 0 && report.unknown / report.n > 0.5) {
      throw new Error(
        `校准未完成:${report.unknown}/${report.n} 条裁决无法解析 —— 这是基础设施故障(模型没跑起来/输出被截断),不是裁判质量结论。` +
        `原因分布: ${report.unknownReasons.slice(0, 3).map(r => `${r.reason}(${r.count})`).join(' | ')}`,
      )
    }

    // 断言只钉"流程跑通了",不钉"指标达标"—— 指标达标与否是结论,不是测试断言
    expect(records.length).toBeGreaterThan(0)
    expect(report.scored + report.unknown + report.excludedTie + report.excludedAmbiguous).toBeGreaterThan(0)
    expect(md).toContain('## 结论')
  }, 3_600_000)
})

function appendVerdict(rec: JudgeVerdictRecord): void {
  mkdirSync(OUTPUT_DIR, { recursive: true })
  writeFileSync(VERDICT_FILE, JSON.stringify(rec) + '\n', { encoding: 'utf-8', flag: 'a' })
}
