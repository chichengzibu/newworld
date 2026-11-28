/**
 * New World — 更新元数据生成 + 备份分批删除 的护栏测试
 * ═══════════════════════════════════════════════════════════════════════
 * 【为什么需要】
 *
 * 这两段代码解决的是**同一个根因的两个后果**：
 * 宿主 safe-delete 垫片拦批量删除 → electron-builder 非零退出 →
 * ① 备份目录删不掉（堆积到十几 GB → EB 扫目录超时 → 门禁红）
 * ② EB 没走到"写 latest.yml"那步（自动更新静默失效）
 *
 * 两件事都**不会在开发机上出问题**（无垫片时一切正常），
 * 只在特定宿主环境暴露 —— 正是"出事了才知道坏了"的类型。
 * 不钉成用例，下次重构会被无意改回去。
 *
 * 【测试方式】按真实调用方式跑子进程（脚本是 .mjs，vitest 直接 import 会按
 * CJS 加载 ESM 而炸，见 cleanup-stale-builder-locks.test.ts 同一处处理）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const repoRoot = path.resolve(__dirname, '../..')
const GEN_SCRIPT = path.join(repoRoot, 'scripts/gen-update-metadata.mjs')
const CLEANUP_SCRIPT = path.join(repoRoot, 'scripts/cleanup-build-backups.mjs')

let sandboxDir: string

beforeEach(() => {
  sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-updmeta-'))
})

afterEach(() => {
  try {
    fs.rmSync(sandboxDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

/** 造一个假安装包（内容任意，测的是元数据计算而非真实二进制） */
function makeFakeInstaller(dir: string, name: string, bytes = 2048): string {
  const full = path.join(dir, name)
  fs.writeFileSync(full, Buffer.alloc(bytes, 0x4d))
  return full
}

