/**
 * PiPiClaw — 顺序一致性 / 长度基线 离线复算（M4-V）
 * ═══════════════════════════════════════════════════════════════════════
 * 【这一批在测什么】
 * 把 M4-J 那次校准**已经落盘**的裁决重新算一遍,补上 M4-V 新增的两项分析:
 *   ① 顺序一致性分析 ——「两次顺序一致才采信」这条规则到底买到了什么
 *   ② 长度平凡基线 —— 裁判是否强于「不看内容、只看长度」的预测器
 *
 * 【为什么不需要模型】
 * 裁决已经落盘成 verdicts-<model>.jsonl(每次跑两遍换序)。
 * 复算只是纯计算 —— **不调模型、不联网**,秒级出结果。
 * 这让"裁判到底行不行"变成一个**随时能重算**的数字,而不是一次性的印象。
 *
 * 【为什么默认不跑】
 * 依赖 `.tmp-calibration/` 下的标注集与裁决文件(不入仓,需先跑
 * `python scripts/calibration/prepare_datasets.py` 与实跑校准)。
 * 文件不在就跳过 —— 不能让"npm test 是否通过"依赖本机有没有跑过校准。
 *
 * 【怎么跑】
 *   npx vitest run tests/integration/judge-consensus-offline.test.ts
 *   # 想换别的模型目录:
 *   PIPICLAW_CALIBRATION_VERDICTS=verdicts-qwen3.8-27b-q4km_latest.jsonl \
 *     npx vitest run tests/integration/judge-consensus-offline.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { readFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
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
} from '../helpers/calibration-dataset'

/** 标注集 —— 与实跑校准时用的两套一致 */
const DATASETS = ['panel', 'mt_bench']

/** 复算哪一份裁决(默认全部) */
const VERDICTS_ENV = process.env.PIPICLAW_CALIBRATION_VERDICTS

function loadItems(): CalibrationItem[] {
  const all: CalibrationItem[] = []
  for (const name of DATASETS) {
    const items = loadCalibrationFile(join(DATASET_DIR, `${name}.jsonl`))
    if (items.length > 0) all.push(...items)
  }
  return all
}

function loadVerdictFile(file: string): JudgeVerdictRecord[] {
  const out: JudgeVerdictRecord[] = []
  for (const line of readFileSync(join(OUTPUT_DIR, file), 'utf-8').split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      out.push(JSON.parse(t) as JudgeVerdictRecord)
    } catch {
      // 坏行跳过(续跑文件里可能有半行)
    }
  }
  return out
}

function verdictFiles(): string[] {
  if (!existsSync(OUTPUT_DIR)) return []
  const all = readdirSync(OUTPUT_DIR).filter(f => f.startsWith('verdicts-') && f.endsWith('.jsonl'))
  if (VERDICTS_ENV) return all.filter(f => f === VERDICTS_ENV)
  return all
}

describe('M4-V 顺序一致性 / 长度基线 离线复算', () => {
  it('复算已落盘的裁决并产出结论', async (ctx) => {
    const items = loadItems()
    const files = verdictFiles()
    if (items.length === 0 || files.length === 0) {
      return ctx.skip(
        '[SKIP] 需要 .tmp-calibration/ 下的标注集与裁决文件 —— '
        + '先跑 python scripts/calibration/prepare_datasets.py,'
        + '再跑 PIPICLAW_CALIBRATION=1 npx vitest run tests/integration/judge-calibration-live.test.ts',
      )
    }

    mkdirSync(OUTPUT_DIR, { recursive: true })
    for (const file of files) {
      const records = loadVerdictFile(file)
      if (records.length === 0) continue
      const model = records[0].model ?? file
      const report = calibrate(items, records)
      const md = renderCalibrationReport(report, {
        model,
        dataset: DATASETS.join(','),
        generatedAt: new Date().toISOString(),
      })
      const outFile = join(OUTPUT_DIR, `consensus-${file.replace('verdicts-', '').replace(/\.jsonl$/, '')}.md`)
      writeFileSync(outFile, md, 'utf-8')

      const c = report.consensus
      const lb = report.lengthBaseline
      console.log(`\n===== [M4-V 复算] ${model} =====`)
      console.log(`计入样本 ${report.scored} · κ=${report.kappa.toFixed(3)} · 换序改口率 ${(report.position.flipRate * 100).toFixed(1)}%`)
      console.log(`顺序一致子集   n=${c.orderStable.n} 覆盖率=${(c.orderStable.coverage * 100).toFixed(1)}% 一致率=${(c.orderStable.accuracy * 100).toFixed(1)}% κ=${c.orderStable.kappa.toFixed(3)}`)
      console.log(`顺序不一致子集 n=${c.orderUnstable.n} 覆盖率=${(c.orderUnstable.coverage * 100).toFixed(1)}% 一致率=${(c.orderUnstable.accuracy * 100).toFixed(1)}% κ=${c.orderUnstable.kappa.toFixed(3)}`)
      console.log(`整体(单次顺序) n=${c.overall.n} 一致率=${(c.overall.accuracy * 100).toFixed(1)}% κ=${c.overall.kappa.toFixed(3)}`)
      console.log(`「顺序一致才采信」是否成立: ${c.stableRuleHolds ? '成立' : '不成立'} —— ${c.note}`)
      for (const g of c.positionGroups) {
        console.log(`  位置偏置组 ${g.group}: n=${g.n} 组内一致率=${(g.accuracy * 100).toFixed(1)}% 多数类=${(g.majorityRate * 100).toFixed(1)}% κ=${g.kappaDefined ? g.kappa.toFixed(3) : '不可定义'} 恒定预测=${g.constantPredictor ? '是' : '否'}`)
      }
      console.log(`长度平凡基线: 基线一致率=${(lb.baselineAccuracy * 100).toFixed(1)}% 基线κ=${lb.baselineKappa.toFixed(3)} 裁判κ=${c.overall.kappa.toFixed(3)} 重合=${(lb.judgeAgreement * 100).toFixed(1)}% 人工偏长=${(lb.humanPrefersLonger * 100).toFixed(1)}% p=${lb.pValue.toFixed(4)} 裁判强于基线=${lb.judgeBeatsBaseline ? '是' : '否'}`)
      console.log(`报告: ${outFile}`)

      // 断言只钉"分析确实跑起来了",不钉"裁判好不好" —— 那是结论,不是测试断言
      expect(report.scored).toBeGreaterThan(0)
      expect(c.overall.n).toBe(report.scored)
      expect(c.orderStable.n + c.orderUnstable.n).toBe(report.scored)
      expect(md).toContain('## 顺序一致性分析')
      expect(md).toContain('## 长度平凡基线')
    }
  }, 120_000)
})
