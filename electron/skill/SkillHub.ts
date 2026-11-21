/**
 * PiPiClaw — 开源技能库（联网寻找 + 推荐 + 下载安装）（M4-X）
 * ═══════════════════════════════════════════════════════════════════════
 * 【它补的是哪一环】
 * 用户要求：「技能部分不要集成，联网环境下自动去开源技能库寻找以及推荐用户
 * 联网下载」。
 *
 * 此前**没有一条能用的路**：
 *   - 原有 `ClawHubManager` 是**本地模拟市场**（数据在 userData/clawhub-skills.json，
 *     界面明写「本地演示模式」，「下载」按钮是 stub）—— **M4-X 已连同其界面一并删除**；
 *     界面上明写「本地演示模式」；「下载」按钮是个 **stub**（只弹 toast）。
 *   - `ClawHubRegistry` 是唯一走网络的，但它指向 `https://example.com/...`
 *     —— **占位符，永远不可达**；而且它的 index.json 规范要求
 *     「zipUrl + Ed25519 签名」，那是**自建私有仓库**的格式，
 *     开源技能库（GitHub 上的 SKILL.md 集合）根本不提供。
 *
 * 【本模块做什么】
 *   ① **多源**：内置若干**真实可达**的开源技能库，各有原生格式 → 适配成统一形状
 *   ② **搜索**：拉索引 → 落盘缓存 → 本地按关键词过滤（**有缓存就能离线搜**）
 *   ③ **推荐**：已装的不重复推荐，其余按可用性排序
 *   ④ **安装**：按目录枚举 + 逐文件下载 → 写进技能目录（references/scripts 一并带上）
 *
 * 【为什么索引要落盘缓存】
 * 「联网时自动寻找」意味着**要联网**；但用户也会**断网用**。
 * 索引缓存下来 → 断网时搜索与推荐照常可用，只是不能装新包。
 * 这与「有网和无网都能手动添加技能包」是同一条要求的两面。
 *
 * 【为什么不用现成的 ClawHubRegistry】
 * 它的信任模型是「作者用私钥签名 zip，应用验签」—— 对**私有/自建仓库**是对的，
 * 但开源技能库没有签名，只有公开的 GitHub 内容。
 * 两者信任模型不同，故分开：**私有仓库走 ClawHubRegistry（签名），开源库走本模块（公开可校验）**。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as https from 'node:https'
import * as http from 'node:http'
import { URL } from 'node:url'
import { getHost } from '../platform/runtime'
import { LogManager } from '../core/LogManager'
import { SkillManager } from './SkillManager'
import { SkillLoader } from './SkillLoader'
import { ConfigStore } from '../core/ConfigStore'

/** 一个开源技能源 */
export interface SkillHubSourceDef {
  /** 源标识(也用于拼装全局唯一 id) */
  id: string
  /** 展示名 */
  name: string
  /** GitHub 仓库 `owner/name` */
  repo: string
  /** 分支 */
  branch: string
  /** 索引文件直链 */
  indexUrl: string
  /** 索引解析方式 */
  kind: 'anthropic-marketplace' | 'shelf-index'
  /** 许可证(展示用) */
  license?: string
  /** 主页 */
  homepage?: string
}

/**
 * 内置源 —— 都是**实测可达**的公开 GitHub 仓库。
 *
 * 【为什么是这两个】
 * - `anthropics/skills`：官方 Agent Skills 示例集，SKILL.md 的 frontmatter
 *   写得极好（description 直接写"Use this skill whenever…"）→ **路由依据最好**，
 *   正好接住 M4-W 量的那件事（选得准不准全看摘要质量）。
 * - `DghostNinja/Skill-Shelf`：社区集，索引里自带 description/tags/category，
 *   覆盖面广，适合"找点新东西"。
 *
 * 【可扩展】用户可在设置里加自己的源（见 `SkillHub.setExtraSources`）。
 */
