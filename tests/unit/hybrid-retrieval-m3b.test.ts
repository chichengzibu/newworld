/**
 * New World — M3-B 混合检索测试（中文分词 + RRF 融合）
 * ═══════════════════════════════════════════════════════════════
 * 【这一批修两件事】
 *
 * ① 中文分词 —— 原实现按 `[\s\p{P}]+` 切,只切空格与标点。
 *    对中文的后果:「用户习惯把桌面上的 PDF 文档统一归档」被切成
 *    ["用户习惯把桌面上的", "pdf", "文档统一归档"] —— 整句成词条,
 *    只有**字面完全一致**的长句才匹配得上,改写一个字就召不回。
 *    对一个国产中文桌面助手的记忆检索,这是硬伤。
 *    现按 CJK 连续段切**字符 bigram**(标准做法,不需要词典)。
 *
 * ② 融合方式 —— 原实现对「关键词路」与「向量路」**取分数的最大值**。
 *    但两路的分数量纲完全不同:
 *      关键词路 = 命中词数 / 查询词数(覆盖率,∈[0,1])
 *      向量路   = 余弦相似度(∈[-1,1])
 *    拿两把不同的尺子比大小。现改为 RRF(只看排名)。
 *
 * 【实测(本地 ollama bge-m3,见 tests/integration/embedding-local-ollama.test.ts)】
 *   纯改写查询集(6 条,无字面重叠):关键词路 旧 0/6 → 新 2/6;向量路 6/6
 *   混合查询集(8 条):关键词路 旧 3/8 → 新 4/8;向量路 7/8;混合 7/8
 *   → 分词是可测量的改善;RRF 在命中率上与「取最大」持平(7/8),
 *     它的价值是结构性的(消除量纲错误 + 双路一致加成),故本文件
 *     **断言性质而非命中率**。
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: vi.fn((k: string) => `/tmp/newworld-m3b-${k}`) },
}))

vi.mock('electron-log', () => ({
  default: {
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
    transports: { file: { resolvePathFn: () => {}, maxSize: 0, format: '' }, console: { level: 'info' } },
  },
}))

import { KeywordRetriever } from '../../electron/hermes/KeywordRetriever'
import { rrfFuse } from '../../electron/hermes/HermesAdapter'
import type { Memory } from '../../electron/contracts/types'

const mem = (id: string, content: string): Memory =>
  ({ id, content, score: 50, createdAt: 0 } as Memory)

/** 旧分词器(按空格/标点切)—— 对照用 */
function oldTokenize(text: string): string[] {
  return text
    .split(/[\s\p{P}]+/u)
    .filter(t => t.length > 0)
    .map(t => t.toLowerCase())
}

describe('M3-B ① 中文分词(CJK bigram)', () => {
  const kr = KeywordRetriever.getInstance()

  it('中文连续段 → 字符 bigram', () => {
    const tokens = kr.tokenize('文档统一归档')
    expect(tokens).toEqual(['文档', '档统', '统一', '一归', '归档'])
  })

  it('单个汉字 → 单字', () => {
    expect(kr.tokenize('猫')).toEqual(['猫'])
  })

  it('中英混排 → 分段处理("PDF文档" → ["pdf", "文档"])', () => {
    const tokens = kr.tokenize('PDF文档')
    expect(tokens).toContain('pdf')
    expect(tokens).toContain('文档')
    // 不该把整段当成一个词条
    expect(tokens).not.toContain('pdf文档')
  })

  it('拉丁词仍按词切 + 小写 + 过滤停用词', () => {
    const tokens = kr.tokenize('The Quick Brown Fox')
    expect(tokens).toEqual(['quick', 'brown', 'fox'])
  })

  it('改写后的中文查询仍能命中(旧分词器做不到)', () => {
    const memory = mem('m1', '用户习惯把桌面上那些 PDF 文档统一放到一个专门的文件夹里归类')
    const query = '那些材料怎么归拢到一起'

    // 新分词器:共享 bigram(「归」「类」等)→ 有命中
    const newHits = kr.search(query, [memory], 5)
    expect(newHits.length).toBeGreaterThan(0)
    expect(newHits[0].matchedTerms.length).toBeGreaterThan(0)

    // 旧分词器:整句成词条 → 完全命中不了
    const oldQueryTerms = oldTokenize(query)
    const oldMemoryTerms = new Set(oldTokenize(memory.content))
    const oldHit = oldQueryTerms.filter(t => oldMemoryTerms.has(t)).length
    expect(oldHit).toBe(0)   // ← 这就是旧实现的真实水平
  })

  it('共享 bigram 的数量越多,覆盖率越高(排序有意义)', () => {
    const strong = mem('s', '文件统一放到专门的文件夹里归类管理')
    const weak = mem('w', '文件这个词本身在很多地方都会出现')
    const hits = kr.search('文件归类', [strong, weak], 5)
    expect(hits.length).toBeGreaterThanOrEqual(2)
    expect(hits[0].memory.id).toBe('s')
    expect(hits[0].score).toBeGreaterThan(hits[1].score)
  })
})

