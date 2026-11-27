/**
 * New World - Agent 5 工具单测 (M1 v0.1)
 *
 * 覆盖: Read / Edit / Bash / Glob / Grep
 * 策略: 用 os.tmpdir() 下建真目录, 然后在 beforeAll 用 vi.spyOn(app, 'getPath') 把 userData 指到那.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as fsSync from 'node:fs'
import * as path from 'node:path'

// 真实测试根目录 = TestHost 指向的共享目录(getHost().getPath('userData') 与此一致,
// 见 tests/unit/electron-setup.ts)。旧版在此 vi.spyOn(app,'getPath') 指向 mkdtemp
// 随机目录,该 spy 因模块陈旧绑定不生效,工具实际落到真 userData,测试文件却在
// 假目录里找文件,Read/Edit/Glob 全挂。
import { TEST_USER_DATA } from './test-host'
const TEST_ROOT = TEST_USER_DATA
const SANDBOX_DIR = path.join(TEST_ROOT, 'sandbox')
const WORKSPACE_DIR = path.join(TEST_ROOT, 'workspace')

import { ReadTool, ReadToolMetadata } from '../../electron/agent/tools/ReadTool'
import { EditTool, EditToolMetadata } from '../../electron/agent/tools/EditTool'
import { BashTool, BashToolMetadata } from '../../electron/agent/tools/BashTool'
import { GlobTool, GlobToolMetadata } from '../../electron/agent/tools/GlobTool'
import { GrepTool, GrepToolMetadata } from '../../electron/agent/tools/GrepTool'
// #005 Step 0 (DEV-014 切除): setCommandContext 模块态已删 — BashTool 用例改显式 execute(ctx) 第二参
//   (裁决要求: 现有测试若依赖模块态注入 → 调用点改显式 ctx, 清单进报告); confirmTransport 注入面保留
import { setConfirmTransport } from '../../electron/agent/tools/commandDecide'

describe('Agent 5 工具 metadata', () => {
  it('Read 工具 schema 正确', () => {
    expect(ReadToolMetadata.name).toBe('Read')
    expect(ReadToolMetadata.requiresPermission).toBe(false)
    expect(ReadToolMetadata.parametersJson.required).toContain('file_path')
  })
  it('Edit 工具 schema 正确', () => {
    expect(EditToolMetadata.name).toBe('Edit')
    expect(EditToolMetadata.requiresPermission).toBe(true)
    expect(EditToolMetadata.parametersJson.required).toEqual(['file_path', 'old_string', 'new_string'])
  })
  it('Bash 工具 schema 正确', () => {
    expect(BashToolMetadata.name).toBe('Bash')
    expect(BashToolMetadata.requiresPermission).toBe(true)
    expect(BashToolMetadata.parametersJson.required).toEqual(['command'])
  })
  it('Glob 工具 schema 正确', () => {
    expect(GlobToolMetadata.name).toBe('Glob')
    expect(GlobToolMetadata.requiresPermission).toBe(false)
  })
  it('Grep 工具 schema 正确', () => {
    expect(GrepToolMetadata.name).toBe('Grep')
    expect(GrepToolMetadata.requiresPermission).toBe(false)
  })
})

describe('ReadTool', () => {
  const tool = new ReadTool()
  beforeEach(async () => {
    await fs.writeFile(path.join(SANDBOX_DIR, 'sample.txt'), 'Hello New World\n第二行\n', 'utf-8')
  })
  afterEach(async () => {
    await fs.rm(path.join(SANDBOX_DIR, 'sample.txt'), { force: true })
  })

  it('读 sandbox 内文件', async () => {
    const r = await tool.execute({ file_path: 'sample.txt' })
    expect(r.ok).toBe(true)
    expect(r.result).toContain('New World')
  })
  it('缺 file_path 报错', async () => {
    const r = await tool.execute({})
    expect(r.ok).toBe(false)
    expect(r.error).toContain('file_path')
  })
  it('文件不存在报错', async () => {
    const r = await tool.execute({ file_path: 'nope.txt' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/不存在|ENOENT/)
  })
  it('路径在 sandbox 外被拒绝 (C:\\Windows)', async () => {
    const r = await tool.execute({ file_path: 'C:\\Windows\\System32\\drivers\\etc\\hosts' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/sandbox|workspace/)
  })
})

describe('EditTool', () => {
  const tool = new EditTool()
  beforeEach(async () => {
    await fs.writeFile(path.join(SANDBOX_DIR, 'edit.txt'), 'name=old\nname=other\n', 'utf-8')
  })
  afterEach(async () => {
    await fs.rm(path.join(SANDBOX_DIR, 'edit.txt'), { force: true })
    await fs.rm(path.join(SANDBOX_DIR, 'edit.txt.bak'), { force: true })
  })

  it('唯一 old_string → 替换成功', async () => {
    const r = await tool.execute({ file_path: 'edit.txt', old_string: 'name=other', new_string: 'name=new' })
    expect(r.ok).toBe(true)
    const content = await fs.readFile(path.join(SANDBOX_DIR, 'edit.txt'), 'utf-8')
    expect(content).toBe('name=old\nname=new\n')
  })
  it('不唯一 → 报错要求 replace_all', async () => {
    await fs.writeFile(path.join(SANDBOX_DIR, 'edit.txt'), 'a\nb\na\n', 'utf-8')
    const r = await tool.execute({ file_path: 'edit.txt', old_string: 'a', new_string: 'X' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/不唯一/)
  })
  it('replace_all=true 全替换', async () => {
    await fs.writeFile(path.join(SANDBOX_DIR, 'edit.txt'), 'a\nb\na\n', 'utf-8')
    const r = await tool.execute({ file_path: 'edit.txt', old_string: 'a', new_string: 'X', replace_all: true })
    expect(r.ok).toBe(true)
    const content = await fs.readFile(path.join(SANDBOX_DIR, 'edit.txt'), 'utf-8')
    expect(content).toBe('X\nb\nX\n')
  })
  it('old_string 不存在 → 报错', async () => {
    const r = await tool.execute({ file_path: 'edit.txt', old_string: 'NOT_THERE', new_string: 'X' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/未找到/)
  })
})

describe('BashTool', () => {
  const tool = new BashTool()

  afterEach(() => {
    // 隔离: 每用例后复原 (confirmTransport stub)
    // #005 Step 0: contextKind 不再走模块态 — 每用例显式传 execute(args, { contextKind })
    setConfirmTransport(null)
  })

  // P1 升级 a: 全链正向 (stub+ui),禁 echo 降级 — 钉"brain→咽喉→确认→执行→审计 humanConfirm='true'"
  it('P1: confirm 级命令 (node) + ctx=ui + stub 允许 → 执行成功 + humanConfirm=true', async () => {
    let approvedRequest: { command: string; args: string[] } | null = null
    setConfirmTransport(async (req) => {
      approvedRequest = { command: req.command, args: req.args }
      return true
    })
    const r = await tool.execute({ command: 'node', args: ['-e', 'console.log(42)'] }, { contextKind: 'ui' })
    expect(r.ok).toBe(true)
    expect(r.result).toContain('exit=0')
    expect(r.result).toContain('42')
    // 钉: stub 真的收到 node 的确认请求 (非被降级换道)
    expect(approvedRequest?.command).toBe('node')
  })

  it('P1b: confirm 级命令 (node) + ctx=headless → 拒 (不弹窗, 执行不了)', async () => {
    const r = await tool.execute({ command: 'node', args: ['-e', 'console.log(1)'] }, { contextKind: 'headless' })
    expect(r.ok).toBe(false)
    // v3 #4: headless 不允许 confirm 级 → 拒 (审计 humanConfirm='false')
    expect(r.error).toMatch(/headless|confirm|ui/)
  })

  // P3 升级 a: stub+ui 全链 + cwd sandbox 沙箱保留断言
  it('P3: confirm 级 (node) + ctx=ui + stub 允许 → cwd 在 sandbox 内能跑', async () => {
    setConfirmTransport(async () => true)
    const r = await tool.execute({ command: 'node', args: ['-e', 'console.log(1)'], cwd: SANDBOX_DIR }, { contextKind: 'ui' })
    expect(r.ok).toBe(true)
    expect(r.result).toContain('exit=0')
  })

  it('P3b: confirm 级 (node) + ctx=ui + stub 允许 → cwd 在 sandbox 外仍被拒 (沙箱红线保留)', async () => {
    setConfirmTransport(async () => true)
    const r = await tool.execute({ command: 'node', args: ['-e', 'console.log(1)'], cwd: 'C:\\Windows' }, { contextKind: 'ui' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/sandbox|workspace/i)
  })

  // P2 (P2-框架接受: null byte → execFile 层拒 = 行为不变, 以实测为准)
  it('P2: args 含 null byte 拒绝', async () => {
    setConfirmTransport(async () => true)
    const r = await tool.execute({ command: 'echo', args: ['safe\u0000evil'] }, { contextKind: 'ui' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/null byte/i)
  })

  it('deny 级命令 (rm) 拒绝 — v3 红线: 未知命令一律 deny', async () => {
    const r = await tool.execute({ command: 'rm', args: ['-rf', '/'] }, { contextKind: 'ui' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/不在自动\/确认名单|denied/i)
  })

  it('shell metacharacter 拒绝', async () => {
    const r = await tool.execute({ command: 'node; echo PWN', args: [] }, { contextKind: 'ui' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/非法字符|metachar/i)
  })
})

describe('GlobTool', () => {
  const tool = new GlobTool()
  beforeEach(async () => {
    await fs.writeFile(path.join(SANDBOX_DIR, 'a.ts'), 'x', 'utf-8')
    await fs.writeFile(path.join(SANDBOX_DIR, 'b.ts'), 'x', 'utf-8')
    await fs.mkdir(path.join(SANDBOX_DIR, 'sub'), { recursive: true })
    await fs.writeFile(path.join(SANDBOX_DIR, 'sub', 'c.vue'), 'x', 'utf-8')
    await fs.writeFile(path.join(SANDBOX_DIR, 'README.md'), 'x', 'utf-8')
  })
  afterEach(async () => {
    await fs.rm(path.join(SANDBOX_DIR, 'a.ts'), { force: true })
    await fs.rm(path.join(SANDBOX_DIR, 'b.ts'), { force: true })
    await fs.rm(path.join(SANDBOX_DIR, 'sub'), { recursive: true, force: true })
    await fs.rm(path.join(SANDBOX_DIR, 'README.md'), { force: true })
  })

  it('**/*.ts 匹配 .ts 文件', async () => {
    const r = await tool.execute({ pattern: '**/*.ts' })
    expect(r.ok).toBe(true)
    expect(r.result).toContain('a.ts')
    expect(r.result).toContain('b.ts')
    expect(r.result).not.toContain('c.vue')
  })
  it('*.vue 匹配根级 .vue', async () => {
    const r = await tool.execute({ pattern: '*.vue' })
    expect(r.ok).toBe(true)
    expect(r.result).toBe('(no matches)')
  })
  it('**/*.vue 跨子目录匹配', async () => {
    const r = await tool.execute({ pattern: '**/*.vue' })
    expect(r.ok).toBe(true)
    expect(r.result).toContain('sub/c.vue')
  })
  it('无匹配返 (no matches)', async () => {
    const r = await tool.execute({ pattern: '**/*.nonexistent' })
    expect(r.ok).toBe(true)
    expect(r.result).toBe('(no matches)')
  })
  it('缺 pattern 报错', async () => {
    const r = await tool.execute({})
    expect(r.ok).toBe(false)
  })
})