export const BUILTIN_SKILL_HUB_SOURCES: SkillHubSourceDef[] = [
  {
    id: 'anthropic-skills',
    name: 'Anthropic 官方技能集',
    repo: 'anthropics/skills',
    branch: 'main',
    indexUrl: 'https://raw.githubusercontent.com/anthropics/skills/main/.claude-plugin/marketplace.json',
    kind: 'anthropic-marketplace',
    license: '见各技能目录内的 LICENSE',
    homepage: 'https://github.com/anthropics/skills',
  },
  {
    id: 'skill-shelf',
    name: 'Skill-Shelf 社区技能库',
    repo: 'DghostNinja/Skill-Shelf',
    branch: 'main',
    indexUrl: 'https://raw.githubusercontent.com/DghostNinja/Skill-Shelf/main/index.json',
    kind: 'shelf-index',
    license: '逐技能标注（见索引）',
    homepage: 'https://github.com/DghostNinja/Skill-Shelf',
  },
]

/** 索引里的一条技能 */
export interface SkillHubEntry {
  /** 全局唯一 id:`<源id>:<slug>` */
  id: string
  /** 源 id */
  sourceId: string
  /** 源内标识(安装后的目录名) */
  slug: string
  /** 展示名 */
  name: string
  /** 一句话说明(路由依据) */
  description: string
  /** 分类 */
  category?: string
  /** 标签 */
  tags: string[]
  /** 版本 */
  version?: string
  /** 作者 */
  author?: string
  /** 许可证 */
  license?: string
  /** 日期(索引里有就带) */
  date?: string
  /**
   * 安装形态:
   * - `dir`  —— 源仓库里的一个**目录**（含 SKILL.md + references/ + scripts/）
   * - `file` —— 源仓库里的**单个 md 文件**
   */
  installKind: 'dir' | 'file'
  /** 源仓库内的路径（dir 时是目录，file 时是文件） */
  sourcePath: string
  /** 源仓库主页(展示用) */
  homepage?: string
}

/** 一次索引抓取的结果 */
export interface SkillHubIndex {
  /** 抓取时间 */
  fetchedAt: number
  /** 所有条目 */
  entries: SkillHubEntry[]
  /** 每个源的状态 —— 某个源挂了不影响其它源 */
  sources: Array<{ id: string; name: string; ok: boolean; count: number; error?: string }>
}

/** 搜索/推荐的选项 */
export interface SkillHubQuery {
  /** 关键词 */
  q?: string
  /** 限定源 */
  sourceId?: string
  /** 分类 */
  category?: string
  /** 排除已安装的(默认 true —— 已有的不必再推荐) */
  excludeInstalled?: boolean
  /** 最多返回几条 */
  limit?: number
}

const INDEX_CACHE_FILE = 'skill-hub-index.json'
/** 【M4-AD】用户自建源存这里 */
const EXTRA_SOURCES_KEY = 'skillHub.extraSources'
const FETCH_TIMEOUT_MS = 20_000
/** 并发度 —— GitHub 对匿名 API 有速率限制,别把请求堆上去 */
const CONCURRENCY = 4

export class SkillHub {
  private static instance: SkillHub
  private log = LogManager.getInstance()
  /** 内存里的索引(避免重复读盘) */
  private cached: SkillHubIndex | null = null
  /** 额外源(用户自建) */
  private extraSources: SkillHubSourceDef[] = []

  private constructor() {
    // 【M4-AD】用户自建的源要能跨重启保留 —— 否则每次启动都得重配一遍
    try {
      const saved = ConfigStore.getInstance().get(EXTRA_SOURCES_KEY)
      if (Array.isArray(saved)) {
        this.extraSources = saved.filter(isValidSourceDef)
      }
    } catch (e) {
      this.log.warn('[SkillHub] 读取自定义源失败(按无自定义源处理)', { error: String(e) })
    }
  }

  public static getInstance(): SkillHub {
    if (!SkillHub.instance) SkillHub.instance = new SkillHub()
    return SkillHub.instance
  }

  /** 用户自建的源(追加在内置源之后) */
  public setExtraSources(sources: SkillHubSourceDef[]): void {
    this.extraSources = (sources ?? []).filter(isValidSourceDef)
    this.persistExtraSources()
  }

