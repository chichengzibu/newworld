/**
 * NOVA #004-B · M3 联网搜索 · SearchRegistry / SearchCache 单测（第①笔）
 *
 * 覆盖(F9 预估 5+5=10 族):
 *   registry: getInstance 单例 / register+list / get 命中与未命中 / default 指向 /
 *             requiresKey 字段面(预留位)
 *   cache   : TTL 过期 / 100 条淘汰 / 5s 节流复用 / 失败不缓存为成功 / 幂等写
 *
 * 时钟可注入(SearchCache now) — 零真实等待。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { SearchRegistry, SearchCache } from '../../../electron/core/search'
import type { SearchProvider, SearchQuery, SearchResult } from '../../../electron/core/search'

function makeProvider(id: string, results: SearchResult[] = [], requiresKey = false): SearchProvider {
  return {
    id,
    label: `label-${id}`,
    requiresKey,
    search: async (_q: SearchQuery) => results,
  }
}

describe('SearchRegistry(getInstance 单例家族口径)', () => {
  beforeEach(() => {
    SearchRegistry.resetForTest()
  })

  it('getInstance 返回同一实例', () => {
    expect(SearchRegistry.getInstance()).toBe(SearchRegistry.getInstance())
  })

  it('register + list 保序', () => {
    const reg = SearchRegistry.getInstance()
    reg.register(makeProvider('a'))
    reg.register(makeProvider('b'))
    reg.register(makeProvider('c'))
    expect(reg.list().map((p) => p.id)).toEqual(['a', 'b', 'c'])
  })

  it('get 命中 / 未命中', () => {
    const reg = SearchRegistry.getInstance()
    reg.register(makeProvider('x'))
    expect(reg.get('x')?.id).toBe('x')
    expect(reg.get('nope')).toBeNull()
  })

  it('default = 首个注册者; 空注册表 → null', () => {
    expect(SearchRegistry.getInstance().default()).toBeNull()
    const reg = SearchRegistry.getInstance()
    const first = makeProvider('first')
    reg.register(first)
    reg.register(makeProvider('second'))
    expect(reg.default()).toBe(first)
  })

  it('requiresKey 字段面在位(预留位, MVP 恒 false)', () => {
    const reg = SearchRegistry.getInstance()
    const withKey = makeProvider('future', [], true)
    reg.register(withKey)
    expect(reg.get('future')?.requiresKey).toBe(true)
    expect(reg.list().every((p) => typeof p.requiresKey === 'boolean')).toBe(true)
  })
})

describe('SearchCache(LRU + TTL + 节流)', () => {
  let t: number
  let cache: SearchCache

  const mkResults = (n: number): SearchResult[] =>
    Array.from({ length: n }, (_, i) => ({
      title: `t${i}`,
      url: `https://x.example/${i}`,
      snippet: `s${i}`,
      provider: 'test',
      fetchedAt: 1,
    }))

  beforeEach(() => {
    t = 1_000_000
    // 默认容量 100 / TTL 300s / 节流 5s(稿 F6 §1)
    cache = new SearchCache({
      now: () => t,
    })
  })

  it('normalize: trim + 折叠空白 + lower', () => {
    expect(SearchCache.normalize('  Hello   WORLD ')).toBe('hello world')
  })

  it('TTL 300s 内命中; 过期后失效', () => {
    cache.set('k', { ok: true, results: mkResults(2) })
    expect(cache.getSuccess('k')).toHaveLength(2)
    t += 299_000
    expect(cache.getSuccess('k')).toHaveLength(2)
    t += 1_000 // 跨过 300s
    expect(cache.getSuccess('k')).toBeUndefined()
    expect(cache.size).toBe(0)
  })

  it('容量 100: 第 101 条触发最旧淘汰', () => {
    for (let i = 0; i < 101; i++) cache.set(`k${i}`, { ok: true, results: mkResults(1) })
    expect(cache.size).toBe(100)
    expect(cache.getSuccess('k0')).toBeUndefined() // 最旧被逐
    expect(cache.getSuccess('k100')).toHaveLength(1) // 最新在场
  })

  it('LRU 刷新: 读命中把该条移到"最新"序, 不淘汰', () => {
    for (let i = 0; i < 100; i++) cache.set(`k${i}`, { ok: true, results: mkResults(1) })
    // 读 k0 → 刷新到最新; 再写一条 → 应淘汰的是 k1
    expect(cache.getSuccess('k0')).toHaveLength(1)
    cache.set('knew', { ok: true, results: mkResults(1) })
    expect(cache.getSuccess('k0')).toHaveLength(1) // 存活(LRU 已刷新)
    expect(cache.getSuccess('k1')).toBeUndefined() // 最旧者被逐
  })

  it('5s 节流: 成功/失败尝试后 5s 内 isThrottled=true', () => {
    cache.set('q', { ok: true, results: mkResults(1) })
    expect(cache.isThrottled('q')).toBe(true)
    t += 4_999
    expect(cache.isThrottled('q')).toBe(true)
    t += 1
    expect(cache.isThrottled('q')).toBe(false)
  })

  it('失败只为节流: set ok=false 后 getSuccess 不得到成功结果, lastError 可取', () => {
    cache.set('bad', { ok: false, error: 'network' })
    expect(cache.getSuccess('bad')).toBeUndefined()
    expect(cache.isThrottled('bad')).toBe(true)
    expect(cache.lastError('bad')).toBe('network')
  })

  it('幂等写: 同 key 覆盖(不膨胀)', () => {
    cache.set('q', { ok: true, results: mkResults(1) })
    cache.set('q', { ok: true, results: mkResults(3) })
    expect(cache.getSuccess('q')).toHaveLength(3)
  })
})
