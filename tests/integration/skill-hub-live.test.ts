/**
 * PiPiClaw — 开源技能库实跑（M4-X）
 * ═══════════════════════════════════════════════════════════════════════
 * 【这一批在测什么】
 * 「联网环境下自动去开源技能库寻找以及推荐用户联网下载」——
 * 这件事此前**没有一条能用的路**（ClawHubManager 是本地模拟市场、
 * 「下载」按钮是 stub；ClawHubRegistry 指向 example.com 占位符）。
 *
 * 本文件**接真实网络**验三件事:
 *   ① 能真的把开源技能库的索引拉下来并解析成统一形状
 *   ② 能在索引里**按关键词搜到**技能
 *   ③ 能真的**下载并装进技能目录**,且装完 SkillLoader 能加载到它
 *
 * 【为什么必须实跑】
 * "源可达吗""索引格式对吗""装完能加载吗" —— 这三个问题只有真跑能回答。
 * 单测里的假索引证明不了任何一条。
 *
 * 【怎么跑】
 *   PIPICLAW_SKILL_HUB=1 npx vitest run tests/integration/skill-hub-live.test.ts
 *
 * 【默认不跑】要联网;不显式开启就跳过。
 */
import { describe, it, expect, beforeAll, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { TEST_USER_DATA } from '../unit/test-host'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((k: string) => `${TEST_USER_DATA}/${k}`),
    getName: () => 'pipiclaw',
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

import { SkillHub } from '../../electron/skill/SkillHub'
import { SkillLoader } from '../../electron/skill/SkillLoader'
import { SkillManager } from '../../electron/skill/SkillManager'

const ENABLED = process.env.PIPICLAW_SKILL_HUB === '1'

describe('M4-X 开源技能库实跑', () => {
  beforeAll(() => {
    if (!ENABLED) return
    ;(SkillLoader as any).instance = null
  })

  it('拉索引 → 搜索 → 推荐 → 安装 → 能被加载', async (ctx) => {
    if (!ENABLED) {
      return ctx.skip('[SKIP] 需要联网: PIPICLAW_SKILL_HUB=1')
    }

    const hub = SkillHub.getInstance()

    // ① 索引
    const index = await hub.refresh()
    console.log('\n===== [M4-X 开源技能库] =====')
    for (const s of index.sources) {
      console.log(`  源 ${s.id}: ${s.ok ? '✅' : '❌'} ${s.count} 条${s.error ? ` — ${s.error}` : ''}`)
    }
    console.log(`  合计 ${index.entries.length} 条`)
    expect(index.entries.length).toBeGreaterThan(0)
    // 每个源都应成功(源是内置且实测可达的)
    for (const s of index.sources) {
      expect(s.ok, `源 ${s.id} 拉取失败: ${s.error}`).toBe(true)
      expect(s.count).toBeGreaterThan(0)
    }

    // ② 搜索
    const hits = hub.search({ q: 'pdf', limit: 10 })
    console.log(`  搜 "pdf" → ${hits.length} 条: ${hits.slice(0, 3).map(h => h.name).join(' / ')}`)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.some(h => /pdf/i.test(h.name) || /pdf/i.test(h.description))).toBe(true)

    // ③ 推荐
    const recos = hub.recommend({ limit: 5 })
    console.log(`  推荐 ${recos.length} 条: ${recos.map(r => r.name).join(' / ')}`)
    expect(recos.length).toBeGreaterThan(0)
    // 推荐里的每条都得有描述 —— 没描述的推荐了用户也不知道该不该装
    for (const r of recos) expect(r.description.trim().length).toBeGreaterThan(0)

    // ④ 安装(挑第一个目录型条目 —— 它带 references/scripts,最能验完整性)
    const target = index.entries.find(e => e.installKind === 'dir' && /pdf/i.test(e.name + e.description))
      ?? index.entries.find(e => e.installKind === 'dir')
    expect(target, '索引里没有目录型条目').toBeTruthy()
    // 【M4-AC】安装前预览 —— 真的列得出包内文件吗
    const pv = await hub.previewInstall(target!)
    expect(pv.ok, `预览失败: ${pv.error}`).toBe(true)
    console.log(`  预览: ${pv.files?.length ?? 0} 个文件，其中可执行 ${pv.executables?.length ?? 0} 个`)
    if ((pv.executables?.length ?? 0) > 0) {
      console.log(`    可执行: ${(pv.executables ?? []).slice(0, 5).join(', ')}${(pv.executables?.length ?? 0) > 5 ? ' …' : ''}`)
    }
    expect(pv.files?.length ?? 0).toBeGreaterThan(0)
    expect((pv.files ?? []).some(f => /SKILL\.md$/i.test(f))).toBe(true)

    console.log(`  安装 ${target!.id} (${target!.slug}) …`)
    const res = await hub.install(target!)
    console.log(`  → ${res.ok ? '✅' : '❌'} ${res.skillId ?? res.error}`)
    expect(res.ok, `安装失败: ${res.error}`).toBe(true)
    expect(res.skillId).toBeTruthy()

    // 装完的文件真的在磁盘上
    const skillDir = path.join(SkillManager.getSkillsDir(), res.skillId!)
    expect(fs.existsSync(skillDir)).toBe(true)
    expect(fs.existsSync(path.join(skillDir, 'SKILL.md'))).toBe(true)
    const md = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8')
    expect(md).toContain('name:')

    // ⑤ SkillLoader 能加载到它(否则装了等于没装)
    SkillLoader.getInstance().reloadSkills()
    const loaded = SkillLoader.getInstance().getSkill(res.skillId!)
    expect(loaded, 'SkillLoader 没加载到刚装的技能').toBeTruthy()
    expect(loaded!.description.length).toBeGreaterThan(0)
    console.log(`  已加载: ${loaded!.name} — ${loaded!.description.slice(0, 60)}`)

    // ⑥ 断网也能搜(索引已缓存)
    const cached = hub.getCached()
    expect(cached).toBeTruthy()
    expect(cached!.entries.length).toBeGreaterThan(0)
  }, 600_000)
})
