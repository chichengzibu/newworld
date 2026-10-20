/**
 * NOVA #004-B · M3 联网搜索 · barrel(第①笔)
 * 导出面: types / SearchCache / SearchRegistry / DuckDuckGoHtmlProvider
 * 注: 不导出 SearchError 以外的内部常量之外的私有实现。
 */
export {
  type SearchQuery,
  type SearchResult,
  type SearchProvider,
  type SearchErrorCode,
  SearchError,
} from './types';
export { SearchCache } from './SearchCache';
export { SearchRegistry } from './SearchRegistry';
export {
  DuckDuckGoHtmlProvider,
  parseLiteHtml,
  decodeEntities,
  ENDPOINTS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_COUNT,
  MAX_COUNT,
  MAX_TITLE,
  MAX_URL,
  MAX_SNIPPET,
} from './providers/duckduckgo-html';