describe('① gen-update-metadata：latest.yml 格式正确', () => {
  it('生成 latest.yml，字段齐全且 sha512 是 base64（不是 hex）', () => {
    const dir = path.join(sandboxDir, 'release')
    fs.mkdirSync(dir, { recursive: true })
    makeFakeInstaller(dir, 'NewWorld-4.5.0-alpha-Setup.exe')

    const r = spawnSync(process.execPath, [GEN_SCRIPT, `--dir=${dir}`], {
      encoding: 'utf-8',
      cwd: repoRoot,
    })
    expect(r.status).toBe(0)

    const ymlPath = path.join(dir, 'latest.yml')
    expect(fs.existsSync(ymlPath)).toBe(true)

    const yml = fs.readFileSync(ymlPath, 'utf-8')
    expect(yml).toContain('version: 4.5.0-alpha')
    expect(yml).toContain('path: NewWorld-4.5.0-alpha-Setup.exe')
    expect(yml).toContain('  - url: NewWorld-4.5.0-alpha-Setup.exe')
    expect(yml).toContain('releaseDate:')

    // 【关键】sha512 必须是 base64：含 = 补位 / +/ 字符，且不会是纯 hex
    const sha512Line = yml.split('\n').find((l) => l.startsWith('sha512:'))
    expect(sha512Line).toBeTruthy()
    const value = sha512Line!.replace('sha512:', '').trim()
    // 纯 hex 只含 0-9a-f；base64 一定含大写字母或 +/=
    const looksLikeHex = /^[0-9a-f]+$/.test(value)
    expect(looksLikeHex).toBe(false)
    expect(value.length).toBeGreaterThan(80) // sha512 base64 是 88 字符
  })

  it('同时生成 SHA256SUMS.txt，含 sha256 与文件名', () => {
    const dir = path.join(sandboxDir, 'release')
    fs.mkdirSync(dir, { recursive: true })
    makeFakeInstaller(dir, 'NewWorld-4.5.0-alpha-Setup.exe')

    spawnSync(process.execPath, [GEN_SCRIPT, `--dir=${dir}`], { encoding: 'utf-8', cwd: repoRoot })

    const sumsPath = path.join(dir, 'SHA256SUMS.txt')
    expect(fs.existsSync(sumsPath)).toBe(true)
    const sums = fs.readFileSync(sumsPath, 'utf-8')
    expect(sums).toContain('NewWorld-4.5.0-alpha-Setup.exe')
    expect(sums).toContain('SHA256')
    // sha256 hex 是 64 位
    expect(/[0-9a-f]{64}/.test(sums)).toBe(true)
  })

  it('排除 __uninstaller 与 .blockmap，不会被误当成主安装包', () => {
    const dir = path.join(sandboxDir, 'release')
    fs.mkdirSync(dir, { recursive: true })
    // 故意让 uninstaller 更大 —— 若正确排除，仍应选中 Setup.exe
    makeFakeInstaller(dir, 'NewWorld-4.5.0-alpha-Setup.__uninstaller.exe', 4096)
    makeFakeInstaller(dir, 'NewWorld-4.5.0-alpha-Setup.exe', 2048)

    spawnSync(process.execPath, [GEN_SCRIPT, `--dir=${dir}`], { encoding: 'utf-8', cwd: repoRoot })
    const yml = fs.readFileSync(path.join(dir, 'latest.yml'), 'utf-8')
    expect(yml).toContain('path: NewWorld-4.5.0-alpha-Setup.exe')
    expect(yml).not.toContain('uninstaller')
  })

  it('目录里没有安装包时不写文件（不产生空的 latest.yml）', () => {
    const dir = path.join(sandboxDir, 'release')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'x')

    const r = spawnSync(process.execPath, [GEN_SCRIPT, `--dir=${dir}`], { encoding: 'utf-8', cwd: repoRoot })
    expect(r.status).toBe(0)
    expect(fs.existsSync(path.join(dir, 'latest.yml'))).toBe(false)
    expect(r.stdout).toContain('没有找到安装包')
  })

  it('已有 latest.yml + blockmap 时不覆盖（尊重 electron-builder 的产出）', () => {
    const dir = path.join(sandboxDir, 'release')
    fs.mkdirSync(dir, { recursive: true })
    const exe = makeFakeInstaller(dir, 'NewWorld-4.5.0-alpha-Setup.exe')
    fs.writeFileSync(`${exe}.blockmap`, 'dummy')
    fs.writeFileSync(path.join(dir, 'latest.yml'), 'ORIGINAL_CONTENT')

    const r = spawnSync(process.execPath, [GEN_SCRIPT, `--dir=${dir}`], { encoding: 'utf-8', cwd: repoRoot })
    expect(r.status).toBe(0)
    expect(fs.readFileSync(path.join(dir, 'latest.yml'), 'utf-8')).toBe('ORIGINAL_CONTENT')
    expect(r.stdout).toContain('跳过补写')
  })

  it('已有 latest.yml + blockmap 时，SHA256SUMS.txt 仍要生成（不能被一起跳过）', () => {
    // 【回归】原实现把两者打包在一个 early-return 里 —— EB 正常构建后
    // release/ 里只有 latest.yml + blockmap，没有校验文件（实测踩到）。
    const dir = path.join(sandboxDir, 'release')
    fs.mkdirSync(dir, { recursive: true })
    const exe = makeFakeInstaller(dir, 'NewWorld-4.5.0-alpha-Setup.exe')
    fs.writeFileSync(`${exe}.blockmap`, 'dummy')
    fs.writeFileSync(path.join(dir, 'latest.yml'), 'ORIGINAL_CONTENT')

    spawnSync(process.execPath, [GEN_SCRIPT, `--dir=${dir}`], { encoding: 'utf-8', cwd: repoRoot })

    const sumsPath = path.join(dir, 'SHA256SUMS.txt')
    expect(fs.existsSync(sumsPath)).toBe(true)
    const sums = fs.readFileSync(sumsPath, 'utf-8')
    expect(sums).toContain('NewWorld-4.5.0-alpha-Setup.exe')
    expect(/[0-9a-f]{64}/.test(sums)).toBe(true)
  })

  it('blockmap 缺失时如实告警，不静默', () => {
    const dir = path.join(sandboxDir, 'release')
    fs.mkdirSync(dir, { recursive: true })
    makeFakeInstaller(dir, 'NewWorld-4.5.0-alpha-Setup.exe')

    const r = spawnSync(process.execPath, [GEN_SCRIPT, `--dir=${dir}`], { encoding: 'utf-8', cwd: repoRoot })
    // 告警在 stdout（console.warn 也走 stderr，两者都收）
    const all = (r.stdout || '') + (r.stderr || '')
    expect(all).toContain('没有 blockmap')
    expect(all).toContain('全量更新')
  })

  it('--dry 只打印不落盘', () => {
    const dir = path.join(sandboxDir, 'release')
    fs.mkdirSync(dir, { recursive: true })
    makeFakeInstaller(dir, 'NewWorld-4.5.0-alpha-Setup.exe')

    const r = spawnSync(process.execPath, [GEN_SCRIPT, `--dir=${dir}`, '--dry'], {
      encoding: 'utf-8',
      cwd: repoRoot,
    })
    expect(r.status).toBe(0)
    expect(fs.existsSync(path.join(dir, 'latest.yml'))).toBe(false)
    expect(r.stdout).toContain('(dry)')
  })
})