  /** 列源 —— 内置的只读、自定义的可删 */
  public listSources(): { builtin: SkillHubSourceDef[]; custom: SkillHubSourceDef[] } {
    return { builtin: [...BUILTIN_SKILL_HUB_SOURCES], custom: [...this.extraSources] }
  }

  /**
   * 加一个自定义源。
   *
   * 【为什么要校验】源地址会被**真的去请求** —— 一个写错的 repo/URL
   * 只会让用户看到"拉取失败"，却不知道是自己填错了。校验把错误挡在保存之前。
   * 只收 https:不让配置文件成为任意协议的入口。
   */
  public addExtraSource(input: Partial<SkillHubSourceDef>): { ok: boolean; error?: string; source?: SkillHubSourceDef } {
    const name = String(input.name ?? '').trim()
    const repo = String(input.repo ?? '').trim()
    const branch = String(input.branch ?? '').trim() || 'main'
    const indexUrl = String(input.indexUrl ?? '').trim()
    const kind = input.kind === 'anthropic-marketplace' ? 'anthropic-marketplace' : 'shelf-index'

    if (!name) return { ok: false, error: '名称不能为空' }
    if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) {
      return { ok: false, error: '仓库要写成 owner/name 的形式' }
    }
    if (!/^https:\/\//i.test(indexUrl)) {
      return { ok: false, error: '索引地址必须是 https:// 开头' }
    }

    // id 由名称/仓库派生，保证唯一
    const base = `custom-${(repo.split('/')[1] || name).toLowerCase().replace(/[^a-z0-9._-]/g, '-')}`
    let id = base
    let n = 1
    while (this.getSources().some(s => s.id === id)) id = `${base}-${n++}`