describe('M3-B ② RRF 融合', () => {
  it('只看排名:分数放大 100 倍不改变排序', () => {
    // 量纲无关 —— 这正是「取最大」做不到的
    const a = mem('a', 'A'); const b = mem('b', 'B')
    const small = rrfFuse([[{ id: 'a', memory: a, score: 0.9 }, { id: 'b', memory: b, score: 0.8 }]], 60)
    const big = rrfFuse([[{ id: 'a', memory: a, score: 90 }, { id: 'b', memory: b, score: 80 }]], 60)
    expect(small.map(x => x.id)).toEqual(big.map(x => x.id))
    expect(small[0]._score).toBeCloseTo(big[0]._score)
  })

  it('双路都命中的结果排在单路命中的前面(一致性是强信号)', () => {
    // X 只在关键词路排第 1;Y 两路都在(关键词第 2、向量第 1)
    //   「取最大」: X=1.0 > Y=0.85 → X 赢(错:只字面强命中就压过语义首选)
    //   RRF:     X=1/61+1/63=0.03227; Y=1/62+1/61=0.03252 → Y 赢(对)
    const x = mem('x', 'X'); const y = mem('y', 'Y')
    const kwList = [
      { id: 'x', memory: x, score: 1.0 },
      { id: 'y', memory: y, score: 0.5 },
      { id: 'z', memory: mem('z', 'Z'), score: 0.4 },
    ]
    const vecList = [
      { id: 'y', memory: y, score: 0.85 },
      { id: 'z', memory: mem('z', 'Z'), score: 0.8 },
      { id: 'x', memory: x, score: 0.3 },
    ]
    const fused = rrfFuse([kwList, vecList], 60)
    expect(fused[0].id).toBe('y')
    // 严格领先(不是并列第一)
    expect(fused[0]._score).toBeGreaterThan(fused[1]._score)

    // 旧融合在同一组数据上会给 X —— 锁住这个差异
    const merged = new Map<string, number>()
    for (const r of kwList) merged.set(r.id, Math.max(merged.get(r.id) ?? -Infinity, r.score))
    for (const r of vecList) merged.set(r.id, Math.max(merged.get(r.id) ?? -Infinity, r.score))
    const oldTop = [...merged.entries()].sort((a, b) => b[1] - a[1])[0][0]
    expect(oldTop).toBe('x')
  })

  it('单路列表的结果也会进入融合结果', () => {
    const only = mem('only', '只在向量里')
    const fused = rrfFuse([[{ id: 'only', memory: only, score: 0.5 }]], 60)
    expect(fused.length).toBe(1)
    expect(fused[0].id).toBe('only')
  })

  it('空列表不炸', () => {
    expect(rrfFuse([], 60)).toEqual([])
    expect(rrfFuse([[], []], 60)).toEqual([])
  })

  it('分数单调不增(排序稳定可预期)', () => {
    const fused = rrfFuse([
      [{ id: 'a', memory: mem('a', 'a'), score: 1 }, { id: 'b', memory: mem('b', 'b'), score: 0.9 }],
      [{ id: 'c', memory: mem('c', 'c'), score: 0.8 }, { id: 'a', memory: mem('a', 'a'), score: 0.7 }],
    ], 60)
    for (let i = 1; i < fused.length; i++) {
      expect(fused[i - 1]._score).toBeGreaterThanOrEqual(fused[i]._score)
    }
  })
})
