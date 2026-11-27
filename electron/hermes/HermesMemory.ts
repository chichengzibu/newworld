/**
 * New World - Hermes 分层持久化记忆架构
 */

import * as fs from 'fs';
import { getHost } from '../platform/runtime'
import * as path from 'path';

import { LogManager } from '../core/LogManager';
import { ConfigStore } from '../core/ConfigStore';

export interface MemoryItem {
  id: string;
  type: 'core' | 'experience' | 'conversation';
  content: string;
  timestamp: number;
  tags?: string[];
  importance?: number; // 0-100
}

/**
 * 轻量分词：中文按 2-gram 切、拉丁按词切，全部小写。
 *
 * 【为什么不用完整分词器】文本层排序是兜底，不是主力检索；
 * 引入分词库要为这一个用途增加依赖与启动开销，不值得。
 * 2-gram 对中文的召回效果已经足够（"文件整理" → 文件/件整/整理）。
 */
function tokenizeForScore(text: string): string[] {
  const s = (text ?? '').toLowerCase().trim();
  if (!s) return [];
  const out = new Set<string>();
  // 拉丁词
  for (const w of s.match(/[a-z0-9_]{2,}/g) ?? []) out.add(w);
  // 中文 2-gram（连续 CJK 段内滑动）
  for (const seg of s.match(/[\u4e00-\u9fa5]{2,}/g) ?? []) {
    for (let i = 0; i + 2 <= seg.length; i++) out.add(seg.slice(i, i + 2));
  }
  return [...out];
}

