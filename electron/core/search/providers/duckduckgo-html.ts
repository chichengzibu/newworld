/**
 * NOVA #004-B · M3 联网搜索 · DuckDuckGo HTML Provider（第①笔）
 *
 * 设计稿: docs/NOVA-#004-M3-search-provider-design.md §F2 / §F7 / §F8
 * 端点: 首选 lite.duckduckgo.com/lite/ (纯 <table> 结构, 抗营销位漂移);
 *       备选 html.duckduckgo.com/html/ (富标记; 全零时端点切换兜底, 容错三保险 (c))
 * 方法: POST form-urlencoded(q=<urlencoded query>)
 * 频控: 单飞行(同 query 在途并发复用) + 429 熔断(Retry-After 兼容: 缺省 30s; 连 2 次升 5min)
 * 超时: 消费侧 AbortController 8000ms(F5 默认; 本 provider 透传 signal)
 * 零新依赖: 解析器 = 手写纯函数 parseLiteHtml(2 套 pattern 容错) + 6 码实体解码
 *
 * e2e:  PIPICLAW_E2E=1 第一行 stub 零网络(F7 §1)
 * DI:   search(q, fetchImpl?) 第二参注入 mock fetch(F7 §2, 免疫 vi.stubGlobal 时序坑)
 *
 * 安全边界(稿 F8): 请求域名硬编码(无任意 URL 入口);
 *   snippet 截断 300 / title 200 / url 512(离开解析层前完成)。
 */
import type { SearchProvider, SearchQuery, SearchResult } from '../types';
import { SearchError } from '../types';

/** 默认超时(ms; F5) — 供消费侧(第③笔 Search.vue)默认 AbortController 用 */
export const DEFAULT_TIMEOUT_MS = 8_000;

/** 熔断 cooldown: 缺省 30s; 连 2 次 429 升 5min(F2 §5) */
const CB_BASE_COOLDOWN_MS = 30_000;
const CB_ESCALATED_COOLDOWN_MS = 5 * 60_000;

/** 端点(域名硬编码, 稿 F8 §1 a 条) */
export const ENDPOINTS = [
  'https://lite.duckduckgo.com/lite/',
  'https://html.duckduckgo.com/html/',
] as const;

/** UA: 常规桌面浏览器(不伪装爬虫/不伪装其他厂商, 稿 F2 §4) */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** snippet/title/url 截断上限(稿 F8 §2) */
export const MAX_TITLE = 200;
export const MAX_URL = 512;
export const MAX_SNIPPET = 300;

/** count clamp(F1 §1 默认 5, 硬上限 10) */
export const DEFAULT_COUNT = 5;
export const MAX_COUNT = 10;

// ─────────────────────────────── 纯函数: 解析 ───────────────────────────────

/**
 * HTML 实体解码 — 手写 6 码(零依赖, 稿 F2 §3; 不引 he/entities)。
 * &amp; &lt; &gt; &quot; &#39; &nbsp;
 * (顺序纪律: &amp; 最后替换会被先替换的产物污染? 不会 —
 *  6 码互不包含对方字面值, 替换顺序无副作用。)
 */
export function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

const TAG_RE = /<[^>]+>/g;

function stripTags(s: string): string {
  return decodeEntities(s.replace(TAG_RE, '')).replace(/\s+/g, ' ').trim();
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '…';
}

/** 锚命中(带位置, 供与 snippet 按序配对) */
interface AnchorHit {
  url: string;
  title: string;
  at: number;
}
interface SnippetHit {
  text: string;
  at: number;
}

/**
 * 2 套 pattern(容错三保险 (a) 多 pattern 备胎)。
 * 显式定义每组捕获组序号(禁靠"猜 m[i]" — 组错位是解析器头号 bug 源):
 *   primary: lite/html 稳态标记 class="result-link" / class="result-snippet"
 *   loose  : 放宽为 result_ 下划线族(html 站 result__a / result__snippet 兼容);
 *            URL 只认绝对 http(s) 协议, 内网 file:// 等直接拒
 */
interface PatternSet {
  link: RegExp;
  /** link 正则里 url / title 块的起始捕获组(1-based) */
  linkUrlGroup: number;
  linkTitleGroup: number;
  snippet: RegExp;
  sniffGroup: number; // snippet 正则里文本的捕获组
}

