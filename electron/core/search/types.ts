/**
 * NOVA #004-B · M3 联网搜索 · 类型契约（第①笔）
 *
 * 设计稿: docs/NOVA-#004-M3-search-provider-design.md §F1 (F8 截断上限)
 * 零 electron import / 零新依赖 — 可被 node 单测直测。
 *
 * 安全边界锚定(稿 F8):
 *   - 结果字段全部由 provider 侧截断(title 200 / url 512 / snippet 300),
 *     不可信外部内容在离开解析层前完成截断。
 *   - requiresKey 为 key 型 Provider(Bing/Serper/Tavily, 未实施)预留位,
 *     MVP 恒 false; 密钥永远不进入 SearchResult。
 *
 * 勘误补记(#004-B G3 抽验):
 *   `ModelProvider` 符号实存于两处但均**非 class**:
 *     - electron/models/ModelProvider.ts = 类型定义模块(ProviderConfig/PROVIDER_DEFAULTS 等, 121 行)
 *     - electron/types/models.d.ts:8 = `type ModelProvider = 'openai' | ...` 字符串字面量联合
 *   本稿 F1 注册表对标口径 = getInstance 单例家族(G4 实证 electron 域 100+ 处), 不变;
 *   "类不存在"表述精确化为"无同名 class", 落点 core/search/ 不变。
 */

/** 搜索入参（draft F1 §1） */
export interface SearchQuery {
  /** 必填; provider 侧 trim 后非空校验 */
  query: string;
  /** 默认 5, 硬上限 10(provider 内 clamp) */
  count?: number;
  /** 'zh-CN' | 'en-US' | ...; MVP 可留空 = 自动 */
  locale?: string;
  /** 超时/取消; 缺省由 provider 侧默认 8000ms AbortController(稿 F5) */
  signal?: AbortSignal;
}

/** 单条结果（schema 定稿; 字段全部已在 provider 侧截断） */
export interface SearchResult {
  /** ≤ 200 char */
  title: string;
  /** https 绝对 URL; ≤ 512 char */
  url: string;
  /** ≤ 300 char(不可信外部内容标注由消费侧负责, 稿 F4) */
  snippet: string;
  /** = provider.id, 如 'duckduckgo-html' */
  provider: string;
  /** Date.now() 毫秒; stub 结果为 0 */
  fetchedAt: number;
}

/** provider 失败语义(不静默; UI 按 code 三态文案, 稿 F5) */
export type SearchErrorCode =
  | 'network'        // fetch 拒绝 / 非 2xx(429 除外)
  | 'rate-limited'   // 429 / 熔断冷却期内
  | 'parse-empty'    // 两端点全零命中
  | 'timeout'        // AbortSignal 到点
  | 'invalid-query'  // query trim 后为空
  | 'e2e-stub';      // 仅诊断用: PIPICLAW_E2E stub 路径(正常是返回固定结果而非抛此码, 保留此枚举供断言)

export class SearchError extends Error {
  readonly code: SearchErrorCode;
  constructor(code: SearchErrorCode, message: string) {
    super(message);
    this.name = 'SearchError';
    this.code = code;
  }
}

/**
 * Provider 接口（对齐 draft F1; 注册表走 getInstance 单例家族 —
 * 勘误口径: 对标既有 getInstance 家族, 非某具名类; G3 补记:
 * electron/models/ModelProvider.ts 为类型定义模块(非 class), 两域相异, 落点仍在 core/search/）
 */
export interface SearchProvider {
  readonly id: string;
  readonly label: string;
  /** key 型 Provider 预留位(未实施); MVP 恒 false */
  readonly requiresKey: boolean;

  /**
   * @param q 入参
   * @param fetchImpl DI 注入点(稿 F7 §2): 单测传 mock, 生产缺省 globalThis.fetch
   */
  search(q: SearchQuery, fetchImpl?: typeof fetch): Promise<SearchResult[]>;
}