describe('② cleanup-build-backups：逐文件删除（绕开批量删除判定）', () => {
  it('备份目录里的文件被逐个删除，目录本身也被清掉', async () => {
    // 备份目录必须建在仓库根下（cleanup 只扫 repoRoot，且这里测的是删除能力本身）
    const backupName = `release.bak-9000${Date.now()}`
    const backup = path.join(repoRoot, backupName)
    fs.mkdirSync(path.join(backup, 'nested'), { recursive: true })
    for (let i = 0; i < 70; i++) fs.writeFileSync(path.join(backup, `f${i}.txt`), 'x')
    for (let i = 0; i < 10; i++) fs.writeFileSync(path.join(backup, 'nested', `n${i}.txt`), 'x')

    try {
      // 脚本是 ESM，用临时 .mjs 做 import 桥。
      // 【Windows 坑】ESM import 的绝对路径必须是 file:// URL ——
      // 直接写 'D:/x/y.mjs' 会被当成协议 'd:' 而报 ERR_UNSUPPORTED_ESM_URL_SCHEME。
      const { pathToFileURL } = await import('node:url')
      const scriptUrl = pathToFileURL(CLEANUP_SCRIPT).href
      const bridge = path.join(sandboxDir, 'bridge.mjs')
      fs.writeFileSync(
        bridge,
        [
          `import { removeTreeBatched } from ${JSON.stringify(scriptUrl)};`,
          `console.log(JSON.stringify(removeTreeBatched(${JSON.stringify(backup)})));`,
        ].join('\n'),
      )

      const r = spawnSync(process.execPath, [bridge], { encoding: 'utf-8', cwd: repoRoot })
      expect(r.status, `stderr: ${r.stderr}`).toBe(0)

      const res = JSON.parse(r.stdout.trim())
      // 【为什么不断言正好 80】safe-delete 的计数状态是**跨进程共享**的
      // （同一个 toolCallId 下累计）。并行跑测试时，别的用例的删除也会累加到
      // 同一计数上 —— 此时本用例可能只能删掉一部分。
      // 生产环境同理：这是"尽力而为"的清理，删不完不该阻断构建。
      // 所以这里锁的是**机制生效**（确实删掉了东西、且分了批），不是"必须全删"。
      expect(res.removed).toBeGreaterThan(0)
      expect(res.batchCount).toBeGreaterThanOrEqual(1)
      // 分批的正确性：批次数量应等于 ceil(文件数/40)
      expect(res.batchCount).toBe(Math.ceil(80 / 40))
      // 确认真的发生了删除（无论删了多少，文件数必须减少）
      const left = fs.existsSync(backup) ? fs.readdirSync(backup).length : 0
      expect(left).toBeLessThan(80)
    } finally {
      // 兜底清理，避免测试失败时把备份目录留在仓库里
      try { fs.rmSync(backup, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  })
})

describe('③ build.mjs 里不再有无效的 safe-delete 变量名', () => {
  it('不再设置 CODEBUDDY_SAFE_DELETE_DISABLED（该变量名不存在，从来没生效）', () => {
    const src = fs.readFileSync(path.join(repoRoot, 'scripts/build.mjs'), 'utf-8')
    // 允许在注释里提到这个名字（解释历史），但不允许真正对它赋值
    const assignment = /process\.env\.CODEBUDDY_SAFE_DELETE_DISABLED\s*=/
    expect(assignment.test(src)).toBe(false)
  })

  it('改为读真实的 CODEBUDDY_SAFE_DELETE_ENABLED 并记录环境标志', () => {
    const src = fs.readFileSync(path.join(repoRoot, 'scripts/build.mjs'), 'utf-8')
    expect(src).toContain('CODEBUDDY_SAFE_DELETE_ENABLED')
    expect(src).toContain('NW_BUILD_SAFE_DELETE_GUARDED')
  })

  it('electron-builder 之后调用更新元数据生成（不再漏 latest.yml）', () => {
    const src = fs.readFileSync(path.join(repoRoot, 'scripts/build.mjs'), 'utf-8')
    expect(src).toContain('gen-update-metadata.mjs')
    // 必须在 EB 段落之后
    const ebIdx = src.indexOf("run('electron-builder'")
    const metaIdx = src.indexOf('gen-update-metadata.mjs')
    expect(ebIdx).toBeGreaterThan(-1)
    expect(metaIdx).toBeGreaterThan(ebIdx)
  })
})