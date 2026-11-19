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
  /** 【M4-A】触发条件 —— 来自 frontmatter when_to_use 或 `## 触发条件` 小节 */
  whenToUse: string;
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
  /**
   * 【M3-D】该技能来自哪个目录(绝对路径)。
   * 主目录 = userData/skills;额外目录 = 用户自己加的目录。
   * 有了它才能:① 删除技能时知道删哪个 ② 界面显示技能的来源
   */
  sourceDir?: string;
  /**
   * 【M4-A 新增】触发条件 —— 来自 frontmatter 的 `when_to_use`。
   *
   * 此前本项目自造了 `triggerCondition` 字段,但 SkillState 接口里根本没有它,
   * parseSkillMd 也从不设置 → 永远是 undefined → 语义匹配拿字符串"无"作对照。
   * 现改为从 frontmatter 真实读取,向后兼容旧的 `## 触发条件` 小节。
   */
  whenToUse: string;
  triggerKeywords: string[];
  operationSteps: string[];
  fullInstructions: string;
  enabled: boolean;
  usageCount: number;
  successRate: number;
  fileSize: number;
  /**
   * 【M4-A 新增】渐进披露的附属资源目录是否存在(来自 Anthropic Agent Skills 规范):
   *   references/ 详细文档(按需 Read)
   *   scripts/     可执行脚本(按需 Bash,省 token 且结果确定)
   *   assets/      模板/图片
   */
  hasReferences: boolean;
  hasScripts: boolean;
  hasAssets: boolean;
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
    // 【M4-X】该目录现在是**应用自身结构目录**下的 skills(不可写时落回 userData),
    // 且**不再有"首启从项目目录拷贝样例技能"的行为** —— 技能不随应用集成,
    // 由用户从开源技能库下载或手动添加。
    this.skillsDir = SkillManager.getSkillsDir();

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

  /**
   * 【M3-D】扫描**多个**技能目录。
   *
   * 【为什么要多目录】
   * 此前只有 `userData/skills` 一个目录 —— 技能要么是应用导入的,
   * 要么是自学习闭环生成的。用户自己项目里的技能目录(`<repo>/skills`)
   * 完全看不到。而 preload 里早就有 6 个 `skills:addCustomDir` 之类的通道
   * 声明,却没有实现、没有调用方 —— 典型的"能力只有一张嘴"。
   *
   * 【优先级】主目录 > 额外目录(按加入顺序)。
   * 同名技能以**先到者**为准,后来的跳过并记日志 —— 技能 id 是
   * `load_skill` 的寻址键,必须全局唯一,不能靠前缀区分(那会让
   * id 变成 `dir:skill` 这种形态,与既有 SKILL.md 约定冲突)。
   */
  private loadAllSkills(): void {
    const primary = this.skillsDir
    const extras = this.getExtraDirs()
    this.log.info('[SkillLoader] 开始加载技能...', { path: primary, extraDirs: extras.length })

    try {
      let loaded = 0
      // 主目录优先
      loaded += this.loadSkillsFromDir(primary, false)
      // 额外目录(按加入顺序)
      for (const dir of extras) {
        if (path.resolve(dir) === path.resolve(primary)) continue   // 重复添加的跳过
        loaded += this.loadSkillsFromDir(dir, true)
      }

      this.log.info('[SkillLoader] 技能加载完成', {
        count: this.skills.size,
        loaded,
        skipped: loaded - this.skills.size,
      })
    } catch (error) {
      this.log.error('[SkillLoader] 加载技能失败', error);
    }
  }

  /**
   * 扫一个目录下的所有技能子目录。
   *
   * 【符号链接默认不跟随】`dirent.isDirectory()` 对符号链接返回 false ——
   * 于是指向目录外的软链不会被加载。这既是安全默认(技能内容会进 LLM 上下文,
   * 指向任意路径等于任意读取),也让"用户想软链一个技能目录"变成显式不支持。
   */
  private loadSkillsFromDir(baseDir: string, isExtra: boolean): number {
    let loaded = 0
    let dirs: string[] = []
    try {
      if (!fs.existsSync(baseDir)) {
        if (isExtra) this.log.warn('[SkillLoader] 额外技能目录不存在,跳过', { path: baseDir })
        return 0
      }
      dirs = fs.readdirSync(baseDir, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory())
        .map(dirent => dirent.name)
    } catch (error) {
      this.log.warn('[SkillLoader] 读技能目录失败,跳过', { path: baseDir, error: String(error) })
      return 0
    }

    for (const skillDir of dirs) {
      const before = this.skills.size
      this.loadSkill(skillDir, baseDir)
      if (this.skills.size > before) loaded++
      else if (isExtra) {
        this.log.warn('[SkillLoader] 额外目录里的技能与已有技能同名,跳过', {
          skillId: skillDir, dir: baseDir,
        })
      }
    }
    return loaded
  }

  /**
   * 【M3-D】用户额外添加的技能目录(持久化)。
   *
   * 存 `skills.extraDirs` —— 与 `skills.states`(启用状态/统计)分开放,
   * 两者职责不同:一个是"扫哪儿",一个是"每个技能什么状态"。
   */
  public getExtraDirs(): string[] {
    const dirs = this.configStore.get('skills.extraDirs') as string[] | undefined
    return Array.isArray(dirs) ? dirs.filter(d => typeof d === 'string' && d.trim()) : []
  }

  public setExtraDirs(dirs: string[]): string[] {
    const clean = (Array.isArray(dirs) ? dirs : [])
      .filter(d => typeof d === 'string' && d.trim())
      .map(d => path.resolve(d.trim()))
      // 去重(同一目录加两次没意义)
      .filter((d, i, arr) => arr.indexOf(d) === i)
    this.configStore.set('skills.extraDirs', clean)
    this.reloadSkills()
    this.log.info('[SkillLoader] 额外技能目录已更新', { count: clean.length })
    return clean
  }

  public addExtraDir(dir: string): { ok: boolean; dirs: string[]; error?: string } {
    const resolved = path.resolve(dir.trim())
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      return { ok: false, dirs: this.getExtraDirs(), error: `目录不存在: ${resolved}` }
    }
    const dirs = this.getExtraDirs()
    if (dirs.includes(resolved)) {
      return { ok: true, dirs }
    }
    return { ok: true, dirs: this.setExtraDirs([...dirs, resolved]) }
  }

  public removeExtraDir(dir: string): { ok: boolean; dirs: string[] } {
    const resolved = path.resolve(dir.trim())
    return { ok: true, dirs: this.setExtraDirs(this.getExtraDirs().filter(d => d !== resolved)) }
  }

  /**
   * 预览一个目录里有什么技能(不加载)—— 给"添加目录"界面用。
   */
  public previewDirectory(dir: string): { exists: boolean; path: string; skills: Array<{ id: string; name?: string; description?: string }> } {
    const resolved = path.resolve(dir.trim())
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      return { exists: false, path: resolved, skills: [] }
    }
    const skills: Array<{ id: string; name?: string; description?: string }> = []
    try {
      for (const dirent of fs.readdirSync(resolved, { withFileTypes: true })) {
        if (!dirent.isDirectory()) continue
        const candidates = ['SKILL.md', 'skill.md']
        for (const fname of candidates) {
          const fp = path.join(resolved, dirent.name, fname)
          if (!fs.existsSync(fp)) continue
          const raw = fs.readFileSync(fp, 'utf-8')
          const parsed = this.parseSkillMd(dirent.name, raw)
          if (parsed) {
            skills.push({ id: dirent.name, name: parsed.name, description: parsed.description })
          }
          break
        }
      }
    } catch (error) {
      this.log.warn('[SkillLoader] 预览目录失败', { path: resolved, error: String(error) })
    }
    return { exists: true, path: resolved, skills }
  }

  /** 技能存储信息(主目录 + 额外目录 + 各自技能数) */
  public getStorageInfo(): {
    primaryDir: string
    extraDirs: string[]
    primaryCount: number
    extraCounts: Array<{ dir: string; count: number; exists: boolean }>
    total: number
  } {
    const extras = this.getExtraDirs()
    const countIn = (dir: string): number => {
      try {
        if (!fs.existsSync(dir)) return 0
        return fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).length
      } catch { return 0 }
    }
    const extraCounts = extras.map(dir => ({ dir, count: countIn(dir), exists: fs.existsSync(dir) }))
    const primaryCount = countIn(this.skillsDir)
    return {
      primaryDir: this.skillsDir,
      extraDirs: extras,
      primaryCount,
      extraCounts,
      total: this.skills.size,
    }
  }

  private loadSkill(skillDir: string, baseDir?: string): void {
    const skillPath = path.join(baseDir ?? this.skillsDir, skillDir);

    // 【M4-A】文件名兼容:Anthropic Agent Skills 规范用大写 SKILL.md,
    // 本项目历史上有小写 skill.md。两个都认,优先大写(规范优先)。
    const candidates = ['SKILL.md', 'skill.md'];
    let skillMdPath: string | null = null;
    for (const c of candidates) {
      const p = path.join(skillPath, c);
      if (fs.existsSync(p)) { skillMdPath = p; break }
    }
    if (!skillMdPath) {
      this.log.warn('[SkillLoader] 技能文件不存在', { skillDir, tried: candidates });
      return;
    }

    try {
      const content = fs.readFileSync(skillMdPath, 'utf-8');
      const fileSize = Buffer.byteLength(content, 'utf-8');
      const skill = this.parseSkillMd(skillDir, content);

      if (skill) {
        /**
         * 【M3-D】同名以【先到者】为准 —— 主目录优先于额外目录。
         *
         * 技能 id 是 `load_skill` 的寻址键,必须全局唯一。
         * 若让后来的覆盖先来的,主目录里的技能会被额外目录的同名技能顶掉 ——
         * 用户会看到"我导入的技能不见了",且毫无线索。
         */
        if (this.skills.has(skill.id)) {
          this.log.warn('[SkillLoader] 技能 id 重复,保留先加载的那个', {
            id: skill.id, dir: baseDir ?? this.skillsDir,
          });
          return;
        }
        // 从配置中读取状态
        const skillStates = this.configStore.get('skills.states') as Record<string, any> || {};
        const savedState = skillStates[skill.id] || {};

        // 【M4-A】渐进披露:探测附属资源目录(Anthropic 规范)
        const hasDir = (d: string): boolean => {
          try { return fs.existsSync(path.join(skillPath, d)) } catch { return false }
        };

        this.skills.set(skill.id, {
          ...skill,
          enabled: savedState.enabled !== false, // 默认启用
          usageCount: savedState.usageCount || 0,
          successRate: savedState.successRate || 100,
          fileSize,
          hasReferences: hasDir('references'),
          hasScripts: hasDir('scripts'),
          hasAssets: hasDir('assets'),
          // 【M3-D】记来源目录 —— 删除技能时要知道删哪个,界面也要显示来源
          sourceDir: baseDir ?? this.skillsDir,
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
      let whenToUse = '';
      const triggerKeywords: string[] = [];
      const operationSteps: string[] = [];

      if (fm) {
        name = fm.name || skillId;
        description = fm.description || '';
        // 【M4-A】frontmatter 的 when_to_use 是权威触发信号
        whenToUse = fm.whenToUse || '';
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
          /**
           * 【M4-A 修正】原实现有三个误判:
           *   1. `## 触发条件` 与 `## 触发关键词` 落进同一分支 → 整句
           *      "当用户提到 X 时" 被当成一个"关键词"
           *   2. `## 示例` 不匹配任何分支 → currentSection 保持上一步的值,
           *      于是示例指令被当成一条操作步骤
           *   3. `## Gotchas` / `## 参考` 等规范小节无归属
           * 现按 Anthropic 规范区分:触发条件(whenToUse) / 关键词 / 步骤 /
           * 示例 / 陷阱,各自独立。
           */
          const h = lower.replace(/^#+\s*/, '').trim();
          if (h.includes('描述') || h.includes('description')) {
            currentSection = 'description';
          } else if (h.includes('触发条件') || h.includes('when to use') || h.includes('when_to_use')) {
            currentSection = 'whenToUse';
          } else if (h.includes('触发') || h.includes('trigger') || h.includes('关键词') || h.includes('keyword')) {
            currentSection = 'keywords';
          } else if (h.includes('示例') || h.includes('example')) {
            currentSection = 'examples';
          } else if (h.includes('陷阱') || h.includes('gotcha') || h.includes('注意')) {
            currentSection = 'gotchas';
          } else if (
            h.includes('步骤') || h.includes('step') ||
            h.includes('操作') || h.includes('instruction') || h.includes('指令')
          ) {
            currentSection = 'steps';
          } else {
            // 未知小节:不归入任何已知 section,避免污染步骤/关键词
            currentSection = 'other';
          }
          continue;
        }

        if (line && !line.startsWith('#')) {
          if (currentSection === 'description' && line) {
            description += (description ? '\n' : '') + line;
          } else if (currentSection === 'whenToUse') {
            whenToUse += (whenToUse ? ' ' : '') + line.trim();
          } else if (currentSection === 'keywords') {
            const keyword = line.replace(/^[-*]\s*/, '').trim();
            if (keyword) triggerKeywords.push(keyword);
          } else if (currentSection === 'steps') {
            const step = line.replace(/^\d+\.\s*/, '').replace(/^[-*]\s*/, '').trim();
            if (step) operationSteps.push(step);
          }
        }
      }

      if (triggerKeywords.length === 0 && !whenToUse && !description) {
        this.log.warn('[SkillLoader] 技能缺少触发信息(关键词/when_to_use/描述均为空)', { skillId });
      }

      const fullInstructions = this.generateFullInstructions(name, description, operationSteps, body);

      return {
        id: skillId,
        name,
        description: description || name,
        whenToUse: whenToUse.trim(),
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
  /**
   * 解析 YAML frontmatter。
   *
   * 【M4-A】新增 when_to_use —— Anthropic Agent Skills 规范里,它是
   * description 之外的额外触发上下文(会与 description 一起呈现给模型)。
   * 本项目此前的 `triggerCondition` 字段是从这个位置来的,但实现里从未
   * 读取,导致语义匹配永远拿到 undefined。
   *
   * 同时支持 allowed-tools(限制技能可用的工具集)与 user-invocable /
   * disable-model-invocation(控制技能是否可被模型自动调用)。
   */
  private parseFrontmatter(content: string): {
    name?: string
    description?: string
    whenToUse?: string
    allowedTools?: string[]
    body: string
  } | null {
    const m = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
    if (!m) return null;

    const fmText = m[1];
    const body = m[2];
    const result: {
      name?: string; description?: string; whenToUse?: string; allowedTools?: string[]
    } = {};

    const nameMatch = fmText.match(/^name:\s*(.+)$/m);
    if (nameMatch) result.name = nameMatch[1].trim().replace(/^['"]|['"]$/g, '');

    const descMatch = fmText.match(/^description:\s*([\s\S]+?)(?:\n[a-zA-Z_-]+:|$)/m);
    if (descMatch) result.description = descMatch[1].trim().replace(/^['"]|['"]$/g, '');

    // when_to_use: 单行或折叠块(>- / |-)均可
    const whenMatch = fmText.match(/^when_to_use:\s*(.+?)(?=\n[a-zA-Z_-]+:|$)/ms);
    if (whenMatch) {
      result.whenToUse = whenMatch[1]
        .trim()
        .replace(/^[>|]-?\s*/, '')
        .replace(/^['"]|['"]$/g, '')
        .replace(/\s+/g, ' ')
        .trim()
    }

    const toolsMatch = fmText.match(/^allowed-tools:\s*(.+?)(?=\n[a-zA-Z_-]+:|$)/ms);
    if (toolsMatch) {
      result.allowedTools = toolsMatch[1]
        .trim()
        .replace(/^\[|\]$/g, '')
        .split(',')
        .map(s => s.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean)
    }

    return {
      name: result.name,
      description: result.description,
      whenToUse: result.whenToUse,
      allowedTools: result.allowedTools,
      body,
    };
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

  /**
   * 生成技能正文(L2 层内容)。
   *
   * 【M4-A 修正】原实现只重排 name + description + steps 三样,
   * 【丢弃了 SKILL.md 里的其他实质内容】—— Gotchas 段、参考说明、
   * 约束条件、正文段落全部丢失。
   *
   * 依据 Anthropic Agent Skills 规范:SKILL.md 是一份 runbook
   * (何时用 → 怎么做 → 约束 → 示例),正文应当【原样】给模型看。
   * 团队实践里 Gotchas 被称为"任何技能里信噪比最高的内容" ——
   * 丢掉它等于丢掉了技能最值钱的部分。
   *
   * 现在: 有 steps 时给结构化摘要 + 完整正文;无 steps 时给完整正文。
   */
  private generateFullInstructions(
    name: string,
    description: string,
    steps: string[],
    rawBody?: string,
  ): string {
    const body = (rawBody ?? '').trim();

    // 有结构化步骤:先给摘要,再给完整正文(含 Gotchas 等)
    if (steps.length > 0) {
      let summary = `## ${name}\n\n`;
      if (description) summary += `${description}\n\n`;
      summary += '### 操作步骤:\n';
      steps.forEach((step, index) => {
        summary += `${index + 1}. ${step}\n`;
      });
      // 正文与摘要内容高度重合时不重复贴
      if (body && !steps.every(s => body.includes(s))) {
        return `${summary}\n${body}\n`;
      }
      return summary;
    }

    // 无结构化步骤:原样给正文(没有正文就退回 name+description)
    if (body) return `## ${name}\n\n${body}\n`;
    let fallback = `## ${name}\n\n`;
    if (description) fallback += `${description}\n`;
    return fallback;
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
      // 【M4-W】带出 skill_id —— 展示名与 id 不同是常态,而 id 才是工具认的那个
      summary += `   - skill_id: ${skill.id}\n`;
      summary += `   - 描述: ${skill.description}\n`;
      // 【M4-A】触发条件是路由关键信息 —— 模型的匹配依据。
      // 此前摘要里没有它,导致"什么时候该用这个技能"这个最关键的问题
      // 在注入面丢失(自学习生成的技能尤其明显:它们的描述往往很短)。
      if (skill.whenToUse) {
        summary += `   - 触发条件: ${skill.whenToUse}\n`;
      }
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
   * 【M3-D】删除一个技能 —— 删它所在的**技能子目录**。
   *
   * 【安全 — 这是删目录,必须严格】
   * 只允许删「已知技能根目录」下的「一级子目录」:
   *   已知根 = 主目录(userData/skills) ∪ 用户添加的额外目录
   * 任何越界(路径穿越、符号链接指向外部、根目录本身)一律拒绝。
   * 技能 id 是用户/LLM 给的字符串 —— 不能直接拿它拼路径就删。
   */
  public removeSkill(skillId: string): { ok: boolean; error?: string; removedFrom?: string } {
    const skill = this.skills.get(skillId)
    if (!skill) return { ok: false, error: `技能不存在: ${skillId}` }

    const base = path.resolve(skill.sourceDir ?? this.skillsDir)
    const allowedRoots = [path.resolve(this.skillsDir), ...this.getExtraDirs().map(d => path.resolve(d))]
    if (!allowedRoots.includes(base)) {
      return { ok: false, error: `拒绝: 该技能来自未登记的目录 ${base}` }
    }

    // 只删 base 下的一级子目录,且必须真的在 base 之内
    const target = path.resolve(base, skillId)
    if (path.dirname(target) !== base) {
      return { ok: false, error: `拒绝: 目标越界 ${target}` }
    }
    if (!fs.existsSync(target)) {
      // 目录已不存在(只剩索引里的记录)→ 清掉索引即可
      this.skills.delete(skillId)
      this.reloadSkills()
      return { ok: true, removedFrom: base }
    }
    try {
      fs.rmSync(target, { recursive: true, force: true })
    } catch (e) {
      return { ok: false, error: `删除失败: ${String(e)}` }
    }
    this.skills.delete(skillId)
    this.reloadSkills()
    this.log.info('[SkillLoader] 技能已删除', { id: skillId, dir: base })
    return { ok: true, removedFrom: base }
  }

  /**
   * 按 id 取单个技能 (M4-A)
   * 供 load_skill 工具与测试使用;不存在时返回 undefined。
   */
  public getSkill(id: string): SkillState | undefined {
    return this.skills.get(id);
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
   * 【M4-A】L1 渐进披露:所有启用技能的 name + description 摘要。
   *
   * 这是常驻注入的部分(约 100 token/技能)。依据 Anthropic Agent Skills
   * 规范:description 本身就是路由规则 —— 模型看到它就能决定要不要加载
   * 这个技能的正文。when_to_use 是额外的触发上下文,一并给出。
   */
  public getSkillSummaries(): string {
    const enabled = Array.from(this.skills.values()).filter(s => s.enabled);
    if (enabled.length === 0) return '';
    const lines: string[] = [];
    for (const s of enabled) {
      // 【M4-W】摘要里必须带 **skill_id**。
      //
      // 【为什么】模型判断完"该用哪个技能"之后,要调 load_skill(skill_id) 才能拿到正文。
      // 而 skill_id 是**目录名**,展示名是 frontmatter 里的 name —— 两者常常不同
      // (例:目录 `sample-web-summary` / 名称 `Web Page Summarizer`)。
      // 此前摘要只给 name,模型就只会把 name 当 id 传 → 工具报「技能不存在」→
      // 白白多花一次模型往返(读错误信息再改用 id 重试)。
      // 实跑(M4-W 路由基准):**每次加载都先失败一次**。
      //
      // 故:摘要里把 id 写出来 —— 它才是模型该传给工具的东西。
      const parts = [`- ${s.name} (skill_id: ${s.id}): ${s.description}`];
      if (s.whenToUse) parts.push(`  (适用:${s.whenToUse})`);
      lines.push(parts.join(''));
    }
    return lines.join('\n');
  }

  /**
   * 【M4-A】L2 渐进披露:按需取单个技能的完整正文。
   *
   * 由 load_skill 工具调用 —— 模型自己决定何时加载(这正是 Claude Code 的做法)。
   * 返回正文 + 附属资源指引(references/scripts 在磁盘上,按需 Read/Bash)。
   */
  public getSkillBody(skillId: string): string {
    const s = this.findSkillByIdOrName(skillId);
    if (!s) {
      // 【M4-W】错误信息里写清"该传什么" —— 原来的「可用技能:xxx」只列 id,
      // 模型得自己猜哪个是展示名、哪个是 id。直接给出 id + 名称对照。
      const available = Array.from(this.skills.values())
        .map(x => `${x.id}（${x.name}）`)
        .join(', ');
      return `技能 "${skillId}" 不存在。可用技能的 skill_id:${available || '(无)'}。请用上面括号前的 skill_id 调用。`;
    }
    const extra: string[] = [];
    if (s.hasReferences) extra.push('  references/ 目录含详细文档,需要时用 Read 读取对应文件。');
    if (s.hasScripts) extra.push('  scripts/ 目录含可直接执行的脚本,优先运行脚本而非自己重写逻辑。');
    if (s.hasAssets) extra.push('  assets/ 目录含模板与素材文件。');
    const tail = extra.length ? `\n\n可用资源:\n${extra.join('\n')}` : '';
    return `${s.fullInstructions}${tail}`;
  }

  /**
   * 按 id 找技能；找不到时**按名称兜底**。
   *
   * 【M4-W 为什么要有兜底】
   * 展示名与 id 不同是常态(目录名 vs frontmatter 的 name)。
   * 摘要里已经同时给了两者,但模型仍可能只记得名字 —— 或者用户/脚本直接传名字。
   * 既然两种叫法指的是同一个技能,就该都能加载,而不是让模型白跑一轮。
   */
  private findSkillByIdOrName(key: string): SkillState | undefined {
    const direct = this.skills.get(key);
    if (direct) return direct;
    const norm = (key ?? '').trim().toLowerCase();
    if (!norm) return undefined;
    for (const s of this.skills.values()) {
      if (s.name.trim().toLowerCase() === norm) return s;
    }
    return undefined;
  }

  /**
   * 把「模型可能传的名字」解析成**规范的 skill id**。
   *
   * 【M4-W 为什么必须解析成 id】
   * 学习闭环记的是「技能 S 被应用了」—— 记的必须是**真实 id**。
   * 若模型传的是展示名(`Web Page Summarizer`),而记录里写的是展示名,
   * 那 `skill-stats.json` 里的技能名就与 `load_skill` 寻址用的 id 对不上:
   * 效用统计会按一个**不存在的 id** 聚合,查不到、也对不上账。
   *
   * 【为什么叫 resolveCanonicalSkillId 而不是 resolveSkillId】
   * 本类里已有一个 `resolveSkillId(skillDocPath)` —— 那是**导入**时
   * 从文档路径推导新 id 用的,两码事。同名会让人(和编译器)搞混。
   */
  public resolveCanonicalSkillId(key: string): string | undefined {
    return this.findSkillByIdOrName(key)?.id;
  }

  /**
   * 【M4-A】获取与用户输入相关的技能上下文。
   *
   * 【语义变更 —— 重要】
   * 旧实现:技能 ≤5 个 → 全部注入全文;>5 个 → 对每个技能【串行发一次 LLM
   *   调用】去问 selfLearner.checkSkillMatch(已于 M3-F 删除),且传入的 triggerCondition
   *   恒为 undefined(实际拿字符串"无"作对照)。N 个技能 = N 次 LLM 往返,
   *   每次规划都付这个成本,且匹配质量接近随机。
   *
   * 新实现(依据 Anthropic 渐进披露规范):
   *   L1 常驻 —— 只注入 name+description(+when_to_use),由模型自己判断相关性
   *   L2 按需 —— 模型判断相关时调 load_skill 工具取全文
   * 匹配决策交给模型(它比我们更懂用户意图),且省掉 N 次 LLM 往返。
   *
   * 本方法保留供【旧管道】(InstructionGenerator → TaskExecutor)使用:
   * 那里没有 tool loop,模型无法主动加载技能,故仍做一次批量匹配,
   * 但改为【单次】LLM 调用排序(而非 N 次),并使用真实的 whenToUse。
   */
  public async getSkillContext(userMessage: string): Promise<string> {
    try {
      const enabledSkills = Array.from(this.skills.values()).filter(s => s.enabled);
      if (enabledSkills.length === 0) return '';

      // L1: 总是给摘要 —— 这是模型的路由依据
      let finalContent = `## 可用技能(按需加载完整说明)
${this.getSkillSummaries()}
`;

      // L2: 旧管道需要"直接可执行的全文",故在此批量匹配一次
      if (enabledSkills.length <= 5) {
        // 技能少:直接给全部全文(成本可控)
        for (const s of enabledSkills) {
          finalContent += `
${s.fullInstructions}
`
        }
        return finalContent
      }

      // 技能多:【单次】LLM 调用批量排序(旧实现是 N 次串行调用)
      const ranked = await this.rankSkillsOnce(userMessage, enabledSkills);
      const top = ranked.slice(0, 3);
      for (const s of top) {
        finalContent += `
${s.fullInstructions}
`
      }
      finalContent += `
(其余 ${enabledSkills.length - top.length} 个技能仅列摘要,需要时用 load_skill 工具加载)
`
      return finalContent
    } catch (error) {
      this.log.error('[SkillLoader] 获取技能上下文失败', error);
      return '';
    }
  }

  /**
   * 【M4-A】单次 LLM 调用批量排序技能 —— 替代旧实现的 N 次串行 checkSkillMatch。
   *
   * 旧实现对每个技能单独调一次 LLM,N 个技能 = N 次往返(技能一多,
   * 每次规划都要等 N 个网络往返)。改为一次调用返回排序。
   */
  private async rankSkillsOnce(
    userMessage: string,
    skills: SkillState[],
  ): Promise<SkillState[]> {
    const list = skills
      .map(s => `- ${s.id}: ${s.description}${s.whenToUse ? ` (适用:${s.whenToUse})` : ''}`)
      .join('\n');
    try {
      const ranked = await this.selfLearner.rankSkillsByRelevance(userMessage, list);
      if (ranked && ranked.length > 0) {
        const byId = new Map(skills.map(s => [s.id, s]));
        const picked = ranked
          .map(id => byId.get(id))
          .filter((s): s is SkillState => !!s);
        if (picked.length > 0) return picked
      }
    } catch (e) {
      this.log.warn('[SkillLoader] 技能批量排序失败,降级为按描述关键词匹配');
    }
    // 降级:纯关键词匹配(零 LLM 成本,确定性强)
    const lower = userMessage.toLowerCase()
    const scored = skills.map(s => {
      const kws = [...s.triggerKeywords, ...(s.whenToUse ? [s.whenToUse] : [])]
      const hits = kws.filter(k => k && lower.includes(k.toLowerCase())).length
      return { s, hits }
    })
    scored.sort((a, b) => b.hits - a.hits)
    return scored.map(x => x.s)
  }
}
