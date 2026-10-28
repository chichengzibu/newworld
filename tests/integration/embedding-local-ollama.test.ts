/**
 * PiPiClaw — M3-A 真向量集成验证（本地 ollama）
 * ═══════════════════════════════════════════════════════════════
 * 【这份测试的意义】
 * 前面那份是 mock —— 证明「代码会打对接口」。这份打**真的本地 ollama**,
 * 证明「接上之后,记忆检索真的变好了」。
 *
 * 【验收标准是产品行为,不是接口形状】
 * 核心断言:一条**改写过的**查询(与记忆原文用词不同),
 * 在真向量下能把目标记忆排到第一;而在伪向量下排不到。
 *
 * 这正是「真向量」与「伪向量」的分界线:
 *   伪向量(SHA-256)→ 相似度随机 → 改写查询召不回原记忆
 *   真向量(bge-m3)  → 语义相近 → 改写查询能召回
 *
 * 【本地模型】
 * 用本机 ollama 已装的嵌入模型(优先 bge-m3,566M 参数 —— 小参数,本地可跑)。
 * ollama 不可用时**跳过**而不是失败 —— CI/无 ollama 环境不该红。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { getHost } from '../../electron/platform/runtime'

import { EmbeddingService } from '../../electron/hermes/EmbeddingService'
import { HermesAdapter } from '../../electron/hermes/HermesAdapter'
import { KeywordRetriever } from '../../electron/hermes/KeywordRetriever'

const OLLAMA_BASE = 'http://localhost:11434'

/** 本机可用的嵌入模型(优先 bge-m3) */
let localModel = ''
let ollamaAvailable = false

/** 目标记忆与查询:用词刻意不同,只有语义相近才召得回 */
const TARGET = '用户习惯把桌面上的 PDF 文档统一归档到 D:/Documents/PDF 目录'
const OTHER = '用户喜欢在早上八点喝一杯手冲咖啡'
const QUERY = 'PDF 文件应该放到哪个文件夹里比较好'

function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length)
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]
  }
  return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb))
}

