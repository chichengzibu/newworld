/**
 * NOVA #004-B · M3 联网搜索 · Provider 注册表（第①笔）
 *
 * 设计稿:  §F1 §3
 *   对标 getInstance 单例家族（G4 实证 electron 域 100+ 处:
 *   electron/core/ConfigStore.ts:40 / GlobalShortcut.ts:33 / IpcServer.ts:76 等）。
 *   勘误口径(G3): 无同名 class ModelProvider —— electron/models/ModelProvider.ts 为
 *   类型定义模块, electron/types/models.d.ts:8 为字符串字面量联合 type, 两域相异。
 *
 * 零 electron import / 零新依赖。
 */
import type { SearchProvider } from './types';

export class SearchRegistry {
  private static instance: SearchRegistry;

  private providers = new Map<string, SearchProvider>();
  private defaultId: string | null = null;
  /** 首个注册的 provider 作为 default(F10 验收 devtools 冒烟依赖 default()) */
  private firstId: string | null = null;

  private constructor() {}

  static getInstance(): SearchRegistry {
    if (!SearchRegistry.instance) SearchRegistry.instance = new SearchRegistry();
    return SearchRegistry.instance;
  }

  /** 注册(同 id 后注册者覆盖前者的实现; default 指针若指向该 id 则跟随新实现) */
  register(p: SearchProvider): void {
    if (this.firstId === null) this.firstId = p.id;
    this.providers.set(p.id, p);
    if (this.defaultId === null) this.defaultId = p.id;
  }

  list(): SearchProvider[] {
    return [...this.providers.values()];
  }

  get(id: string): SearchProvider | null {
    return this.providers.get(id) ?? null;
  }

  /** 默认 provider = 未显式指定时首个注册者; 空注册表 → null(调用方自决降级) */
  default(): SearchProvider | null {
    if (this.defaultId !== null && this.providers.has(this.defaultId)) {
      return this.providers.get(this.defaultId)!;
    }
    return this.firstId && this.providers.has(this.firstId)
      ? this.providers.get(this.firstId)!
      : null;
  }

  /** 测试/维护 seam: 测试隔离用(单测池 isolate=true 天然按文件隔离, 此为文件内多例复用 seam) */
  static resetForTest(): void {
    SearchRegistry.instance = new SearchRegistry();
  }
}
