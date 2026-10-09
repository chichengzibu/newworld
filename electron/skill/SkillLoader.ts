/**
 * PiPiClaw - 技能加载器
 * 
 * 职责：
 * 1. 扫描 skills/ 目录下所有子文件夹
 * 2. 解析每个 skill.md 的技能信息
 * 3. 匹配用户消息，返回对应技能的完整指令
 * 4. 管理技能的启用/禁用状态
 * 5. 支持导入新技能
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getHost } from '../platform/runtime';
import { LogManager } from '../core/LogManager';
import { ConfigStore } from '../core/ConfigStore';
import { ModelManager } from '../models/ModelManager';
import { SelfLearner } from '../learning/SelfLearner';
import { SkillManager } from './SkillManager';

/**
 * 技能定义接口
 */
export interface SkillDefinition {
  id: string;
  name: string;
  description: string;
  triggerKeywords: string[];
  operationSteps: string[];
  fullInstructions: string;
}

/**
 * 技能状态接口
 */
export interface SkillState {
  id: string;
  name: string;
  description: string;
  triggerKeywords: string[];
  operationSteps: string[];
  fullInstructions: string;
  enabled: boolean;
  usageCount: number;
  successRate: number;
  fileSize: number;
}

export class SkillLoader {
  private static instance: SkillLoader;
  private log = LogManager.getInstance();
  private skillsDir: string;
  private skills: Map<string, SkillState> = new Map();
  private configStore: ConfigStore;
  private modelManager: ModelManager;
  private _selfLearner: SelfLearner | null = null;
  
  // 延迟加载 SelfLearner
  private get selfLearner(): SelfLearner {
    if (!this._selfLearner) {
      this._selfLearner = SelfLearner.getInstance();
    }
    return this._selfLearner;
  }

  private constructor() {
    this.configStore = ConfigStore.getInstance();
    this.modelManager = ModelManager.getInstance();
    
    // 延迟初始化 SelfLearner，避免循环依赖
    // this.selfLearner 现在只会在需要时才加载
    // this.selfLearner = SelfLearner.getInstance();
    
    // 使用 SkillManager.getSkillsDir() 作为路径单点(W7.0.4)
    this.skillsDir = SkillManager.getSkillsDir();
    
    // 如果用户数据目录下没有技能，尝试从项目根目录复制
    const projectSkillsDir = path.join(getHost().getAppPath(), '..', 'skills');
    if (fs.existsSync(projectSkillsDir) && !fs.existsSync(this.skillsDir)) {
      this.log.info('[SkillLoader] 发现项目技能目录，正在复制到用户数据目录', { 
        source: projectSkillsDir,
        dest: this.skillsDir
      });
      
      // 复制项目技能目录到用户数据目录
      this.copyDirectory(projectSkillsDir, this.skillsDir);
    }
    
    // 确保目录存在
    this.ensureSkillsDir();
    // 加载技能
    this.loadAllSkills();
  }

  public static getInstance(): SkillLoader {
    if (!SkillLoader.instance) {
      SkillLoader.instance = new SkillLoader();
    }
    return SkillLoader.instance;
  }

  private ensureSkillsDir(): void {
    if (!fs.existsSync(this.skillsDir)) {
      fs.mkdirSync(this.skillsDir, { recursive: true });
      this.log.info('[SkillLoader] 创建技能目录', { path: this.skillsDir });
    }
  }