describe('GrepTool', () => {
  const tool = new GrepTool()
  beforeEach(async () => {
    await fs.writeFile(path.join(SANDBOX_DIR, 'app.ts'), 'const version = "1.0"\nexport default version\n', 'utf-8')
    await fs.writeFile(path.join(SANDBOX_DIR, 'note.md'), '# New World notes\nversion 1.0 draft\n', 'utf-8')
  })
  afterEach(async () => {
    await fs.rm(path.join(SANDBOX_DIR, 'app.ts'), { force: true })
    await fs.rm(path.join(SANDBOX_DIR, 'note.md'), { force: true })
  })

  it('搜 "version" 在 .ts 里', async () => {
    const r = await tool.execute({ pattern: 'version', include: '*.ts' })
    expect(r.ok).toBe(true)
    expect(r.result).toContain('app.ts:')
  })
  it('ignoreCase 默认 true', async () => {
    const r = await tool.execute({ pattern: 'NEW WORLD', include: '*.md' })
    expect(r.ok).toBe(true)
    expect(r.result).toContain('note.md:')
  })
  it('无匹配返 (no matches)', async () => {
    const r = await tool.execute({ pattern: 'DEFINITELY_NOT_THERE_XXX' })
    expect(r.ok).toBe(true)
    expect(r.result).toBe('(no matches)')
  })
  it('缺 pattern 报错', async () => {
    const r = await tool.execute({})
    expect(r.ok).toBe(false)
  })
})