    const source: SkillHubSourceDef = { id, name, repo, branch, indexUrl, kind }
    this.extraSources = [...this.extraSources, source]
    this.persistExtraSources()
    return { ok: true, source }
  }

  /** 删自定义源（内置的删不掉 —— 不是错误，是不支持） */
  public removeExtraSource(id: string): { ok: boolean; error?: string } {
    if (BUILTIN_SKILL_HUB_SOURCES.some(s => s.id === id)) {
      return { ok: false, error: '内置源不能删除' }
    }
    const before = this.extraSources.length
    this.extraSources = this.extraSources.filter(s => s.id !== id)
    if (this.extraSources.length === before) return { ok: false, error: '没有这个自定义源' }
    this.persistExtraSources()
    return { ok: true }
  }

  public getSources(): SkillHubSourceDef[] {
    return [...BUILTIN_SKILL_HUB_SOURCES, ...this.extraSources]
  }

  private persistExtraSources(): void {
    try {
      ConfigStore.getInstance().set(EXTRA_SOURCES_KEY, this.extraSources)
    } catch (e) {
      this.log.warn('[SkillHub] 保存自定义源失败', { error: String(e) })
    }
  }

  /* ─────────────────────────── 索引 ─────────────────────────── */

  /**
   * 拉取所有源的索引并合并。
   *
   * 【单个源失败不影响整体】—— 一个源 404/超时,其余照常返回,
   * 失败的那个在 `sources[]` 里如实标出来。
   */
  public async refresh(): Promise<SkillHubIndex> {
    const sources = this.getSources()
    const results = await runWithConcurrency(sources, CONCURRENCY, async (src) => {
      try {
        const entries = await this.fetchSource(src)
        return { src, entries, ok: true as const }
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e)
        this.log.warn(`[SkillHub] 源 ${src.id} 拉取失败`, { error: err })
        return { src, entries: [] as SkillHubEntry[], ok: false as const, error: err }
      }
    })

    const index: SkillHubIndex = {
      fetchedAt: Date.now(),
      entries: results.flatMap(r => r.entries),
      sources: results.map(r => ({
        id: r.src.id,
        name: r.src.name,
        ok: r.ok,
        count: r.entries.length,
        ...(r.error ? { error: r.error } : {}),
      })),
    }
    this.cached = index
    this.persist(index)
    return index
  }

  /** 读缓存 —— 断网时的搜索/推荐靠它 */
  public getCached(): SkillHubIndex | null {
    if (this.cached) return this.cached
    try {
      const p = this.cachePath()
      if (!fs.existsSync(p)) return null
      const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as SkillHubIndex
      if (!raw || !Array.isArray(raw.entries)) return null
      this.cached = raw
      return raw
    } catch (e) {
      this.log.warn('[SkillHub] 读索引缓存失败', { error: String(e) })
      return null
    }
  }

  /** 索引是否老到该刷新了(默认 6 小时) */
  public isStale(maxAgeMs = 6 * 60 * 60 * 1000): boolean {
    const c = this.getCached()
    if (!c) return true
    return Date.now() - c.fetchedAt > maxAgeMs
  }

  /* ─────────────────────────── 搜索 / 推荐 ─────────────────────────── */

  /**
   * 搜索 —— **纯本地过滤**（索引已在本地），所以断网也能搜。
   *
   * 【匹配范围】名称 / 描述 / 分类 / 标签 —— 名称与描述权重更高
   * （名字命中比描述里出现一次更像是用户要找的）。
   */
  public search(query: SkillHubQuery): SkillHubEntry[] {
    const index = this.getCached()
    if (!index) return []
    const q = (query.q ?? '').trim().toLowerCase()
    const installed = this.installedSkillKeys()

    let out = index.entries.filter(e => {
      if (query.sourceId && e.sourceId !== query.sourceId) return false
      if (query.category && e.category !== query.category) return false
      if (query.excludeInstalled !== false && installed.has(`${e.sourceId}:${e.slug}`)) return false
      if (!q) return true
      const inName = e.name.toLowerCase().includes(q)
      const inDesc = e.description.toLowerCase().includes(q)
      const inTags = e.tags.some(t => t.toLowerCase().includes(q))
      const inCat = (e.category ?? '').toLowerCase().includes(q)
      return inName || inDesc || inTags || inCat
    })

    // 命中权重:名字 > 标签 > 分类 > 描述
    if (q) {
      out = out.sort((a, b) => score(b, q) - score(a, q))
    }
    return out.slice(0, query.limit ?? 50)
  }

  /**
   * 推荐 —— 给用户「这些可以下载」。
   *
   * 【推荐什么、怎么排】
   * ① 已装的**不重复**推荐(用户不需要再下一个已有的)
   * ② 官方源优先于社区源(前者质量与维护更有保障)
   * ③ 同分时新日期优先(技能库更新快,新的更值得试)
   *
   * 【不推荐什么】不含描述的条目 —— 那说明索引里没写清它干什么,
   * 推荐了用户也不知道该不该装。
   */
  public recommend(opts: SkillHubQuery = {}): SkillHubEntry[] {
    const index = this.getCached()
    if (!index) return []
    const installed = this.installedSkillKeys()
    const officialFirst = new Set(BUILTIN_SKILL_HUB_SOURCES.map(s => s.id))

    return index.entries
      .filter(e => {
        if (opts.excludeInstalled !== false && installed.has(`${e.sourceId}:${e.slug}`)) return false
        if (opts.sourceId && e.sourceId !== opts.sourceId) return false
        if (!e.description.trim()) return false
        return true
      })
      .sort((a, b) => {
        const off = Number(officialFirst.has(b.sourceId)) - Number(officialFirst.has(a.sourceId))
        if (off !== 0) return off
        const date = (b.date ?? '').localeCompare(a.date ?? '')
        if (date !== 0) return date
        return b.name.localeCompare(a.name)
      })
      .slice(0, opts.limit ?? 12)
  }

  /* ─────────────────────────── 安装前预览 ─────────────────────────── */

  /**
   * 【M4-AC】列出这个包里**会进来的文件**，并标出其中哪些是**可执行脚本**。
   *
   * 【为什么要有】
   * 用户 2026-11-19 授权「装完整包（含 scripts）」。授权不等于"闭着眼睛装"——
   * 装之前让他看见"这个包会往你的技能目录里放 3 个 .py"，成本几乎为零，
   * 却能让人对"agent 接下来可能会跑什么"有数。
   *
   * 【不做的】不在这一步下载正文、不执行任何东西、不做内容安全判定 ——
   * 只列文件名。判定"这个脚本安不安全"不是本模块能替用户做的。
   */
  public async previewInstall(entry: SkillHubEntry): Promise<{
    ok: boolean
    files?: string[]
    executables?: string[]
    error?: string
  }> {
    try {
      const source = this.getSources().find(s => s.id === entry.sourceId)
      if (!source) return { ok: false, error: `未知来源:${entry.sourceId}` }

      if (entry.installKind === 'file') {
        // 单文件技能只有一份 SKILL.md —— 没有脚本
        return { ok: true, files: [path.basename(entry.sourcePath)], executables: [] }
      }

      const fullPaths = await this.listDirFiles(source, entry.sourcePath)
      const prefix = entry.sourcePath.replace(/\/+$/, '') + '/'
      const rel = fullPaths
        .map(p => (p.startsWith(prefix) ? p.slice(prefix.length) : path.basename(p)))
        .filter(Boolean)
        .sort()
      return { ok: true, files: rel, executables: classifyExecutables(rel) }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  /* ─────────────────────────── 安装 ─────────────────────────── */

  /**
   * 下载并安装一个技能。
   *
   * 【为什么不用 ClawHubRegistry 的 zip+验签】
   * 那是私有仓库的信任模型(作者签名 → 应用验签)。开源库没有签名,
   * 它给的是**公开可校验**的 GitHub 内容 —— 按目录枚举后逐文件取,
   * 拿到的就是上游仓库里那份字节。
   *
   * 【装进去的是什么】
   * 整个目录(SKILL.md + references/ + scripts/ + assets/)——
   * 只装 SKILL.md 会让技能**缺一半**(正文里常写"详见 REFERENCE.md")。
   */
  public async install(entry: SkillHubEntry): Promise<{ ok: boolean; skillId?: string; error?: string }> {
    let targetDir = ''
    try {
      const source = this.getSources().find(s => s.id === entry.sourceId)
      if (!source) return { ok: false, error: `未知来源:${entry.sourceId}` }

      const skillsDir = SkillManager.getSkillsDir()
      targetDir = path.join(skillsDir, this.uniqueSlug(entry.slug))
      fs.mkdirSync(targetDir, { recursive: true })

      if (entry.installKind === 'file') {
        const text = await httpText(this.rawUrl(source, entry.sourcePath))
        fs.writeFileSync(path.join(targetDir, 'SKILL.md'), this.normalizeSkillMd(text, entry), 'utf-8')
      } else {
        const files = await this.listDirFiles(source, entry.sourcePath)
        if (files.length === 0) {
          return { ok: false, error: `源仓库里找不到 ${entry.sourcePath}` }
        }
        const prefix = entry.sourcePath.replace(/\/+$/, '') + '/'
        let written = 0
        await runWithConcurrency(files, CONCURRENCY, async (fullPath) => {
          const content = await httpBuffer(this.rawUrl(source, fullPath))
          // 落到本地时去掉目录前缀 —— 技能目录里就是 SKILL.md + references/ + scripts/
          const rel = fullPath.startsWith(prefix) ? fullPath.slice(prefix.length) : path.basename(fullPath)
          if (!rel) return   // 防御:理论上不会是空
          const dest = path.join(targetDir, rel)
          fs.mkdirSync(path.dirname(dest), { recursive: true })
          fs.writeFileSync(dest, content)
          written++
        })
        if (written === 0) return { ok: false, error: '下载到 0 个文件' }
      }

      return { ok: true, skillId: path.basename(targetDir) }
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e)
      this.log.warn('[SkillHub] 安装失败', { entry: entry.id, error: err })
      // 【清理半成品】下载中途失败会留下一个缺文件的技能目录 ——
      // 那种目录会被 SkillLoader 扫到并加载,但正文/脚本是残缺的,
      // 比"没装"更糟(用户看不出来它不完整)。故失败即清掉。
      try {
        if (targetDir && fs.existsSync(targetDir)) fs.rmSync(targetDir, { recursive: true, force: true })
      } catch { /* 删不掉就算了,不该因此盖掉真正的错误 */ }
      return { ok: false, error: err }
    }
  }

  /* ─────────────────────────── 内部实现 ─────────────────────────── */

  /** 拉一个源的索引并适配成统一形状 */
  private async fetchSource(src: SkillHubSourceDef): Promise<SkillHubEntry[]> {
    if (src.kind === 'shelf-index') return this.fetchShelfIndex(src)
    if (src.kind === 'anthropic-marketplace') return this.fetchAnthropicMarketplace(src)
    return []
  }

  /**
   * Skill-Shelf:`index.json` 自带完整元数据 —— 一次请求就够。
   */
  private async fetchShelfIndex(src: SkillHubSourceDef): Promise<SkillHubEntry[]> {
    const raw = await httpText(src.indexUrl)
    const data = JSON.parse(raw) as { skills?: any[] }
    const list = Array.isArray(data.skills) ? data.skills : []
    return list.map(s => ({
      id: `${src.id}:${s.slug}`,
      sourceId: src.id,
      slug: String(s.slug ?? s.name ?? ''),
      name: String(s.name ?? s.slug ?? ''),
      description: String(s.description ?? ''),
      category: s.category ? String(s.category) : undefined,
      tags: normalizeTags(s.tags),
      version: s.version ? String(s.version) : undefined,
      date: s.date ? String(s.date) : undefined,
      license: s.license ? String(s.license) : undefined,
      installKind: 'file' as const,
      sourcePath: String(s.path ?? ''),
      homepage: src.homepage,
    })).filter(e => e.slug && e.sourcePath)
  }

  /**
   * Anthropic marketplace:`marketplace.json` 只给**插件**与**技能目录路径**,
   * 没有逐技能的描述 —— 而描述正是**路由依据**(M4-W 量的就是这件事)。
   * 故再取一次目录树 + 各技能的 SKILL.md,把 name/description/license 补齐。
   *
   * 【为什么值得多这一次请求】索引缓存一次就长期复用;
   * 换来的是每个技能都有**能用于路由的描述** —— 缺描述的技能装了也不会被选中。
   */
  private async fetchAnthropicMarketplace(src: SkillHubSourceDef): Promise<SkillHubEntry[]> {
    const raw = await httpText(src.indexUrl)
    const data = JSON.parse(raw) as { plugins?: any[] }
    const plugins = Array.isArray(data.plugins) ? data.plugins : []

    const dirs: string[] = []
    for (const p of plugins) {
      const list = Array.isArray(p?.skills) ? p.skills : []
      for (const s of list) {
        const clean = String(s).replace(/^\.\//, '').replace(/\/+$/, '')
        if (clean) dirs.push(clean)
      }
    }
    if (dirs.length === 0) return []

    const results = await runWithConcurrency<string, SkillHubEntry | null>(dirs, CONCURRENCY, async (dir) => {
      try {
        const md = await httpText(this.rawUrl(src, `${dir}/SKILL.md`))
        const fm = parseFrontmatter(md)
        const slug = dir.split('/').pop() ?? dir
        return {
          id: `${src.id}:${slug}`,
          sourceId: src.id,
          slug,
          name: fm.name || slug,
          description: fm.description || '',
          tags: normalizeTags(fm.tags),
          version: fm.version,
          license: fm.license,
          installKind: 'dir' as const,
          sourcePath: dir,
          homepage: src.homepage,
        }
      } catch {
        // 单个技能取不到 → 跳过它(不让一个坏技能毁掉整个源)
        return null
      }
    })
    return results.filter((e): e is SkillHubEntry => e !== null && !!e.description)
  }

  /**
   * 列举源仓库里某目录下的全部文件。
   *
   * 【返回的是仓库内的**完整路径**】
   * 早先这里返回的是"相对该目录的路径",结果拼下载直链时把目录前缀丢了 ——
   * `skills/docx/scripts/x.py` 被请求成 `scripts/x.py` → 404。
   * 故:完整路径用于下载,相对路径在写盘时再算。
   */
  private async listDirFiles(src: SkillHubSourceDef, dir: string): Promise<string[]> {
    const url = `https://api.github.com/repos/${src.repo}/git/trees/${src.branch}?recursive=1`
    const buf = await httpBuffer(url, { accept: 'application/vnd.github+json' })
    const tree = JSON.parse(buf.toString('utf-8')) as { tree?: Array<{ path: string; type: string }> }
    const prefix = dir.replace(/\/+$/, '') + '/'
    return (tree.tree ?? [])
      .filter(t => t.type === 'blob' && t.path.startsWith(prefix))
      .map(t => t.path)
  }

  /** 源仓库里某个路径的 raw 直链 */
  private rawUrl(src: SkillHubSourceDef, p: string): string {
    return `https://raw.githubusercontent.com/${src.repo}/${src.branch}/${p}`
  }

  /**
   * 安装时**归一化** SKILL.md —— 补上 `when_to_use`(路由依据)。
   *
   * 【为什么要补】上游技能的 frontmatter 往往只有 name/description。
   * 本项目的路由依据是 name + description + when_to_use;
   * 缺 when_to_use 不致命,但有 tags/category 时补上能明显提升被选中的概率
   * (M4-W 的结论:摘要质量直接决定选得准不准)。
   */
  private normalizeSkillMd(text: string, entry: SkillHubEntry): string {
    const fm = parseFrontmatter(text)
    const whenToUse = fm.when_to_use || whenToUseFrom(entry)
    if (!whenToUse) return text
    const extra = `\nwhen_to_use: ${whenToUse}\n`
    const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
    if (!m) return text
    return `---${m[1]}${extra}---${text.slice(m[0].length)}`
  }

  /** 已安装技能的键集合(`<源id>:<slug>` 形式) */
  private installedSkillKeys(): Set<string> {
    const keys = new Set<string>()
    try {
      for (const s of SkillLoader.getInstance().getAllSkills()) {
        keys.add(s.id)
        // 已装技能的 id 可能就是 slug(无源前缀)→ 两种键都记上
        for (const src of this.getSources()) {
          keys.add(`${src.id}:${s.id}`)
          keys.add(`${src.id}:${s.name}`)
        }
      }
    } catch {
      // 拿不到就当没装 —— 推荐里顶多多推几条,不会出错
    }
    return keys
  }

  /** slug 撞车时加后缀 */
  private uniqueSlug(slug: string): string {
    const skillsDir = SkillManager.getSkillsDir()
    const safe = slug.replace(/[^a-zA-Z0-9._-]/g, '-').toLowerCase() || 'skill'
    let candidate = safe
    let i = 1
    while (fs.existsSync(path.join(skillsDir, candidate))) {
      candidate = `${safe}-${i++}`
    }
    return candidate
  }

  private cachePath(): string {
    return path.join(getHost().getPath('userData'), INDEX_CACHE_FILE)
  }

  private persist(index: SkillHubIndex): void {
    try {
      const p = this.cachePath()
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, JSON.stringify(index), 'utf-8')
    } catch (e) {
      this.log.warn('[SkillHub] 写索引缓存失败', { error: String(e) })
    }
  }
}

