/**
 * New World — 裁判校准标注集加载（M4-J 测试侧）
 * ═══════════════════════════════════════════════════════════════════════
 * 【格式契约】
 * 由 `scripts/calibration/prepare_datasets.py` 生成,两套公开数据集
 * (panel / mt_bench)统一成同一份 JSONL,每行一条 pairwise 样本:
 *
 *   { id, dataset, category, question, history, answerA, answerB,
 *     modelA, modelB, humanLabel, humanVotes, ambiguous, bothBad,
 *     labelSource, turn, license, source }
 *
 * 【为什么 loader 放测试侧而不是产品侧】
 * 产品运行时不需要读标注集 —— 校准是**开发期**动作。
 * 产品侧只留「算指标」的部分(electron/learning/JudgeCalibration.ts)。
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { CalibrationItem } from '../../electron/learning/JudgeCalibration'

// vitest 跑在 jsdom 环境里,import.meta.url 不是 file: 协议(fileURLToPath 会抛)
// 而 vitest 的 cwd 就是仓库根 —— 用它做路径基准
export const REPO_ROOT = process.cwd()
export const CALIBRATION_DIR = join(REPO_ROOT, '.tmp-calibration')
export const DATASET_DIR = join(CALIBRATION_DIR, 'datasets')
export const OUTPUT_DIR = join(CALIBRATION_DIR, 'out')
export const FIXTURE_DIR = join(REPO_ROOT, 'tests', 'fixtures', 'judge-calibration')

/** 把一行 JSONL 解析成 CalibrationItem(缺字段补默认值,不抛) */
export function parseCalibrationRow(line: string): CalibrationItem | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const humanLabel = String(raw.humanLabel ?? '')
  if (humanLabel !== 'A' && humanLabel !== 'B' && humanLabel !== 'tie') return null
  return {
    id: String(raw.id ?? ''),
    dataset: String(raw.dataset ?? ''),
    category: String(raw.category ?? ''),
    question: String(raw.question ?? ''),
    answerA: String(raw.answerA ?? ''),
    answerB: String(raw.answerB ?? ''),
    humanLabel,
    humanVotes: (raw.humanVotes ?? {}) as Record<string, number>,
    ambiguous: raw.ambiguous === true,
    bothBad: raw.bothBad === true,
    license: raw.license ? String(raw.license) : undefined,
    source: raw.source ? String(raw.source) : undefined,
  }
}

/** 解析整份 JSONL */
export function parseCalibrationJsonl(text: string): CalibrationItem[] {
  const out: CalibrationItem[] = []
  for (const line of text.split('\n')) {
    const row = parseCalibrationRow(line)
    if (row) out.push(row)
  }
  return out
}

/** 读一个 JSONL 文件(不存在则返回空数组) */
export function loadCalibrationFile(path: string): CalibrationItem[] {
  if (!existsSync(path)) return []
  return parseCalibrationJsonl(readFileSync(path, 'utf-8'))
}

/**
 * 找出重复的 id。
 *
 * 【为什么要有这个守卫】
 * 实跑踩到:MT-Bench 同一 (question_id, turn) 下有多个模型对,id 只用
 * qid:turn 就撞号了。撞号后校准侧的 `itemById` 映射会取到**另一对**的样本
 * —— 那几条等于对着错的题算一致度,而报告里看不出来。
 * 故:载入后必须查重,撞号宁可报错也不要静默算错。
 */
export function findDuplicateIds(items: CalibrationItem[]): string[] {
  const seen = new Set<string>()
  const dupes = new Set<string>()
  for (const item of items) {
    if (seen.has(item.id)) dupes.add(item.id)
    seen.add(item.id)
  }
  return [...dupes]
}

/**
 * 确定性抽样 —— 不用 Math.random。
 *
 * 【为什么必须确定性】
 * 校准要能被复现:同一批样本两次抽样必须一致,否则两次跑的 κ 不能对比
 * (judge drift 的对比尤其依赖这一点)。
 */
export function sampleStratified(
  items: CalibrationItem[],
  perCategory: number,
): CalibrationItem[] {
  const byCategory = new Map<string, CalibrationItem[]>()
  for (const item of items) {
    const list = byCategory.get(item.category) ?? []
    list.push(item)
    byCategory.set(item.category, list)
  }
  const picked: CalibrationItem[] = []
  for (const list of byCategory.values()) {
    // 按 id 排序后取前 N —— 确定性,且与文件顺序无关
    const sorted = [...list].sort((a, b) => a.id.localeCompare(b.id))
    picked.push(...sorted.slice(0, perCategory))
  }
  return picked.sort((a, b) => a.id.localeCompare(b.id))
}