const LINK_PRIMARY =
  /<a[^>]*class="[^"]*result[-_]link[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
const SNIPPET_PRIMARY =
  /<(?:td|div|a|span)[^>]*class="[^"]*result[-_]snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:td|div|a|span)>/g;

const LINK_LOOSE =
  /<a[^>]*class="[^"]*result[^"]*_[^"]*[^"]*"[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
const SNIPPET_LOOSE =
  /<(?:td|div|a|span)[^>]*class="[^"]*result[^"]*_[^"]*[^"]*"[^>]*>([\s\S]*?)<\/(?:td|div|a|span)>/g;

const SETS: PatternSet[] = [
  { link: LINK_PRIMARY, linkUrlGroup: 1, linkTitleGroup: 2, snippet: SNIPPET_PRIMARY, sniffGroup: 1 },
  { link: LINK_LOOSE, linkUrlGroup: 1, linkTitleGroup: 2, snippet: SNIPPET_LOOSE, sniffGroup: 1 },
];

function collectWith(rx: RegExp, html: string, pick: (m: RegExpExecArray, at: number) => void): void {
  let m: RegExpExecArray | null;
  let lastAt = -1;
  while ((m = rx.exec(html)) !== null) {
    const at = m.index;
    if (at === lastAt) { rx.lastIndex = at + 1; continue; } // 零宽自锁防护
    lastAt = at;
    pick(m, at);
  }
}

function runPatternSet(set: PatternSet, html: string): { anchors: AnchorHit[]; snippets: SnippetHit[] } {
  const anchors: AnchorHit[] = [];
  collectWith(set.link, html, (m, at) => {
    const rawUrl = decodeEntities((m[set.linkUrlGroup] ?? '').trim());
    const titleBlock = m[set.linkTitleGroup] ?? m[0] ?? '';
    anchors.push({ url: rawUrl, title: stripTags(titleBlock), at });
  });
  const snippets: SnippetHit[] = [];
  collectWith(set.snippet, html, (m, at) => {
    snippets.push({ text: stripTags(m[set.sniffGroup] ?? ''), at });
  });
  return { anchors, snippets };
}

/**
 * 解析(容错三保险 (a)(b)):
 *  — 依次双 pattern(任一集命中 ≥1 锚即收, 全零 → 返回 [] → 上层切端点 (c));
 *  — 锚按文档序排序, snippet 按"紧随锚之后且早于下一锚"归属(1:1 配对;
 *    lite 端点结构即 link/snippet 相邻 <td>); 数量不齐 → 未配对的 snippet 填空串。
 *  — title+url 缺一即弃; url 非绝对 http(s) 即弃(稿 F2 §3-b); snippet 缺失保留空串。
 *
 * 导出供单测直测(稿 F7 §2)。
 */
export function parseLiteHtml(html: string): Array<{ url: string; title: string; snippet: string }> {
  for (const set of SETS) {
    const { anchors, snippets } = runPatternSet(set, html);
    if (anchors.length === 0) continue;

    const sorted = [...anchors].sort((a, b) => a.at - b.at);
    const out: Array<{ url: string; title: string; snippet: string }> = [];
    for (let i = 0; i < sorted.length; i++) {
      const a = sorted[i];
      if (!a.url || !a.title) continue; // (b) 关键字段缺失 → 弃
      if (!/^https?:\/\//i.test(a.url)) continue; // (b) 非绝对 http(s) → 弃
      const nextAt = i + 1 < sorted.length ? sorted[i + 1].at : Infinity;
      // 归属: 紧随其后、早于下一锚的最近 snippet
      let best: SnippetHit | null = null;
      for (const s of snippets) {
        if (s.at > a.at && s.at < nextAt) {
          if (best === null || s.at < best.at) best = s;
        }
      }
      out.push({ url: a.url, title: a.title, snippet: best ? best.text : '' });
    }
    if (out.length > 0) return out;
  }
  return [];
}

function toResults(
  parsed: Array<{ url: string; title: string; snippet: string }>,
  provider: string,
): SearchResult[] {
  const now = Date.now();
  return parsed.map((p) => ({
    title: truncate(p.title, MAX_TITLE),
    url: truncate(p.url, MAX_URL),
    snippet: truncate(p.snippet, MAX_SNIPPET),
    provider,
    fetchedAt: now,
  }));
}

// ─────────────────────────────────── Provider ───────────────────────────────────

export class DuckDuckGoHtmlProvider implements SearchProvider {
  readonly id = 'duckduckgo-html';
  readonly label = 'DuckDuckGo HTML';
  readonly requiresKey = false;

  private cooldown: { until: number; consecutive429: number } = { until: 0, consecutive429: 0 };

  /** 单飞行: 同归一 query 的在途请求复用(F2 §5 单飞行) */
  private inFlight = new Map<string, Promise<SearchResult[]>>();

  /** E2E 固定 stub(F7 §1; 断言面: url/title 字面值稳定可校验) */
  static readonly STUB_RESULTS: SearchResult[] = [
    {
      title: '[e2e stub] result 1',
      url: 'https://example.com/stub/1',
      snippet: 'stub result 1',
      provider: 'duckduckgo-html',
      fetchedAt: 0,
    },
    {
      title: '[e2e stub] result 2',
      url: 'https://example.com/stub/2',
      snippet: 'stub result 2',
      provider: 'duckduckgo-html',
      fetchedAt: 0,
    },
  ];

  static isE2eStubbed(): boolean {
    return process.env.PIPICLAW_E2E === '1';
  }

  /**
   * @param q 入参
   * @param fetchImpl DI 注入(F7 §2); 缺省 globalThis.fetch
   */
  async search(q: SearchQuery, fetchImpl?: typeof fetch): Promise<SearchResult[]> {
    // 第一行 stub(F7 §1)
    if (DuckDuckGoHtmlProvider.isE2eStubbed()) {
      return DuckDuckGoHtmlProvider.STUB_RESULTS;
    }

    const query = (q?.query ?? '').trim();
    if (!query) throw new SearchError('invalid-query', 'search query 为空');

    if (Date.now() < this.cooldown.until) {
      throw new SearchError('rate-limited', 'provider cooldown');
    }

    const count = clampCount(q.count);
    const fetcher = fetchImpl ?? globalThis.fetch;
    const key = keyFor(query);

    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const job = this
      .doSearch(query, count, q.signal, fetcher, q.locale)
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, job);
    return job;
  }

  private async doSearch(
    query: string,
    count: number,
    signal: AbortSignal | undefined,
    fetcher: typeof fetch,
    locale?: string,
  ): Promise<SearchResult[]> {
    // 端点降级链(容错三保险 (c): 全零 → 切第二端点重试 1 次)
    for (const url of ENDPOINTS) {
      const headers: Record<string, string> = {
        'User-Agent': UA,
        'Content-Type': 'application/x-www-form-urlencoded',
      };
      if (locale) headers['Accept-Language'] = locale;

      let res: Response;
      try {
        res = await fetcher(url, { method: 'POST', body: `q=${encodeURIComponent(query)}`, headers, signal });
      } catch (e) {
        if ((e as { name?: string })?.name === 'AbortError') {
          throw new SearchError('timeout', 'search timeout');
        }
        throw new SearchError('network', `fetch 失败: ${(e as Error)?.message ?? String(e)}`);
      }

      if (res.status === 429) {
        this.onRateLimited();
        throw new SearchError('rate-limited', 'HTTP 429');
      }
      if (!res.ok) {
        throw new SearchError('network', `HTTP ${res.status} ${res.statusText ?? ''}`.trim());
      }

      const parsed = parseLiteHtml(await res.text());
      if (parsed.length > 0) {
        // 成功: 熔断计数清零(稿 F2 §5)
        this.cooldown = { until: 0, consecutive429: 0 };
        return toResults(parsed, this.id).slice(0, count);
      }
      // 全零 → 继续 for(切端点)
    }
    throw new SearchError('parse-empty', 'DDG 两端点全零命中(结构漂移或查询无结果)');
  }

  private onRateLimited(): void {
    this.cooldown.consecutive429 += 1;
    const ms = this.cooldown.consecutive429 >= 2 ? CB_ESCALATED_COOLDOWN_MS : CB_BASE_COOLDOWN_MS;
    this.cooldown.until = Date.now() + ms;
  }
}

function clampCount(c?: number): number {
  if (typeof c !== 'number' || !Number.isFinite(c)) return DEFAULT_COUNT;
  const n = Math.floor(c);
  if (n < 1) return 1;
  if (n > MAX_COUNT) return MAX_COUNT;
  return n;
}

function keyFor(query: string): string {
  return query.trim().replace(/\s+/g, ' ').toLowerCase();
}
