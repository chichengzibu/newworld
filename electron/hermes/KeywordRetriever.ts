import { LogManager } from '../core/LogManager'
import type { Memory } from '../contracts/types'

export interface KeywordScore {
  memory: Memory
  score: number
  matchedTerms: string[]
}

const STOP_WORDS = new Set(['的', '了', '在', '是', '我', '你', '他', '她', '它', '和', '与', '或', 'a', 'the', 'is', 'and', 'or', 'but', 'in', 'on', 'at'])

/**
 * CJK 字符区段(汉字 / 假名)。
 *
 * 【为什么要单独识别】见 tokenize 的说明 —— 中文没有词边界,
 * 按空格切会把整句当成一个词条,词匹配对中文基本失效。
 */
const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿]/

/**
 * KeywordRetriever: 关键词检索(无依赖,TF-style)
 * 命中关键词越多分数越高;停用词过滤
 *
 * 【M3-B 修正 — 中文分词】
 * 原实现按 `[\s\p{P}]+` 切分,只切空格与标点。对中文的后果是:
 *   「用户习惯把桌面上的 PDF 文档统一归档」 → 切成 ["用户习惯把桌面上的", "pdf", "文档统一归档"]
 * 整句成词条 → 只有**字面完全一致**的长句才匹配得上,改写一个字就召不回。
 * 对一个国产中文桌面助手的记忆检索,这是硬伤。
 *
 * 现按 CJK 连续段切**字符 bigram**(标准做法,不需要词典):
 *   「文档统一归档」 → ["文档", "档统", "统一", "一归", "归档"]
 * 改写后仍能通过共享 bigram 命中。
 *
 * 【边界口径 — 必须说清楚】
 * bigram 只解决**字面重叠**,解决不了**同义**。
 * 同义仍由向量那一路负责 —— 两路互补,故 M3-B 同时把融合方式从
 * 「取两路分数的最大值」改成 RRF(见 HermesAdapter.recall)。
 */
export class KeywordRetriever {
  private static instance: KeywordRetriever
  private log = LogManager.getInstance()

  private constructor() {}

  public static getInstance(): KeywordRetriever {
    if (!KeywordRetriever.instance) KeywordRetriever.instance = new KeywordRetriever()
    return KeywordRetriever.instance
  }

  /**
   * 分词:CJK 连续段 → 字符 bigram;拉丁/数字 → 词(小写,过滤停用词)。
   */
  public tokenize(text: string): string[] {
    const out: string[] = []
    for (const seg of text.split(/[\s\p{P}]+/u)) {
      if (!seg) continue
      // 一段里可能中英混排(如 "PDF文档")→ 先按 CJK/非 CJK 切成连续段
      const runs = seg.match(/[぀-ヿ㐀-䶿一-鿿豈-﫿]+|[^぀-ヿ㐀-䶿一-鿿豈-﫿]+/gu) ?? []
      for (const run of runs) {
        if (CJK.test(run)) {
          const chars = Array.from(run)
          if (chars.length === 1) {
            out.push(chars[0])
            continue
          }
          for (let i = 0; i < chars.length - 1; i++) {
            out.push(chars[i] + chars[i + 1])
          }
        } else {
          const t = run.toLowerCase()
          if (!STOP_WORDS.has(t)) out.push(t)
        }
      }
    }
    return out
  }

  search(query: string, memories: Memory[], topK = 5): KeywordScore[] {
    const queryTerms = this.tokenize(query)
    if (queryTerms.length === 0) return []
    const scores: KeywordScore[] = []
    for (const memory of memories) {
      const memoryTerms = this.tokenize(memory.content)
      const termSet = new Set(memoryTerms)
      const matched: string[] = []
      let hit = 0
      for (const qt of queryTerms) {
        if (termSet.has(qt)) {
          hit += 1
          matched.push(qt)
        }
      }
      if (hit > 0) {
        const score = hit / queryTerms.length
        scores.push({ memory, score, matchedTerms: matched })
      }
    }
    scores.sort((a, b) => b.score - a.score)
    return scores.slice(0, topK)
  }
}
