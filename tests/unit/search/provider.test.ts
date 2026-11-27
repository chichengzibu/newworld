/**
 * NOVA #004-B · M3 联网搜索 · Provider 纯函数 + 行为单测（第①笔）
 *
 * 设计稿 F7 口径:
 *   — parseLiteHtml 纯函数直测(fixture HTML → 断言解析结果)
 *   — search(q, fetchImpl?) DI 注入 mock fetch(零 vi.stubGlobal)
 *   — 429 熔断 / 单飞行 / 两端点降级 / NW_E2E stub 零网络
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  DuckDuckGoHtmlProvider,
  parseLiteHtml,
  decodeEntities,
  ENDPOINTS,
  MAX_TITLE,
  MAX_URL,
  MAX_SNIPPET,
} from '../../../electron/core/search'

// ── fixture ──
const LITE_FIXTURE = `
<html><body><table>
<tr><td><a class="result-link" href="https://example.com/one?a=1&amp;b=2">Example <b>One</b></a></td></tr>
<tr><td class="result-snippet">The first &amp; best result about <i>search</i> entities.</td></tr>
<tr><td><a class="result-link" href="https://example.com/two">Example Two</a></td></tr>
<tr><td class="result-snippet">Second snippet — short.</td></tr>
</table></body></html>`

const LOOSE_FIXTURE = `
<html><body>
<div><a class="result__a" href="https://example.com/loose-1">Loose One</a></div>
<div class="result__snippet">Loose snippet one.</div>
<div><a class="result__a" href="https://example.com/loose-2">Loose Two</a></div>
<div class="result__snippet">Loose snippet two.</div>
</body></html>`

function mockFetch(responses: Array<{ status: number; body: string; statusText?: string }>) {
  let i = 0
  return (async (_url: string | globalThis.URL | globalThis.Request, _init?: RequestInit): Promise<Response> => {
    const r = responses[Math.min(i, responses.length - 1)]
    i++
    return new Response(r.body, { status: r.status, statusText: r.statusText ?? 'OK' })
  }) as unknown as typeof fetch
}

describe('parseLiteHtml(纯函数)', () => {
  it('lite 结构: 2 条 link/snippet 1:1 配对', () => {
    const hits = parseLiteHtml(LITE_FIXTURE)
    expect(hits).toHaveLength(2)
    expect(hits[0].url).toBe('https://example.com/one?a=1&b=2')
    expect(hits[0].title).toBe('Example One')
    expect(hits[0].snippet).toContain('first & best result')
    expect(hits[1].url).toBe('https://example.com/two')
    expect(hits[1].snippet).toBe('Second snippet — short.')
  })

  it('loose(pattern 备胎)结构: result__a / result__snippet 也解析', () => {
    const hits = parseLiteHtml(LOOSE_FIXTURE)
    expect(hits).toHaveLength(2)
    expect(hits[0].url).toBe('https://example.com/loose-1')
    expect(hits[0].snippet).toBe('Loose snippet one.')
    expect(hits[1].url).toBe('https://example.com/loose-2')
  })

  it('字段规则: title 被剥标签/解码实体; url 非绝对 http(s) 即弃', () => {
    const html = `
      <html><body>
      <a class="result-link" href="javascript:alert(1)">Bad</a>
      <a class="result-link" href="https://ok.example/x">Good</a>
      <span class="result-snippet">ok snippet</span>
      </body></html>`
    const hits = parseLiteHtml(html)
    expect(hits).toHaveLength(1)
    expect(hits[0].url).toBe('https://ok.example/x')
  })

  it('全零命中 → 返回空数组(端点切换由 provider 侧驱动)', () => {
    expect(parseLiteHtml('<html><body><p>nothing</p></body></html>')).toHaveLength(0)
  })

  it('实体解码 6 码(&amp; &lt; &gt; &quot; &#39; &nbsp;)', () => {
    expect(decodeEntities('a &amp; b &lt;c&gt; &quot;x&quot; &#39;y&#39; &nbsp;')).toBe(
      'a & b <c> "x" \'y\'  ',
    )
  })

  it('title/snippet 在 provider 结果内截断到上限 + …收尾', async () => {
    const longTitle = 'T'.repeat(MAX_TITLE + 50)
    const longSnippet = 'S'.repeat(MAX_SNIPPET + 50)
    const html = `<a class="result-link" href="https://x.example/1">${longTitle}</a><span class="result-snippet">${longSnippet}</span>`
    const provider = new DuckDuckGoHtmlProvider()
    const results = await provider.search(
      { query: 'x' },
      mockFetch([{ status: 200, body: html }]),
    )
    expect(results).toHaveLength(1)
    expect(results[0].title.length).toBeLessThanOrEqual(MAX_TITLE + 1) // 含 …
    expect(results[0].title.endsWith('…')).toBe(true)
    expect(results[0].snippet.length).toBeLessThanOrEqual(MAX_SNIPPET + 1)
    expect(results[0].url.length).toBeLessThanOrEqual(MAX_URL + 1)
  })
})

describe('search(DI fetchImpl + 失败/频控行为)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('正常成功: POST 体 q=urlencoded + 返回结构化结果(provider/fetchedAt 在场)', async () => {
    const fetchImpl = mockFetch([{ status: 200, body: LITE_FIXTURE }])
    const spy = vi.fn(fetchImpl)
    const provider = new DuckDuckGoHtmlProvider()
    const results = await provider.search({ query: 'hello world', count: 3 }, spy)
    expect(results).toHaveLength(2)
    expect(results[0].provider).toBe('duckduckgo-html')
    expect(typeof results[0].fetchedAt).toBe('number')
    // POST 体断言(q= 必须 urlencoded)
    const init = (spy.mock.calls[0]?.[1] as RequestInit)
    expect(init?.method).toBe('POST')
    expect(String(init?.body)).toContain('q=hello%20world')
    // 端点走首选 lite
    expect(spy.mock.calls[0]?.[0]).toBe(ENDPOINTS[0])
  })

  it('429 → rate-limited; 再次 search → cooldown 内直接 rate-limited(未触网)', async () => {
    const provider = new DuckDuckGoHtmlProvider()
    const fetchImpl = mockFetch([{ status: 429, body: 'too many' }])
    const spy = vi.fn(fetchImpl)
    await expect(provider.search({ query: 'a' }, spy)).rejects.toMatchObject({
      name: 'SearchError',
      code: 'rate-limited',
    })
    // cooldown 内第二次: 0 次新网络调用
    await expect(provider.search({ query: 'a' }, spy)).rejects.toMatchObject({
      name: 'SearchError',
      code: 'rate-limited',
    })
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('连续 2 次 429 → 二次熔断(新实例, cooldown 升级语义生效即不 crash)', async () => {
    const provider = new DuckDuckGoHtmlProvider()
    const spy = vi.fn(mockFetch([{ status: 429, body: '' }]))
    await expect(provider.search({ query: 'a' }, spy)).rejects.toMatchObject({ code: 'rate-limited' })
    await expect(provider.search({ query: 'a', count: 1 }, spy)).rejects.toMatchObject({ code: 'rate-limited' })
  })

  it('非 429 网络错误(500) → network', async () => {
    const provider = new DuckDuckGoHtmlProvider()
    await expect(
      provider.search({ query: 'a' }, mockFetch([{ status: 500, body: 'boom' }])),
    ).rejects.toMatchObject({ name: 'SearchError', code: 'network' })
  })

  it('首端点全零 → 自动切第二端点(容错三保险 (c))', async () => {
    const provider = new DuckDuckGoHtmlProvider()
    const spy = vi.fn(
      (async (url?: string): Promise<Response> => {
        if (String(url) === ENDPOINTS[0]) return new Response('<html>empty</html>', { status: 200 })
        return new Response(LITE_FIXTURE, { status: 200 })
      }) as typeof fetch,
    )
    const results = await provider.search({ query: 'x' }, spy)
    expect(spy).toHaveBeenCalledTimes(2)
    expect(results).toHaveLength(2)
  })

  it('两端点都全零 → parse-empty', async () => {
    const provider = new DuckDuckGoHtmlProvider()
    await expect(
      provider.search({ query: 'x' }, mockFetch([{ status: 200, body: '<html>nope</html>' }])),
    ).rejects.toMatchObject({ name: 'SearchError', code: 'parse-empty' })
  })

  it('AbortSignal → timeout', async () => {
    const provider = new DuckDuckGoHtmlProvider()
    const controller = new AbortController()
    controller.abort()
    const fetchImpl = (async (_url: string, init?: RequestInit): Promise<Response> => {
      const s = init?.signal as AbortSignal | undefined
      const err = new Error('aborted') as Error & { name: string }
      err.name = 'AbortError'
      if (s?.aborted) throw err
      return new Response('', { status: 200 })
    }) as typeof fetch
    await expect(
      provider.search({ query: 'x', signal: controller.signal }, fetchImpl),
    ).rejects.toMatchObject({ name: 'SearchError', code: 'timeout' })
  })

  it('query 为空 → invalid-query(不触网)', async () => {
    const provider = new DuckDuckGoHtmlProvider()
    const spy = vi.fn(mockFetch([{ status: 200, body: LITE_FIXTURE }]))
    await expect(provider.search({ query: '   ' }, spy)).rejects.toMatchObject({ code: 'invalid-query' })
    expect(spy).not.toHaveBeenCalled()
  })

  it('单飞行: 同 query 并发 → 复用同一网络请求', async () => {
    const provider = new DuckDuckGoHtmlProvider()
    // fetch 延迟 50ms 后自动完成(无手动 release, 避免 await 结构死锁)
    const fetchImpl = (async (_url: string): Promise<Response> => {
      await new Promise<void>((r) => setTimeout(r, 50))
      return new Response(LITE_FIXTURE, { status: 200 })
    }) as typeof fetch
    const spy = vi.fn(fetchImpl)
    const pa = provider.search({ query: 'same  query' }, spy)
    const pb = provider.search({ query: 'same query' }, spy)
    const [a, b] = await Promise.all([pa, pb])
    expect(a).toEqual(b)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(a).toHaveLength(2)
  })

  it('NW_E2E=1 → 固定 stub 2 条, 零网络', async () => {
    vi.stubEnv('NW_E2E', '1')
    try {
      const provider = new DuckDuckGoHtmlProvider()
      const spy = vi.fn(mockFetch([{ status: 200, body: LITE_FIXTURE }]))
      const results = await provider.search({ query: 'anything' }, spy)
      expect(results).toHaveLength(2)
      expect(results[0]).toMatchObject({
        title: '[e2e stub] result 1',
        url: 'https://example.com/stub/1',
        provider: 'duckduckgo-html',
      })
      expect(spy).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllEnvs?.()
    }
  })
})