/** 剥掉文件开头的 `# 标题` 行（避免 prompt 里出现两层标题） */
function stripMarkdownTitle(text: string): string {
  const lines = (text ?? '').split('\n');
  let i = 0;
  while (i < lines.length && (lines[i].trim() === '' || /^#\s/.test(lines[i].trim()))) i += 1;
  return lines.slice(i).join('\n');
}

export class HermesMemory {
  private static instance: HermesMemory;
  private log = LogManager.getInstance();
  private configStore = ConfigStore.getInstance();
  private memoryDir: string;
  private coreMemoryPath: string;
  private experienceMemoryPath: string;
  private memories: MemoryItem[] = [];

  private constructor() {
    // 初始化记忆目录
    this.memoryDir = path.join(getHost().getPath('userData'), 'hermes-memory');
    this.coreMemoryPath = path.join(this.memoryDir, 'USER.md');
    this.experienceMemoryPath = path.join(this.memoryDir, 'MEMORY.md');
    
    this.ensureMemoryDir();
    this.loadMemories();
  }

  public static getInstance(): HermesMemory {
    if (!HermesMemory.instance) {
      HermesMemory.instance = new HermesMemory();
    }
    return HermesMemory.instance;
  }

  private ensureMemoryDir(): void {
    if (!fs.existsSync(this.memoryDir)) {
      fs.mkdirSync(this.memoryDir, { recursive: true });
    }
    
    // 初始化默认记忆文件
    if (!fs.existsSync(this.coreMemoryPath)) {
      fs.writeFileSync(this.coreMemoryPath, '# 用户核心记忆\n\n', 'utf-8');
    }
    if (!fs.existsSync(this.experienceMemoryPath)) {
      fs.writeFileSync(this.experienceMemoryPath, '# 经验记忆\n\n', 'utf-8');
    }
  }

  private loadMemories(): void {
    try {
      // 从配置存储加载记忆索引
      const saved = this.configStore.get('hermes.memories') as MemoryItem[];
      if (saved) {
        this.memories = saved;
      }
      this.log.info('[HermesMemory] 记忆加载成功', { count: this.memories.length });
    } catch (error) {
      this.log.error('[HermesMemory] 记忆加载失败', error);
    }
  }

  private saveMemories(): void {
    try {
      this.configStore.set('hermes.memories', this.memories);
    } catch (error) {
      this.log.error('[HermesMemory] 记忆保存失败', error);
    }
  }

  /**
   * 获取核心记忆（USER.md）
   */
  public getCoreMemory(): string {
    try {
      return fs.readFileSync(this.coreMemoryPath, 'utf-8');
    } catch (error) {
      this.log.error('[HermesMemory] 读取核心记忆失败', error);
      return '';
    }
  }

  /**
   * 更新核心记忆
   */
  public updateCoreMemory(content: string): void {
    try {
      fs.writeFileSync(this.coreMemoryPath, content, 'utf-8');
      this.log.info('[HermesMemory] 核心记忆已更新');
    } catch (error) {
      this.log.error('[HermesMemory] 更新核心记忆失败', error);
    }
  }

  /**
   * 获取经验记忆（MEMORY.md）
   */
  public getExperienceMemory(): string {
    try {
      return fs.readFileSync(this.experienceMemoryPath, 'utf-8');
    } catch (error) {
      this.log.error('[HermesMemory] 读取经验记忆失败', error);
      return '';
    }
  }

  /**
   * 添加经验记忆
   */
  /**
   * 追加一条经验记忆。
   *
   * 【M4-I】两处改动:
   *
   * ① **接受可选的 id**,并以它为准(不再总是自己生成)。
   *    为什么:调用方给的 id 不是随便的 —— ChatManager 用的是
   *    `chat-<sha256(conversationId|content)>`,即 #006.5 W1 定的**幂等键**:
   *    「同 conversationId+content → 同 id → 覆盖,不重复」。
   *    而本方法此前**无视**调用方的 id、自己另生成一个 →
   *      - 记忆库里的 id ≠ 调用方的 id
   *      - 召回时候选来自记忆库(真实 id)→ 向量库里按调用方 id 建的条目查不到
   *        → **每次召回都重新嵌入一遍**,且留下一条永远匹配不上的**孤儿**
   *    现:调用方给了 id 就用它 → 记忆库与向量库同一个 id → 幂等与召回同时成立。
   *
   * ② **返回创建的条目**(此前返回 void)。调用方据此拿到真实 id,
   *    写向量库时用同一个 id。
   *
   * 【兼容性】id 与返回值都是可选的 —— 既有用法(`addExperienceMemory(content, tags)`)
   * 行为完全不变:仍然自生成 id、仍然返回条目(忽略返回值即可)。
   */
  public addExperienceMemory(content: string, tags?: string[], id?: string): MemoryItem {
    // 幂等:同一 id 已存在 → 不重复追加,返回既有条目
    if (id) {
      const existing = this.memories.find(m => m.id === id);
      if (existing) {
        this.log.info('[HermesMemory] 经验记忆已存在(幂等),跳过重复追加', { id });
        return existing;
      }
    }

    const item: MemoryItem = {
      id: id ?? `mem_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      type: 'experience',
      content,
      timestamp: Date.now(),
      tags,
      importance: 50
    };

    this.memories.push(item);
    this.saveMemories();

    // 追加到经验记忆文件
    try {
      const entry = `## ${new Date().toLocaleString('zh-CN')}\n\n${content}\n\n`;
      fs.appendFileSync(this.experienceMemoryPath, entry, 'utf-8');
    } catch (error) {
      this.log.error('[HermesMemory] 追加经验记忆失败', error);
    }

    this.log.info('[HermesMemory] 经验记忆已添加', item);
    return item;
  }

  /**
   * 添加对话记忆
   */
  public addConversationMemory(conversationId: string, content: string, importance: number = 30): void {
    const item: MemoryItem = {
      id: `conv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      type: 'conversation',
      content,
      timestamp: Date.now(),
      tags: [conversationId],
      importance
    };
    
    this.memories.push(item);
    this.saveMemories();
    this.log.info('[HermesMemory] 对话记忆已添加', item);
  }

  /**
   * 按 id 取一条记忆（供向量层回填 content 用）。
   *
   * 【为什么需要】MemoryVectorStore 持久化只存 id/vector/norm，重启后
   * entry.memory.content 是空串 —— 纯向量召回会返回 `- ` 这种空条目。
   * 本方法让上层能按 id 从文本真源拿回正文。
   */
  public getById(id: string): MemoryItem | undefined {
    return this.memories.find((m) => m.id === id);
  }

  /** 批量按 id 取（一次遍历，避免 N 次 find） */
  public getByIds(ids: readonly string[]): Map<string, MemoryItem> {
    const want = new Set(ids);
    const out = new Map<string, MemoryItem>();
    for (const m of this.memories) {
      if (want.has(m.id)) out.set(m.id, m);
    }
    return out;
  }

  /**
   * 检索相关记忆。
   *
   * 【M4.9 修：query 此前被完全忽略】
   * 旧实现只有 `importance - 天数` 排序，query 参数根本没用到 ——
   * 换句话说无论用户问什么，都返回同一批"最重要的旧记忆"。
   * 现改为「词面相关度 + 重要性 + 时间衰减」三因子加权，query 真正参与排序
   * （真正的语义排序在 HermesAdapter 的向量路，这里是文本层的兜底排序）。
   */
  public retrieveRelevantMemories(query: string, limit: number = 5): MemoryItem[] {
    const q = (query ?? '').trim();
    const terms = tokenizeForScore(q);
    const now = Date.now();

    const scored = this.memories.map((m) => {
      // 词面相关度：命中 term 数 / term 总数（无 term 时给中性值 0.5，不干扰排序）
      let lexical = 0.5;
      if (terms.length > 0) {
        const text = m.content.toLowerCase();
        let hit = 0;
        for (const t of terms) if (text.includes(t)) hit += 1;
        lexical = hit / terms.length;
      }
      // 重要性归一（0-100 → 0-1）
      const importance = Math.max(0, Math.min(100, m.importance ?? 30)) / 100;
      // 时间衰减：半衰期 30 天，越新越高（0-1）
      const ageDays = Math.max(0, (now - m.timestamp) / 86400000);
      const recency = 1 / (1 + ageDays / 30);
      // 权重：词面 0.5 / 重要性 0.3 / 时间 0.2 —— 相关度优先，但不让最新一条碾压
      return { item: m, score: lexical * 0.5 + importance * 0.3 + recency * 0.2 };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((s) => s.item);
  }

  /**
   * 构建记忆提示词
   *
   * 【M4.9】加入经验快照段（此前 MEMORY.md 只写不读，对 prompt 完全无效）。
   * 现在按「核心记忆全文 → 经验快照（截断）→ 按 query 相关的历史记忆」三段拼装，
   * 并对总长度做预算控制，避免把 prompt 撑爆。
   */
  public buildMemoryPrompt(query: string, opts?: { maxChars?: number }): string {
    const budget = opts?.maxChars ?? 4000;
    const coreMemory = this.getCoreMemory();
    const experience = this.getExperienceMemory();
    const relevant = this.retrieveRelevantMemories(query);

    let prompt = '';

    if (coreMemory.trim()) {
      prompt += `## 用户核心记忆\n${coreMemory.trim()}\n\n`;
    }

    // 经验快照：只取尾部（最新的在后面），且不超过总预算的 40%
    const expBody = stripMarkdownTitle(experience).trim();
    if (expBody) {
      const cap = Math.floor(budget * 0.4);
      const clipped = expBody.length > cap ? `…（更早的已省略）\n${expBody.slice(-cap)}` : expBody;
      prompt += `## 经验记忆快照\n${clipped}\n\n`;
    }

    if (relevant.length > 0) {
      prompt += `## 相关历史记忆\n`;
      relevant.forEach((item, idx) => {
        prompt += `${idx + 1}. ${item.content}\n`;
      });
      prompt += '\n';
    }

    // 总预算兜底：保留尾部（相关记忆更重要），截掉头部冗余
    if (prompt.length > budget) {
      prompt = `…（更早内容已省略）\n${prompt.slice(-budget)}`;
    }

    return prompt;
  }

  /**
   * 压缩重写 MEMORY.md —— 把「只增不减的追加日志」重写成一份紧凑快照。
   *
   * 【为什么需要】旧实现是 appendFileSync 无限追加，几个月后 MEMORY.md
   * 会变成几 MB 的时间戳流水账，既读不进 prompt 也无法人工阅读。
   * 本方法把 experience 层记忆按「重要性降序 + 时间降序」重写成一份去重快照。
   *
   * @param opts.maxEntries 快照最多保留多少条（默认 100）
   * @param opts.minImportance 低于该重要性的条目不进快照（默认 20）
   * @returns 重写前后的条目数
   */
  public compactExperience(opts?: { maxEntries?: number; minImportance?: number }): {
    before: number;
    after: number;
  } {
    const maxEntries = opts?.maxEntries ?? 100;
    const minImportance = opts?.minImportance ?? 20;

    const expItems = this.memories.filter((m) => m.type === 'experience');
    const before = expItems.length;

    // 去重（同内容只留最新一条）+ 过滤低价值 + 排序
    const seen = new Set<string>();
    const kept = expItems
      .filter((m) => (m.importance ?? 50) >= minImportance)
      .sort((a, b) => {
        const byImp = (b.importance ?? 50) - (a.importance ?? 50);
        return byImp !== 0 ? byImp : b.timestamp - a.timestamp;
      })
      .filter((m) => {
        const key = m.content.trim();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, maxEntries)
      // 快照按时间正序展示，读起来像日志
      .sort((a, b) => a.timestamp - b.timestamp);

    const lines = ['# 经验记忆', ''];
    for (const m of kept) {
      lines.push(`## ${new Date(m.timestamp).toLocaleString('zh-CN')}`);
      lines.push('');
      lines.push(m.content.trim());
      lines.push('');
    }
    if (before > kept.length) {
      lines.push(`> 共压缩 ${before} 条经验，保留 ${kept.length} 条高价值条目。`);
      lines.push('');
    }

    try {
      fs.writeFileSync(this.experienceMemoryPath, lines.join('\n'), 'utf-8');
      this.log.info('[HermesMemory] 经验快照已压缩重写', { before, after: kept.length });
    } catch (error) {
      this.log.error('[HermesMemory] 压缩经验快照失败', error);
    }

    return { before, after: kept.length };
  }

  /**
   * 记忆层级晋升 —— conversation → experience → core。
   *
   * 【语义】层级目前只是标签，没有任何流转（对话记忆永远是对话记忆）。
   * 本方法按「被重复提及次数 + 重要性」判定是否值得晋升：
   *   · 对话记忆 importance ≥ 70 且内容不重复 → 晋升为 experience
   *   · experience importance ≥ 90 且被晋升过 ≥2 次同类主题 → 不自动进 core（core 是用户画像，必须人工/LLM 归纳）
   * 返回实际晋升条数。
   */
  public promoteMemories(opts?: { conversationToExperience?: number; experienceToCore?: number }): {
    promoted: number;
  } {
    const convThreshold = opts?.conversationToExperience ?? 70;
    const expThreshold = opts?.experienceToCore ?? 90;
    let promoted = 0;

    // conversation → experience
    for (const m of this.memories) {
      if (m.type === 'conversation' && (m.importance ?? 0) >= convThreshold) {
        m.type = 'experience';
        m.tags = [...(m.tags ?? []), 'promoted'];
        promoted += 1;
      }
    }

    // experience → core（不自动写 USER.md，只标记，避免污染用户画像）
    for (const m of this.memories) {
      if (m.type === 'experience' && (m.importance ?? 0) >= expThreshold && !(m.tags ?? []).includes('core-candidate')) {
        m.tags = [...(m.tags ?? []), 'core-candidate'];
        promoted += 1;
      }
    }

    if (promoted > 0) {
      this.saveMemories();
      this.log.info('[HermesMemory] 记忆层级晋升完成', { promoted });
    }
    return { promoted };
  }

  /**
   * 按 id 删除记忆（供 curate 的遗忘策略使用）。
   */
  public removeByIds(ids: readonly string[]): number {
    const drop = new Set(ids);
    const before = this.memories.length;
    this.memories = this.memories.filter((m) => !drop.has(m.id));
    const removed = before - this.memories.length;
    if (removed > 0) this.saveMemories();
    return removed;
  }

  /**
   * 更新单条记忆（供技能产出反哺记忆时刷新内容/重要性）。
   */
  public updateMemory(id: string, patch: Partial<Pick<MemoryItem, 'content' | 'importance' | 'tags' | 'type'>>): boolean {
    const m = this.memories.find((x) => x.id === id);
    if (!m) return false;
    if (patch.content !== undefined) m.content = patch.content;
    if (patch.importance !== undefined) m.importance = patch.importance;
    if (patch.tags !== undefined) m.tags = patch.tags;
    if (patch.type !== undefined) m.type = patch.type;
    this.saveMemories();
    return true;
  }

  /**
   * 清空所有记忆
   */
  public clearAllMemories(): void {
    this.memories = [];
    this.saveMemories();
    
    // 重置记忆文件
    fs.writeFileSync(this.coreMemoryPath, '# 用户核心记忆\n\n', 'utf-8');
    fs.writeFileSync(this.experienceMemoryPath, '# 经验记忆\n\n', 'utf-8');
    
    this.log.info('[HermesMemory] 所有记忆已清空');
  }

  /**
   * 获取所有记忆
   */
  public getAllMemories(): MemoryItem[] {
    return [...this.memories];
  }
}