describe('M3-A 真向量集成（本地 ollama）', () => {
  beforeAll(async () => {
    const svc = EmbeddingService.getInstance()
    const detected = await svc.listOllamaEmbeddingModels(OLLAMA_BASE)
    ollamaAvailable = detected.available && detected.models.length > 0
    if (ollamaAvailable) {
      localModel = detected.models.find((m) => m.includes('bge-m3')) ?? detected.models[0]
    }
  })

  afterAll(() => {
    // 复位配置,别把测试环境的 provider 留在磁盘上
    EmbeddingService.getInstance().setConfig({})
  })

  it('本机 ollama 可用且能探测到嵌入模型', () => {
    if (!ollamaAvailable) {
      console.warn('[M3-A] 本地 ollama 不可用或未装嵌入模型 —— 跳过真向量集成验证')
      return
    }
    expect(localModel).toBeTruthy()
    console.log(`[M3-A] 使用本地嵌入模型: ${localModel}`)
  })

  it('真向量:相近文本的余弦明显高于无关文本', async () => {
    if (!ollamaAvailable) return
    const svc = EmbeddingService.getInstance()
    svc.setConfig({ provider: 'ollama', baseUrl: OLLAMA_BASE, model: localModel })

    const [target, other, query] = await Promise.all([
      svc.embedText(TARGET, { cache: false }),
      svc.embedText(OTHER, { cache: false }),
      svc.embedText(QUERY, { cache: false }),
    ])

    const simToTarget = cosine(query, target)
    const simToOther = cosine(query, other)

    // 伪向量下这两个值是随机的;真向量必须有明显间隔
    expect(simToTarget).toBeGreaterThan(simToOther + 0.1)
    console.log(`[M3-A] cos(查询,目标)=${simToTarget.toFixed(4)} cos(查询,无关)=${simToOther.toFixed(4)}`)
  }, 60000)

  it('探测自检:真向量后端 meaningful=true', async () => {
    if (!ollamaAvailable) return
    const svc = EmbeddingService.getInstance()
    svc.setConfig({ provider: 'ollama', baseUrl: OLLAMA_BASE, model: localModel })

    const r = await svc.probe()
    expect(r.ok).toBe(true)
    expect(r.realVectors).toBe(true)
    expect(r.dimension).toBeGreaterThan(64)   // stub 是 64 维
    expect(r.semanticCheck?.meaningful).toBe(true)
  }, 60000)

  it('产品行为:改写过的查询能把目标记忆排到第一(真向量)', async () => {
    if (!ollamaAvailable) return
    const svc = EmbeddingService.getInstance()
    svc.setConfig({ provider: 'ollama', baseUrl: OLLAMA_BASE, model: localModel })

    const adapter = HermesAdapter.getInstance() as any
    // 记两条记忆
    await adapter.store({ id: 'm-target', content: TARGET, score: 50, createdAt: Date.now() })
    await adapter.store({ id: 'm-other', content: OTHER, score: 50, createdAt: Date.now() })

    // 只用向量召回(关掉关键词,否则字面匹配会掩盖向量效果)
    const hits = await adapter.recall(QUERY, { topK: 5, minScore: -1, useVector: true, useKeyword: false })

    expect(hits.length).toBeGreaterThan(0)
    const first = hits[0]
    console.log(`[M3-A] 首位召回: "${first.content?.slice(0, 30)}..." (score=${first._score?.toFixed?.(4) ?? first._score})`)
    expect(first.content).toContain('PDF')
  }, 60000)

  /**
   * 【M3-B】混合检索:中文分词修复的可测量效果。
   *
   * 查询集刻意**不含任何字面重叠词**(与目标记忆用词完全不同),
   * 测的是「词法那一路在改写查询上还剩多少召回能力」。
   *
   * 旧分词器(按空格/标点切)在中文上把整句当词条 → 命中数为 0;
   * 新分词器(CJK bigram)靠共享字对命中 → 命中率显著上升。
   */
  it('M3-B: CJK bigram 分词让关键词路在改写查询上重新有效', async () => {
    if (!ollamaAvailable) return
    const svc = EmbeddingService.getInstance()
    const adapter = HermesAdapter.getInstance() as any
    const kr = KeywordRetriever.getInstance()

    const TARGET = '用户习惯把桌面上那些 PDF 文档统一放到 D:/Documents/PDF 目录里归类'
    const DISTRACTORS = [
      '用户喜欢在早上八点喝一杯手冲咖啡',
      '项目代码用 TypeScript 编写,构建走 vite',
      '每周一上午有团队例会,讨论本周排期',
      '用户把开发环境装在 D 盘,其余盘留给游戏',
      '密码提示问题统一用童年养的狗的名字',
      '打印机默认是办公室那台,墨粉不太够用了',
      '用户出差常去的城市是成都和杭州',
    ]
    // 改写查询:与目标无字面重叠
    const QUERIES = [
      '我那些文件该收到哪儿去',
      '怎么把东西收拾到一处',
      '平时的东西都放哪比较合适',
      '帮我把零散的内容集中放',
      '东西太乱了想整理一下',
      '散落的东西怎么归拢',
    ]
    const all = [TARGET, ...DISTRACTORS]
    const mems = all.map((c, i) => ({ id: `m-${i}`, content: c, score: 50, createdAt: 0 }))

    // 旧分词器(按空格/标点切)
    const oldTok = (t: string) => t.split(/[\s\p{P}]+/u).filter(x => x.length > 0).map(x => x.toLowerCase())
    const oldSearch = (query: string, ms: any[]) => {
      const qt = oldTok(query)
      if (!qt.length) return []
      const out: any[] = []
      for (const m of ms) {
        const set = new Set(oldTok(m.content))
        let hit = 0
        for (const t of qt) if (set.has(t)) hit++
        if (hit > 0) out.push({ memory: m, score: hit / qt.length })
      }
      out.sort((a, b) => b.score - a.score)
      return out
    }

    let oldHit = 0
    let newHit = 0
    for (const q of QUERIES) {
      const o = oldSearch(q, mems)
      if (o.length > 0 && o[0].memory.content === TARGET) oldHit++
      const n = kr.search(q, mems as any, 3)
      if (n.length > 0 && n[0].memory.content === TARGET) newHit++
    }
    console.log(`[M3-B] 关键词路 top-1: 旧分词=${oldHit}/${QUERIES.length} → bigram=${newHit}/${QUERIES.length}`)
    // 旧分词器在中文改写查询上几乎完全失效;bigram 把它救回来了
    expect(newHit).toBeGreaterThan(oldHit)
  }, 60000)

  /**
   * 【M3-B】混合(RRF)不能比纯向量更差 —— 融合的底线是「不添乱」。
   */
  it('M3-B: 混合检索(RRF)不劣于纯向量路', async () => {
    if (!ollamaAvailable) return
    const svc = EmbeddingService.getInstance()
    const adapter = HermesAdapter.getInstance() as any

    const TARGET = '用户习惯把桌面上那些 PDF 文档统一放到 D:/Documents/PDF 目录里归类'
    const DISTRACTORS = [
      '用户喜欢在早上八点喝一杯手冲咖啡',
      '项目代码用 TypeScript 编写,构建走 vite',
      '每周一上午有团队例会,讨论本周排期',
      '用户把开发环境装在 D 盘,其余盘留给游戏',
      '密码提示问题统一用童年养的狗的名字',
      '打印机默认是办公室那台,墨粉不太够用了',
      '用户出差常去的城市是成都和杭州',
    ]
    const QUERIES = [
      'PDF 文件放到哪个目录',
      'pdf 归档路径',
      'PDF 文档的位置',
      '我那些文件该收到哪儿去',
      '怎么把东西收拾到一处',
      '平时的东西都放哪比较合适',
      '帮我把零散的内容集中放',
      '东西太乱了想整理一下',
    ]
    const all = [TARGET, ...DISTRACTORS]

    svc.setConfig({ provider: 'ollama', baseUrl: OLLAMA_BASE, model: localModel })

    const run = async (opts: any): Promise<number> => {
      const memDir = path.join(getHost().getPath('userData'), 'hermes-memory')
      fs.mkdirSync(memDir, { recursive: true })
      ;(adapter as any).legacy.clearAllMemories()
      await (adapter as any).vectorStore.reset()
      for (let i = 0; i < all.length; i++) {
        await adapter.store({ id: `m-${i}`, content: all[i], score: 50, createdAt: Date.now() })
      }
      let hit = 0
      for (const q of QUERIES) {
        const hits = await adapter.recall(q, { topK: 3, minScore: -1, ...opts })
        if (hits.length > 0 && hits[0].content === TARGET) hit++
      }
      return hit
    }

    const vecOnly = await run({ useVector: true, useKeyword: false })
    const hybrid = await run({ useVector: true, useKeyword: true })
    console.log(`[M3-B] top-1 命中: 纯向量=${vecOnly}/${QUERIES.length} 混合RRF=${hybrid}/${QUERIES.length}`)
    expect(hybrid).toBeGreaterThanOrEqual(vecOnly)
  }, 180000)

  it('对照 A/B:真向量的改写召回命中率显著高于伪向量', async () => {
    if (!ollamaAvailable) return
    const svc = EmbeddingService.getInstance()
    const adapter = HermesAdapter.getInstance() as any

    // 8 条记忆,只有 1 条与查询相关;查询是目标记忆的【改写】(用词不同)
    const TARGET = '用户习惯把桌面上的 PDF 文档统一归档到 D:/Documents/PDF 目录'
    const DISTRACTORS = [
      '用户喜欢在早上八点喝一杯手冲咖啡',
      '项目代码用 TypeScript 编写,构建走 vite',
      '每周一上午有团队例会,讨论本周排期',
      '用户把开发环境装在 D 盘,其余盘留给游戏',
      '密码提示问题统一用童年养的狗的名字',
      '打印机默认是办公室那台,墨粉不太够用了',
      '用户出差常去的城市是成都和杭州',
    ]
    const QUERIES = [
      'PDF 文件应该放到哪个文件夹里比较好',
      '文档统一放到哪里去',
      '把 pdf 归到同一个目录',
      '那些 pdf 文件归档位置',
      'PDF 存哪个路径',
      'pdf 文档收纳目录',
    ]

    const all = [TARGET, ...DISTRACTORS]
    const ids = all.map((_, i) => `m-${i}`)

    /** 跑一轮:返回 top-1 命中目标的次数 */
    const runOnce = async (): Promise<number> => {
      // 清空后重记(每次跑的是同一批记忆,只有嵌入后端不同)
      //   注意 HermesAdapter.store() 生成的记忆 id 与传入的 id 不同
      //   (它走 HermesMemory.addExperienceMemory,那边自生成 id),
      //   故断言用【内容】比对而非 id。
      // HermesMemory.clearAllMemories() 会重写 USER.md —— 目录被测试清理过,
      // 先确保它在,否则 ENOENT。
      const memDir = path.join(getHost().getPath('userData'), 'hermes-memory')
      fs.mkdirSync(memDir, { recursive: true })
      ;(adapter as any).legacy.clearAllMemories()
      await (adapter as any).vectorStore.reset()
      for (let i = 0; i < all.length; i++) {
        await adapter.store({ id: ids[i], content: all[i], score: 50, createdAt: Date.now() })
      }
      let hit = 0
      for (const q of QUERIES) {
        const hits = await adapter.recall(q, { topK: 3, minScore: -1, useVector: true, useKeyword: false })
        if (hits.length > 0 && hits[0].content === TARGET) hit++
      }
      return hit
    }

    // ── 真向量 ──
    svc.setConfig({ provider: 'ollama', baseUrl: OLLAMA_BASE, model: localModel })
    const realHits = await runOnce()
    console.log(`[M3-A] 真向量 top-1 命中: ${realHits}/${QUERIES.length}`)

    // ── 伪向量 ──
    svc.setConfig({})
    const stubHits = await runOnce()
    console.log(`[M3-A] 伪向量 top-1 命中: ${stubHits}/${QUERIES.length}`)

    // 随机基线 = 1/8 = 12.5%
    expect(realHits).toBeGreaterThan(stubHits)
    expect(realHits).toBeGreaterThanOrEqual(QUERIES.length - 1)   // 真向量几乎全中
  }, 180000)
})
