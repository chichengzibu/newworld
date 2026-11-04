/**
 * PiPiClaw - Hermes 分层持久化记忆架构
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
   * 检索相关记忆
   */
  public retrieveRelevantMemories(query: string, limit: number = 5): MemoryItem[] {
    // 简化版本：按重要性和时间排序
    const relevant = [...this.memories]
      .sort((a, b) => {
        const scoreA = (a.importance || 0) - (Date.now() - a.timestamp) / 86400000;
        const scoreB = (b.importance || 0) - (Date.now() - b.timestamp) / 86400000;
        return scoreB - scoreA;
      })
      .slice(0, limit);
    
    return relevant;
  }

  /**
   * 构建记忆提示词
   */
  public buildMemoryPrompt(query: string): string {
    const coreMemory = this.getCoreMemory();
    const relevant = this.retrieveRelevantMemories(query);
    
    let prompt = '';
    
    if (coreMemory.trim()) {
      prompt += `## 用户核心记忆\n${coreMemory}\n\n`;
    }
    
    if (relevant.length > 0) {
      prompt += `## 相关历史记忆\n`;
      relevant.forEach((item, idx) => {
        prompt += `${idx + 1}. ${item.content}\n`;
      });
      prompt += '\n';
    }
    
    return prompt;
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