/* ─────────────────────────── 小工具 ─────────────────────────── */

/** 【M4-AD】从配置里读回来的源要做一次形状校验 —— 配置文件可能被手改坏 */
function isValidSourceDef(v: unknown): v is SkillHubSourceDef {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return (
    typeof o.id === 'string' && o.id.length > 0 &&
    typeof o.name === 'string' && o.name.length > 0 &&
    typeof o.repo === 'string' && o.repo.includes('/') &&
    typeof o.branch === 'string' && o.branch.length > 0 &&
    typeof o.indexUrl === 'string' && o.indexUrl.startsWith('https://') &&
    (o.kind === 'shelf-index' || o.kind === 'anthropic-marketplace')
  )
}

/** 关键词命中权重 */
function score(e: SkillHubEntry, q: string): number {
  let s = 0
  if (e.name.toLowerCase().includes(q)) s += 10
  if (e.tags.some(t => t.toLowerCase().includes(q))) s += 5
  if ((e.category ?? '').toLowerCase().includes(q)) s += 3
  if (e.description.toLowerCase().includes(q)) s += 1
  return s
}

/** 并发执行(限流) */
async function runWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await fn(items[index])
    }
  })
  await Promise.all(workers)
  return results
}

/** frontmatter 解析(够用即可:只要几个标量字段) */
export function parseFrontmatter(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) return out
  for (const line of m[1].split(/\r?\n/)) {
    const mm = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/)
    if (!mm) continue
    out[mm[1]] = mm[2].trim().replace(/^['"]|['"]$/g, '')
  }
  return out
}

