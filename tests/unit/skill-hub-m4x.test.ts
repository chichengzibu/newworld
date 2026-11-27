/**
 * New World — 开源技能库的离线逻辑（M4-X）
 * ═══════════════════════════════════════════════════════════════════════
 * 【这一批在测什么】
 * SkillHub 里**不联网**的那部分：索引解析、搜索、推荐、frontmatter 归一化。
 * 这些是断网时唯一还能用的能力 —— 索引缓存下来，搜索与推荐必须照常工作。
 *
 * 【为什么不联网测】
 * 联网的部分由 tests/integration/skill-hub-live.test.ts 实跑覆盖
 * （源可达吗 / 索引格式对吗 / 装完能加载吗）。
 * 本文件只钉**纯逻辑**，进 CI 不烧算力、不依赖网络。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { TEST_USER_DATA } from '../unit/test-host'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((k: string) => `${TEST_USER_DATA}/${k}`),
    getName: () => 'newworld',
    getVersion: () => '4.5.0',
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn((s: string) => Buffer.from(s, 'utf-8')),
    decryptString: vi.fn((b: Buffer) => b.toString('utf-8')),
  },
}))
vi.mock('electron-log', () => ({
  default: {
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
    transports: { file: { resolvePathFn: () => {}, maxSize: 0, format: '' }, console: { level: 'info' } },
  },
}))

import { SkillHub, parseFrontmatter, classifyExecutables, type SkillHubEntry, type SkillHubIndex } from '../../electron/skill/SkillHub'

const entry = (over: Partial<SkillHubEntry> = {}): SkillHubEntry => ({
  id: 'src:slug',
  sourceId: 'src',
  slug: 'slug',
  name: '名字',
  description: '描述',
  tags: [],
  installKind: 'file',
  sourcePath: 'skills/x.md',
  ...over,
})

describe('M4-X 开源技能库 · 离线逻辑', () => {
  let hub: SkillHub

  beforeEach(async () => {
    const { SkillHub: Hub } = await import('../../electron/skill/SkillHub')
    hub = Hub.getInstance()
    // 塞一份假索引进缓存(不联网)
    const index: SkillHubIndex = {
      fetchedAt: Date.now(),
      entries: [
        entry({ id: 'a:pdf', sourceId: 'a', slug: 'pdf', name: 'PDF 工具', description: '处理 PDF 文件与表格', tags: ['pdf', '文档'], category: '文档' }),
        entry({ id: 'a:xlsx', sourceId: 'a', slug: 'xlsx', name: '表格处理', description: '读 Excel 并做汇总', tags: ['excel'], category: '文档' }),
        entry({ id: 'b:appsec', sourceId: 'b', slug: 'appsec', name: '安全审查', description: '审查 Web 应用安全漏洞', tags: ['security'], category: '安全' }),
      ],
      sources: [{ id: 'a', name: '源 A', ok: true, count: 2 }],
    }
    ;(hub as any).cached = index
  })

  it('搜索:关键词命中名称/描述/标签/分类', () => {
    expect(hub.search({ q: 'pdf' }).map(e => e.slug)).toContain('pdf')
    expect(hub.search({ q: 'excel' }).map(e => e.slug)).toContain('xlsx')
    expect(hub.search({ q: '漏洞' }).map(e => e.slug)).toContain('appsec')
    expect(hub.search({ q: '安全' }).map(e => e.slug)).toContain('appsec')
  })

  it('搜索:名称命中排在描述命中前面', () => {
    const res = hub.search({ q: 'pdf' })
    // 'pdf' 命中的是名称与标签,权重更高
    expect(res[0].slug).toBe('pdf')
  })

  it('搜索:限定源 / 限定分类', () => {
    expect(hub.search({ sourceId: 'b' }).map(e => e.slug)).toEqual(['appsec'])
    expect(hub.search({ category: '文档' }).map(e => e.slug).sort()).toEqual(['pdf', 'xlsx'])
  })

  it('搜索:空关键词返回全部(受 limit 约束)', () => {
    expect(hub.search({}).length).toBe(3)
    expect(hub.search({ limit: 2 }).length).toBe(2)
  })

  it('推荐:不含没有描述的条目(推荐了用户也不知道该不该装)', () => {
    ;(hub as any).cached = {
      fetchedAt: Date.now(),
      entries: [
        ...(hub as any).cached.entries,
        entry({ id: 'a:nodesc', sourceId: 'a', slug: 'nodesc', name: '没描述', description: '' }),
      ],
      sources: [],
    }
    const recos = hub.recommend()
    expect(recos.map(e => e.slug)).not.toContain('nodesc')
  })

  it('推荐:可限量', () => {
    expect(hub.recommend({ limit: 2 }).length).toBe(2)
  })

  it('【P1 生态入口】推荐:评分作为质量信号参与排序(官方优先不变, 缺失当 0)', () => {
    ;(hub as any).cached = {
      fetchedAt: Date.now(),
      entries: [
        entry({ id: 'b:hot', sourceId: 'b', slug: 'hot', name: '高分社区技能', description: '有评分', rating: 4.8, date: '2026-01-01' }),
        entry({ id: 'b:cold', sourceId: 'b', slug: 'cold', name: '低分社区技能', description: '有评分', rating: 2.1, date: '2026-11-01' }),
        // 用真实官方源 id(officialFirst 集合来自 BUILTIN_SKILL_HUB_SOURCES)
        entry({ id: 'anthropic-skills:official', sourceId: 'anthropic-skills', slug: 'official', name: '官方技能', description: '无评分' }),
      ],
      sources: [],
    }
    const recos = hub.recommend()
    expect(recos[0].sourceId).toBe('anthropic-skills')  // 官方源仍优先
    expect(recos[1].slug).toBe('hot')          // 社区源内:4.8 压过 2.1(即使日期更旧)
    expect(recos[2].slug).toBe('cold')
  })

  it('【P1 生态入口】元数据缺失不编造: entry 只有真实评分字段时才带数字', () => {
    const withRating = entry({ rating: 4.5, downloads: 1200 })
    expect(withRating.rating).toBe(4.5)
    expect(withRating.downloads).toBe(1200)
    const without = entry()
    expect(without.rating).toBeUndefined()
    expect(without.downloads).toBeUndefined()
  })

  it('缓存:没有索引时搜索返回空(而不是抛错)', async () => {
    const fresh = await import('../../electron/skill/SkillHub')
    ;(fresh.SkillHub.getInstance() as any).cached = null
    // 磁盘上也没有缓存文件 → 应返回空数组而不是崩
    expect(fresh.SkillHub.getInstance().search({ q: 'pdf' })).toEqual([])
  })

  it('frontmatter:解析标量字段', () => {
    const fm = parseFrontmatter([
      '---',
      'name: pdf',
      'description: 处理 PDF',
      'when_to_use: 用户提到 PDF 时',
      '---',
      '正文',
    ].join('\n'))
    expect(fm.name).toBe('pdf')
    expect(fm.description).toBe('处理 PDF')
    expect(fm.when_to_use).toBe('用户提到 PDF 时')
  })

  it('frontmatter:没有 frontmatter 时返回空(不抛)', () => {
    expect(parseFrontmatter('直接是正文')).toEqual({})
  })

  describe('M4-AD 自定义源管理', () => {
    const validInput = {
      name: '我的团队库',
      repo: 'acme/skills',
      branch: 'main',
      indexUrl: 'https://raw.githubusercontent.com/acme/skills/main/index.json',
      kind: 'shelf-index' as const,
    }

    it('添加合法源 → 出现在自定义列表里,id 不与内置冲突', () => {
      hub.setExtraSources([])
      const r = hub.addExtraSource(validInput)
      expect(r.ok).toBe(true)
      const custom = hub.listSources().custom
      expect(custom.map(x => x.name)).toContain('我的团队库')
      expect(custom[0].id.startsWith('custom-')).toBe(true)
    })

    it('重复添加同名仓库 → id 自动去重', () => {
      hub.setExtraSources([])
      hub.addExtraSource(validInput)
      hub.addExtraSource(validInput)
      const ids = hub.listSources().custom.map(x => x.id)
      expect(new Set(ids).size).toBe(2)
    })

    it('【校验】仓库要写成 owner/name', () => {
      expect(hub.addExtraSource({ ...validInput, repo: '没有斜杠' }).ok).toBe(false)
      expect(hub.addExtraSource({ ...validInput, repo: 'a/b/c' }).ok).toBe(false)
    })

    it('【校验】索引地址必须 https://', () => {
      const r = hub.addExtraSource({ ...validInput, indexUrl: 'http://insecure/x.json' })
      expect(r.ok).toBe(false)
      expect(r.error).toContain('https')
    })

    it('【校验】名称不能为空', () => {
      expect(hub.addExtraSource({ ...validInput, name: '   ' }).ok).toBe(false)
    })

    it('内置源不能删；自定义源可以删', () => {
      hub.setExtraSources([])
      expect(hub.removeExtraSource('anthropic-skills').ok).toBe(false)
      const added = hub.addExtraSource(validInput)
      expect(added.ok).toBe(true)
      expect(hub.removeExtraSource(added.source!.id).ok).toBe(true)
      expect(hub.listSources().custom).toHaveLength(0)
    })

    it('添加会落盘(重启后还在)', async () => {
      hub.setExtraSources([])
      hub.addExtraSource(validInput)
      const { ConfigStore } = await import('../../electron/core/ConfigStore')
      const saved = ConfigStore.getInstance().get('skillHub.extraSources')
      expect(Array.isArray(saved)).toBe(true)
      expect((saved as any[]).some(x => x.name === '我的团队库')).toBe(true)
    })

    it('读回来的坏配置会被过滤掉(配置文件可能被手改坏)', async () => {
      const { ConfigStore } = await import('../../electron/core/ConfigStore')
      ConfigStore.getInstance().set('skillHub.extraSources', [
        { id: 'ok', name: 'x', repo: 'a/b', branch: 'main', indexUrl: 'https://e/x.json', kind: 'shelf-index' },
        { id: 'bad', name: 'y' },
        null,
      ])
      // 重新构造一个实例(绕开单例)来模拟"重启后加载"
      const { SkillHub: Hub } = await import('../../electron/skill/SkillHub')
      const fresh = new (Hub as any)()
      expect(fresh.listSources().custom).toHaveLength(1)
      expect(fresh.listSources().custom[0].id).toBe('ok')
    })
  })

  describe('M4-AC 安装前预览:可执行文件分类', () => {
    it('按扩展名挑出"会被执行"的文件', () => {
      const files = ['SKILL.md', 'scripts/a.py', 'scripts/b.sh', 'refs/c.md', 'run.bat', 'tool.PS1', 'data.json']
      expect(classifyExecutables(files)).toEqual(['scripts/a.py', 'scripts/b.sh', 'run.bat', 'tool.PS1'])
    })

    it('只有文档时返回空 —— 不该吓唬用户', () => {
      expect(classifyExecutables(['SKILL.md', 'REFERENCE.md', 'logo.png'])).toEqual([])
    })

    it('空列表返回空', () => {
      expect(classifyExecutables([])).toEqual([])
    })
  })
})
