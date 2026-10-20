/**
 * NOVA #004-B · M3 联网搜索 · 内存 LRU 缓存 + 节流（第①笔）
 *
 * 设计稿: docs/NOVA-#004-M3-search-provider-design.md §F6
 *   - 容量 100 / TTL 300s / 同 query 节流 5s(防连点 + 频控自保)
 *   - 写策略: 成功入 LRU; 失败只为节流目的记录(不作为成功结果供给)
 *   - 落盘: 否(稿 F6 §2 结论) — 本类纯内存, 零依赖, 手写 Map(Map 插入序即 LRU 序)
 *
 * 可测性: now 时钟可注入(DI), 单测不依赖真实时间。
 */
import type { SearchErrorCode, SearchResult } from './types';

export interface CacheRecord {
  ok: boolean;
  /** ok=true 时在场 */
  results?: SearchResult[];
  /** ok=false 时在场(诊断用; 节流路径复用于 rethrow 语义) */
  error?: SearchErrorCode;
  recordedAt: number;
}

export interface SearchCacheOptions {
  capacity?: number;
  ttlMs?: number;
  throttleMs?: number;
  now?: () => number;
}

export class SearchCache {
  static readonly DEFAULT_CAPACITY = 100;
  static readonly DEFAULT_TTL_MS = 300_000;
  static readonly DEFAULT_THROTTLE_MS = 5_000;

  private capacity: number;
  private ttlMs: number;
  private throttleMs: number;
  private readonly now: () => number;
  /** key = normalize(query); Map 插入序 = LRU 序(最旧在前) */
  private records = new Map<string, CacheRecord>();

  constructor(opts: SearchCacheOptions = {}) {
    this.capacity = opts.capacity ?? SearchCache.DEFAULT_CAPACITY;
    this.ttlMs = opts.ttlMs ?? SearchCache.DEFAULT_TTL_MS;
    this.throttleMs = opts.throttleMs ?? SearchCache.DEFAULT_THROTTLE_MS;
    this.now = opts.now ?? (() => Date.now());
  }

  /** 缓存键归一: trim + 折叠空白 + lower(稿 F6 §1 key 口径) */
  static normalize(query: string): string {
    return query.trim().replace(/\s+/g, ' ').toLowerCase();
  }

  /** 读时判定: 成功且未过期 → 供给(同时刷新 LRU 序); 过期/未命中 → undefined */
  getSuccess(key: string): SearchResult[] | undefined {
    const rec = this.records.get(key);
    if (!rec || !rec.ok) return undefined;
    if (this.now() - rec.recordedAt >= this.ttlMs) {
      this.records.delete(key);
      return undefined;
    }
    // LRU 刷新: 删后重插(移到"最新"序)
    this.records.delete(key);
    this.records.set(key, rec);
    return rec.results;
  }

  /** 节流判定: 最近 throttlingMs 内有过任何尝试(无论成败) → true(稿 F6 §1) */
  isThrottled(key: string): boolean {
    const rec = this.records.get(key);
    return !!rec && this.now() - rec.recordedAt < this.throttleMs;
  }

  /** 节流路径取回最近一次失败错误码(用于 provider 侧 rethrow 语义), 无则 undefined */
  lastError(key: string): SearchErrorCode | undefined {
    const rec = this.records.get(key);
    if (!rec || rec.ok) return undefined;
    if (this.now() - rec.recordedAt >= this.throttleMs) return undefined;
    return rec.error;
  }

  /** 写入: 成功=入 LRU(可被 TTL 淘汰); 失败=只为节流(同 key 覆盖) */
  set(key: string, rec: Omit<CacheRecord, 'recordedAt'>): void {
    this.records.delete(key);
    this.records.set(key, { ...rec, recordedAt: this.now() });
    // 容量约束: 逐最旧(不区分成败, 保持 Map 序即最近使用序)
    while (this.records.size > this.capacity) {
      const oldest = this.records.keys().next().value;
      if (oldest === undefined) break;
      this.records.delete(oldest);
    }
  }

  /** 测试/维护 seam: 清空 */
  clear(): void {
    this.records.clear();
  }

  get size(): number {
    return this.records.size;
  }
}