/**
 * 【M4-AC】从文件列表里挑出"可能会被执行"的那些。
 *
 * 【口径 —— 按扩展名，诚实说明它不完美】
 * agent 会通过 Bash 跑技能目录里的脚本（仍走白名单 + 确认门）。
 * 这里用扩展名判定，**不做内容分析**：
 *   - 认作可执行：.py .sh .bash .ps1 .bat .cmd .js .mjs .cjs .rb .pl .exe
 *   - 不认作可执行：.md .txt .json .yaml .png …
 * 局限：`.sh` 改名成 `.txt` 就躲过去了。所以这是**提示**，不是**保证** ——
 * 真正的执行仍然只有经过 Bash 工具、且通过白名单与确认门才发生。
 */
export function classifyExecutables(files: string[]): string[] {
  const EXEC_EXT = /\.(py|sh|bash|zsh|ps1|bat|cmd|js|mjs|cjs|rb|pl|php|exe|dll|so|dylib)$/i
  return files.filter(f => EXEC_EXT.test(f))
}

/** 标签可能是数组、可能是逗号串 */
function normalizeTags(tags: unknown): string[] {
  if (Array.isArray(tags)) return tags.map(t => String(t).trim()).filter(Boolean)
  if (typeof tags === 'string') {
    const s = tags.trim()
    if (s.startsWith('[')) {
      try {
        const parsed = JSON.parse(s.replace(/'/g, '"'))
        if (Array.isArray(parsed)) return parsed.map(t => String(t).trim()).filter(Boolean)
      } catch { /* 不是合法 JSON → 退回逗号切分 */ }
    }
    return s.split(',').map(t => t.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
  }
  return []
}

/** HTTP 取文本 */
async function httpText(url: string): Promise<string> {
  const buf = await httpBuffer(url)
  return buf.toString('utf-8')
}

/** HTTP 取字节(超时、重定向) */
async function httpBuffer(url: string, headers: Record<string, string> = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doFetch = (u: string, redirects: number): void => {
      const client = u.startsWith('https') ? https : http
      const req = client.get(u, {
        headers: {
          'User-Agent': 'PiPiClaw-SkillHub/1.0',
          ...headers,
        },
      }, res => {
        const status = res.statusCode ?? 0
        if (status >= 300 && status < 400 && res.headers.location && redirects < 5) {
          res.resume()
          doFetch(new URL(res.headers.location, u).toString(), redirects + 1)
          return
        }
        if (status < 200 || status >= 300) {
          res.resume()
          reject(new Error(`HTTP ${status} — ${u}`))
          return
        }
        const chunks: Buffer[] = []
        res.on('data', c => chunks.push(Buffer.from(c)))
        res.on('end', () => resolve(Buffer.concat(chunks)))
      })
      req.setTimeout(FETCH_TIMEOUT_MS, () => {
        req.destroy()
        reject(new Error(`请求超时(${FETCH_TIMEOUT_MS}ms) — ${u}`))
      })
      req.on('error', e => reject(e))
    }
    doFetch(url, 0)
  })
}

/**
 * 由标签/分类合成 when_to_use —— 装技能时补进 frontmatter。
 *
 * 【为什么要补】上游技能的 frontmatter 常只有 name/description。
 * 本项目的路由依据是 name + description + when_to_use;
 * 补上 when_to_use 能明显提升被选中的概率(M4-W 的结论:
 * 摘要质量直接决定 AI 选得准不准)。
 */
function whenToUseFrom(entry: SkillHubEntry): string {
  const parts: string[] = []
  if (entry.category) parts.push(entry.category)
  if (entry.tags.length) parts.push(entry.tags.join('、'))
  return parts.length ? `用户提到${parts.join('、')}` : ''
}