  private copyDirectory(source: string, dest: string): void {
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true });
    }
    
    const entries = fs.readdirSync(source, { withFileTypes: true });
    
    for (const entry of entries) {
      const srcPath = path.join(source, entry.name);
      const destPath = path.join(dest, entry.name);
      
      if (entry.isDirectory()) {
        this.copyDirectory(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
    
    this.log.info('[SkillLoader] 目录复制完成', { source, dest });
  }

  private loadAllSkills(): void {
    this.log.info('[SkillLoader] 开始加载技能...', { path: this.skillsDir });
    
    try {
      const skillDirs = fs.readdirSync(this.skillsDir, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory())
        .map(dirent => dirent.name);

      this.log.info('[SkillLoader] 发现技能目录', { count: skillDirs.length });

      for (const skillDir of skillDirs) {
        this.loadSkill(skillDir);
      }

      this.log.info('[SkillLoader] 技能加载完成', { count: this.skills.size });
    } catch (error) {
      this.log.error('[SkillLoader] 加载技能失败', error);
    }
  }

  private loadSkill(skillDir: string): void {
    const skillPath = path.join(this.skillsDir, skillDir);
    const skillMdPath = path.join(skillPath, 'skill.md');

    if (!fs.existsSync(skillMdPath)) {
      this.log.warn('[SkillLoader] 技能文件不存在', { skillDir, path: skillMdPath });
      return;
    }

    try {
      const content = fs.readFileSync(skillMdPath, 'utf-8');
      const fileSize = Buffer.byteLength(content, 'utf-8');
      const skill = this.parseSkillMd(skillDir, content);
      
      if (skill) {
        // 从配置中读取状态
        const skillStates = this.configStore.get('skills.states') as Record<string, any> || {};
        const savedState = skillStates[skill.id] || {};
        
        this.skills.set(skill.id, {
          ...skill,
          enabled: savedState.enabled !== false, // 默认启用
          usageCount: savedState.usageCount || 0,
          successRate: savedState.successRate || 100,
          fileSize
        });
        
        this.log.info('[SkillLoader] 加载技能成功', { id: skill.id, name: skill.name, fileSize });
      }
    } catch (error) {
      this.log.error('[SkillLoader] 解析技能失败', { skillDir, error });
    }
  }

  /**
   * 解析技能 Markdown——双格式兼容：
   * 1) PiPiClaw 原生：# 名称 / ## 描述 / ## 触发关键词 / ## 操作步骤（中文无 frontmatter）
   * 2) OpenClaw / Claude Code 风：YAML frontmatter(name/description) + ## Triggers / ## Steps
   */
  private parseSkillMd(skillId: string, content: string): SkillDefinition | null {
    try {
      const fm = this.parseFrontmatter(content);
      let body = content;
      let name = skillId;
      let description = '';
      const triggerKeywords: string[] = [];
      const operationSteps: string[] = [];

      if (fm) {
        name = fm.name || skillId;
        description = fm.description || '';
        body = fm.body;
      }

      const lines = body.split('\n');
      let currentSection = '';

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        const lower = line.toLowerCase();

        if (line.startsWith('# ')) {
          if (!fm) name = line.substring(2).trim();
          continue;
        }

        if (line.startsWith('##')) {
          if (lower.includes('描述') || lower.includes('description')) {
            currentSection = 'description';
          } else if (lower.includes('触发') || lower.includes('trigger')) {
            currentSection = 'keywords';
          } else if (
            lower.includes('步骤') || lower.includes('step') ||
            lower.includes('操作') || lower.includes('instruction') || lower.includes('指令')
          ) {
            currentSection = 'steps';
          }
          continue;
        }

        if (line && !line.startsWith('#')) {
          if (currentSection === 'description' && line) {
            description += (description ? '\n' : '') + line;
          } else if (currentSection === 'keywords') {
            const keyword = line.replace(/^[-*]\s*/, '').trim();
            if (keyword) triggerKeywords.push(keyword);
          } else if (currentSection === 'steps') {
            const step = line.replace(/^\d+\.\s*/, '').replace(/^[-*]\s*/, '').trim();
            if (step) operationSteps.push(step);
          }
        }
      }

      if (triggerKeywords.length === 0) {
        this.log.warn('[SkillLoader] 技能缺少触发关键词', { skillId });
      }

      const fullInstructions = this.generateFullInstructions(name, description, operationSteps);

      return {
        id: skillId,
        name,
        description: description || name,
        triggerKeywords,
        operationSteps,
        fullInstructions
      };
    } catch (error) {
      this.log.error('[SkillLoader] 解析 skill.md 失败', { skillId, error });
      return null;
    }
  }

  /**
   * 解析 YAML frontmatter（OpenClaw / Claude Code 风格）
   * 形如：
   * ---
   * name: foo
   * description: bar
   * ---
   */
  private parseFrontmatter(content: string): { name?: string; description?: string; body: string } | null {
    const m = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
    if (!m) return null;

    const fmText = m[1];
    const body = m[2];
    const result: { name?: string; description?: string } = {};

    const nameMatch = fmText.match(/^name:\s*(.+)$/m);
    if (nameMatch) result.name = nameMatch[1].trim().replace(/^['"]|['"]$/g, '');

    const descMatch = fmText.match(/^description:\s*([\s\S]+?)(?:\n[a-zA-Z_-]+:|$)/m);
    if (descMatch) result.description = descMatch[1].trim().replace(/^['"]|['"]$/g, '');

    return { name: result.name, description: result.description, body };
  }

  /**
   * 在解压/解包后的目录里查找技能文档（兼容 skill.md / SKILL.md，大小写不敏感，深度 3 层内）
   */
  private findSkillDoc(rootDir: string): string | null {
    const candidates: string[] = [];

    const walk = (dir: string, depth: number) => {
      if (depth > 3) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          walk(full, depth + 1);
        } else if (/^skill\.md$/i.test(e.name)) {
          candidates.push(full);
        }
      }
    };

    walk(rootDir, 0);
    if (candidates.length === 0) return null;

    // 优先最浅层（根目录 > 子目录），同名时取首个
    candidates.sort((a, b) => a.split(path.sep).length - b.split(path.sep).length);
    return candidates[0];
  }

  /**
   * 由技能文档路径推导技能ID（用所在文件夹名或文件名，保证可读且唯一）
   */
  private resolveSkillId(skillDocPath: string): string {
    const parentBase = path.basename(path.dirname(skillDocPath));
    const base =
      parentBase && parentBase !== '.' && parentBase.toLowerCase() !== 'skills' && parentBase !== path.basename(this.skillsDir)
        ? parentBase
        : path.basename(skillDocPath, path.extname(skillDocPath));
    const safe = base.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase() || 'skill';
    return `imported_${safe}_${Date.now()}`;
  }

  /** 递归复制目录（保留脚本/资源等附带文件） */
  private copyDir(src: string, dest: string): void {
    fs.mkdirSync(dest, { recursive: true });
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const e of entries) {
      const s = path.join(src, e.name);
      const d = path.join(dest, e.name);
      if (e.isDirectory()) {
        this.copyDir(s, d);
      } else {
        fs.copyFileSync(s, d);
      }
    }
  }

  private generateFullInstructions(name: string, description: string, steps: string[]): string {
    let instructions = `## ${name}\n\n`;
    
    if (description) {
      instructions += `${description}\n\n`;
    }
    
    instructions += '### 操作步骤:\n';
    steps.forEach((step, index) => {
      instructions += `${index + 1}. ${step}\n`;
    });
    
    return instructions;
  }

  /**
   * 查找匹配的技能
   */
  private findMatchingSkill(userMessage: string): SkillDefinition | null {
    const lowerMessage = userMessage.toLowerCase();
    
    for (const skill of this.skills.values()) {
      for (const keyword of skill.triggerKeywords) {
        if (lowerMessage.includes(keyword.toLowerCase())) {
          return skill;
        }
      }
    }
    
    return null;
  }

  /**
   * 获取所有技能的摘要清单
   */
  public getAllSkillSummaries(): string {
    if (this.skills.size === 0) {
      return '暂无可使用的技能';
    }

    let summary = '## 可用技能列表\n\n';
    
    let index = 1;
    for (const skill of this.skills.values()) {
      summary += `${index}. **${skill.name}**\n`;
      summary += `   - 描述: ${skill.description}\n`;
      summary += `   - 触发关键词: ${skill.triggerKeywords.join(', ')}\n\n`;
      index++;
    }

    return summary;
  }

  /**
   * 获取所有加载的技能
   */
  public getAllSkills(): SkillState[] {
    return Array.from(this.skills.values());
  }

  /**
   * 重新加载所有技能
   */
  public reloadSkills(): void {
    this.skills.clear();
    this.loadAllSkills();
  }

  /**
   * 切换技能的启用状态
   */
  public toggleSkill(skillId: string, enabled: boolean): boolean {
    const skill = this.skills.get(skillId);
    if (!skill) {
      this.log.warn('[SkillLoader] 技能不存在', { skillId });
      return false;
    }

    skill.enabled = enabled;
    
    // 保存状态
    this.saveSkillStates();
    
    this.log.info('[SkillLoader] 技能状态已更新', { skillId, enabled });
    return true;
  }

  /**
   * 记录技能使用
   */
  public recordSkillUsage(skillId: string, success: boolean): void {
    const skill = this.skills.get(skillId);
    if (!skill) return;

    skill.usageCount += 1;
    
    // 更新成功率
    if (skill.usageCount > 0) {
      const successCount = (skill.successRate * (skill.usageCount - 1) + (success ? 100 : 0)) / skill.usageCount;
      skill.successRate = Math.round(successCount);
    }
    
    this.saveSkillStates();
  }

  /**
   * 保存技能状态
   */
  private saveSkillStates(): void {
    const skillStates: Record<string, any> = {};
    this.skills.forEach((skill, id) => {
      skillStates[id] = {
        enabled: skill.enabled,
        usageCount: skill.usageCount,
        successRate: skill.successRate
      };
    });
    this.configStore.set('skills.states', skillStates);
  }

  /**
   * 导入技能（从文件）
   */
  public async importSkillFromFile(filePath: string): Promise<{ success: boolean; error?: string; skillId?: string }> {
    try {
      if (!fs.existsSync(filePath)) {
        return { success: false, error: '文件不存在' };
      }

      const content = fs.readFileSync(filePath, 'utf-8');
      
      // 生成技能ID
      const fileName = path.basename(filePath, path.extname(filePath));
      const skillId = `imported_${fileName}_${Date.now()}`;
      
      // 解析技能
      const skill = this.parseSkillMd(skillId, content);
      if (!skill) {
        return { success: false, error: '技能文件解析失败' };
      }
      
      // 创建技能目录
      const skillDir = path.join(this.skillsDir, skillId);
      if (!fs.existsSync(skillDir)) {
        fs.mkdirSync(skillDir, { recursive: true });
      }
      
      // 保存技能文件
      const skillMdPath = path.join(skillDir, 'skill.md');
      fs.writeFileSync(skillMdPath, content, 'utf-8');
      
      // 加载新技能
      this.loadSkill(skillId);
      
      this.log.info('[SkillLoader] 技能导入成功', { skillId, name: skill.name });
      
      return { success: true, skillId };
    } catch (error: any) {
      this.log.error('[SkillLoader] 技能导入失败', error);
      return { success: false, error: error.message || '导入失败' };
    }
  }

  /**
   * 导入技能（从URL）
   * - 支持 .md / .markdown 文本：直接下载解析
   * - 支持 .zip 技能包：下载到临时文件后委托 importSkillFromZip（双格式 + 整包保留）
   */
  public async importSkillFromUrl(url: string): Promise<{ success: boolean; error?: string; skillId?: string }> {
    try {
      if (!url || !/^https?:\/\//i.test(url)) {
        return { success: false, error: '请提供合法的 http(s) 链接' };
      }
      this.log.info('[SkillLoader] 从URL导入技能', { url });

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30000);
      let res: Response;
      try {
        res = await fetch(url, { signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }

      if (!res.ok) {
        return { success: false, error: `下载失败: HTTP ${res.status} ${res.statusText}` };
      }

      const isZip = /\.zip(\?.*)?$/i.test(url);
      if (isZip) {
        const buf = Buffer.from(await res.arrayBuffer());
        const tmpZip = path.join(os.tmpdir(), `pipiclaw-url-${Date.now()}.zip`);
        fs.writeFileSync(tmpZip, buf);
        try {
          return await this.importSkillFromZip(tmpZip);
        } finally {
          fs.rmSync(tmpZip, { force: true });
        }
      }

      const content = await res.text();
      if (!content || !content.trim()) {
        return { success: false, error: '链接内容为空，确认是否为技能 .md 文件' };
      }

      const skillId = `imported_${Date.now()}`;
      const skill = this.parseSkillMd(skillId, content);

      if (!skill) {
        return { success: false, error: '技能解析失败（确认链接指向 skill.md / SKILL.md）' };
      }

      const skillDir = path.join(this.skillsDir, skillId);
      fs.mkdirSync(skillDir, { recursive: true });

      const skillMdPath = path.join(skillDir, 'skill.md');
      fs.writeFileSync(skillMdPath, content, 'utf-8');

      this.loadSkill(skillId);

      return { success: true, skillId };
    } catch (error: any) {
      if (error?.name === 'AbortError') {
        return { success: false, error: '下载超时（30s）' };
      }
      this.log.error('[SkillLoader] 从URL导入技能失败', error);
      return { success: false, error: error.message || '导入失败' };
    }
  }

  /**
   * 从压缩包导入技能（跨平台技能包载体）
   * - 兼容 .zip，解包后查找 skill.md / SKILL.md（双格式均可）
   * - 整包保留附带脚本/资源，可吃下 OpenClaw / Claude Code 的技能包
   */
  public async importSkillFromZip(zipPath: string): Promise<{ success: boolean; error?: string; skillId?: string }> {
    try {
      if (!fs.existsSync(zipPath)) {
        return { success: false, error: '压缩包不存在' };
      }
      if (!/\.zip$/i.test(zipPath)) {
        return { success: false, error: '仅支持 .zip 格式的技能包' };
      }

      const JSZip = (await import('jszip')).default;
      const buffer = fs.readFileSync(zipPath);
      const zip = await JSZip.loadAsync(buffer);

      const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pipiclaw-skill-'));

      const writes: Promise<void>[] = [];
      zip.forEach((relativePath, file) => {
        if (file.dir) return;
        const dest = path.join(tmpRoot, relativePath);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        writes.push(file.async('nodebuffer').then((buf: Buffer) => fs.writeFileSync(dest, buf)));
      });
      await Promise.all(writes);

      const skillDoc = this.findSkillDoc(tmpRoot);
      if (!skillDoc) {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
        return { success: false, error: '压缩包中未找到 skill.md / SKILL.md 技能文档' };
      }

      const skillId = this.resolveSkillId(skillDoc);
      const skillDir = path.join(this.skillsDir, skillId);
      fs.mkdirSync(skillDir, { recursive: true });

      // 复制整包（含脚本/资源），以技能文档所在目录为根
      this.copyDir(path.dirname(skillDoc), skillDir);

      const content = fs.readFileSync(skillDoc, 'utf-8');
      const skill = this.parseSkillMd(skillId, content);
      if (!skill) {
        fs.rmSync(skillDir, { recursive: true, force: true });
        fs.rmSync(tmpRoot, { recursive: true, force: true });
        return { success: false, error: '技能文档解析失败' };
      }

      // 统一保存为 skill.md，便于后续管理
      fs.writeFileSync(path.join(skillDir, 'skill.md'), content, 'utf-8');

      this.loadSkill(skillId);
      fs.rmSync(tmpRoot, { recursive: true, force: true });

      this.log.info('[SkillLoader] 压缩包技能导入成功', { skillId, name: skill.name });
      return { success: true, skillId };
    } catch (error: any) {
      this.log.error('[SkillLoader] 压缩包技能导入失败', error);
      return { success: false, error: error.message || '导入失败' };
    }
  }

  /**
   * 从文件夹导入技能（直接拖整个技能目录）
   */
  public async importSkillFromFolder(folderPath: string): Promise<{ success: boolean; error?: string; skillId?: string }> {
    try {
      if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
        return { success: false, error: '文件夹不存在' };
      }

      const skillDoc = this.findSkillDoc(folderPath);
      if (!skillDoc) {
        return { success: false, error: '文件夹中未找到 skill.md / SKILL.md 技能文档' };
      }

      const skillId = this.resolveSkillId(skillDoc);
      const skillDir = path.join(this.skillsDir, skillId);
      fs.mkdirSync(skillDir, { recursive: true });

      this.copyDir(path.dirname(skillDoc), skillDir);

      const content = fs.readFileSync(skillDoc, 'utf-8');
      const skill = this.parseSkillMd(skillId, content);
      if (!skill) {
        fs.rmSync(skillDir, { recursive: true, force: true });
        return { success: false, error: '技能文档解析失败' };
      }

      fs.writeFileSync(path.join(skillDir, 'skill.md'), content, 'utf-8');

      this.loadSkill(skillId);

      this.log.info('[SkillLoader] 文件夹技能导入成功', { skillId, name: skill.name });
      return { success: true, skillId };
    } catch (error: any) {
      this.log.error('[SkillLoader] 文件夹技能导入失败', error);
      return { success: false, error: error.message || '导入失败' };
    }
  }

  /**
   * 合并技能
   */
  public mergeSkill(proposal: any, existingSkillId: string): boolean {
    try {
      const existingSkill = this.skills.get(existingSkillId);
      if (!existingSkill) {
        this.log.warn('[SkillLoader] 技能不存在，无法合并', { existingSkillId });
        return false;
      }

      const existingSkillDir = path.join(this.skillsDir, existingSkillId);
      const existingSkillMdPath = path.join(existingSkillDir, 'skill.md');
      
      // 备份原文件
      const backupPath = `${existingSkillMdPath}.backup_${Date.now()}`;
      if (fs.existsSync(existingSkillMdPath)) {
        fs.copyFileSync(existingSkillMdPath, backupPath);
        this.log.info('[SkillLoader] 已备份原技能文件', { backupPath });
      }

      // 合并触发关键词
      const mergedKeywords = [...new Set([...existingSkill.triggerKeywords, ...(proposal.keywords || [])])];
      
      // 合并操作步骤
      const mergedSteps = [...new Set([...existingSkill.operationSteps, ...(proposal.operationSteps || [])])];

      // 生成新的完整指令
      let fullInstructions = `# ${proposal.name || existingSkill.name}\n\n`;
      fullInstructions += `## 描述\n${proposal.description || existingSkill.description}\n\n`;
      fullInstructions += `## 触发条件\n${proposal.triggerCondition || '无'}\n\n`;
      fullInstructions += `## 触发关键词\n`;
      mergedKeywords.forEach(keyword => {
        fullInstructions += `- ${keyword}\n`;
      });
      fullInstructions += `\n## 操作步骤\n`;
      mergedSteps.forEach((step, index) => {
        fullInstructions += `${index + 1}. ${step}\n`;
      });

      // 写入文件
      fs.writeFileSync(existingSkillMdPath, fullInstructions, 'utf-8');

      // 更新内存中的技能
      existingSkill.name = proposal.name || existingSkill.name;
      existingSkill.description = proposal.description || existingSkill.description;
      existingSkill.triggerKeywords = mergedKeywords;
      existingSkill.operationSteps = mergedSteps;
      existingSkill.fullInstructions = fullInstructions;
      existingSkill.fileSize = Buffer.byteLength(fullInstructions, 'utf-8');

      this.log.info('[SkillLoader] 技能合并成功', { existingSkillId, backupPath });

      return true;
    } catch (error) {
      this.log.error('[SkillLoader] 技能合并失败', error);
      return false;
    }
  }

  /**
   * 获取优化的技能上下文
   */
  public async getSkillContext(userMessage: string): Promise<string> {
    try {
      const enabledSkills = Array.from(this.skills.values()).filter(s => s.enabled);
      
      if (enabledSkills.length === 0) {
        return '';
      }

      let skillsToInject: Array<{ skill: SkillState, isFull: boolean }> = [];

      if (enabledSkills.length > 5) {
        // 技能较多，需要轻量筛选
        this.log.info('[SkillLoader] 技能数量较多，进行语义筛选');

        for (const skill of enabledSkills) {
          const isMatch = await this.selfLearner.checkSkillMatch(
            userMessage,
            skill.name,
            (skill as any).triggerCondition || '无'
          );
          
          skillsToInject.push({ skill, isFull: isMatch });
        }

        // 按匹配度排序，取前3个完整注入
        skillsToInject.sort((a, b) => (b.isFull ? 1 : 0) - (a.isFull ? 1 : 0));
        
        let fullCount = 0;
        skillsToInject = skillsToInject.map(item => {
          if (item.isFull && fullCount < 3) {
            fullCount++;
            return item;
          }
          return { ...item, isFull: false };
        });
      } else {
        // 技能较少，全部完整注入
        skillsToInject = enabledSkills.map(skill => ({ skill, isFull: true }));
      }

      // 构建最终内容，检查字符限制
      let finalContent = '';

      for (const { skill, isFull } of skillsToInject) {
        let contentToAdd = '';
        if (isFull) {
          contentToAdd = skill.fullInstructions + '\n';
        } else {
          contentToAdd = `## ${skill.name}\n${skill.description}\n`;
        }
        
        // 检查总长度是否超过3000字符
        if (finalContent.length + contentToAdd.length > 3000) {
          // 剩余空间用于追加摘要
          const remainingSpace = 3000 - finalContent.length;
          if (remainingSpace > 100) {
            finalContent += `## ${skill.name}\n${skill.description.substring(0, 80)}...\n`;
          }
          break;
        }
        
        finalContent += contentToAdd;
      }

      if (finalContent.length > 0) {
        this.log.info('[SkillLoader] 注入技能上下文', { 
          skillCount: skillsToInject.length, 
          contentLength: finalContent.length 
        });
      }

      return finalContent;
    } catch (error) {
      this.log.error('[SkillLoader] 获取技能上下文失败', error);
      return '';
    }
  }
}
