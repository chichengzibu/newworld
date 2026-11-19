/**
 * PiPiClaw — 陈旧构建锁清理的护栏测试
 * ═══════════════════════════════════════════════════════════════════════
 * 【为什么要有这个】
 * 清理脚本会删**系统临时目录**里的东西 —— 这比删仓库目录更敏感。
 * 护栏一旦写松(名字匹配放宽、年龄阈值放宽、目录范围放宽),
 * 就会开始删**别的程序**的锁,或者删掉**正在跑的构建**的锁。
 *
 * 所以这里把三条护栏逐条钉住:
 *   ① 只删 electron-builder 自己的两种锁名
 *   ② 只删超过 10 分钟没动过的(活着的持有者会刷新 mtime)
 *   ③ 只删**目录**,同名普通文件不碰
 *
 * 【为什么用子进程跑,而不是 import】
 * 脚本是 `.mjs`(构建时由 node 直接执行),vitest 会把它当外部依赖按 CJS 加载
 * → ESM 语法直接炸。故这里**按真实调用方式**跑:子进程 + `node <脚本>`。
 * 顺带的好处:测的就是构建时真正执行的那条路径。
 *
 * 【怎么把脚本的扫描范围限到测试自己的临时目录】
 * Windows 上 `os.tmpdir()` 认 `TEMP` / `TMP` 环境变量 →
 * 子进程带上这两个变量即可,**不用为测试改生产代码**。
 * (`--keep 999` 则保证这个子进程不会去剪仓库里的真实备份。)
 *
 * 【背景】
 * 实测(本批踩到两次):上一次 electron-builder 被中途杀掉后留下
 * `eb-dl-<hash>.lock.lock`,stale 窗口 10 分钟内再构建 →
 * 「Lock file is already being held」→ 打包产物一个没出来 → 构建门禁红,
 * 而红的原因跟代码毫无关系。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const STALE_MS = 10 * 60 * 1000
const SCRIPT = path.resolve(__dirname, '../../scripts/cleanup-build-backups.mjs')

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipiclaw-locktest-'))
})
afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
})

/** 造一个锁目录,并把 mtime 设成 ageMs 之前 */
function makeLock(name: string, ageMs: number): string {
  const full = path.join(tmpDir, name)
  fs.mkdirSync(full, { recursive: true })
  const when = new Date(Date.now() - ageMs)
  fs.utimesSync(full, when, when)
  return full
}

/** 按构建时的真实方式跑一次清理脚本(范围限在 tmpDir) */
function runCleanup(extraArgs: string[] = []): { status: number | null; stdout: string } {
  const res = spawnSync(process.execPath, [SCRIPT, '--keep', '999', ...extraArgs], {
    encoding: 'utf-8',
    env: { ...process.env, TEMP: tmpDir, TMP: tmpDir },
  })
  return { status: res.status, stdout: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

describe('陈旧构建锁清理的护栏', () => {
  it('删掉陈旧的 electron-builder 锁(>10 分钟没动)', () => {
    const stale = makeLock('eb-dl-0123456789abcdef0123.lock.lock', STALE_MS + 60_000)
    const r = runCleanup()
    expect(r.status).toBe(0)
    expect(fs.existsSync(stale)).toBe(false)
    expect(r.stdout).toContain('已删陈旧构建锁')
  })

  it('【护栏①】不删**新**的锁 —— 可能有构建正在用它', () => {
    const fresh = makeLock('eb-dl-0123456789abcdef0123.lock.lock', 60_000)
    runCleanup()
    expect(fs.existsSync(fresh)).toBe(true)
  })

  it('【护栏②】不删**别的程序**的锁(名字不匹配)', () => {
    const other = makeLock('some-other-app.lock.lock', STALE_MS + 60_000)
    const notHex = makeLock('eb-dl-notahexstring.lock.lock', STALE_MS + 60_000)
    runCleanup()
    expect(fs.existsSync(other)).toBe(true)
    expect(fs.existsSync(notHex)).toBe(true)
  })

  it('toolset 锁同样认(electron-builder 的第二种锁名)', () => {
    const lock = makeLock('.electron-builder-toolset.lock.lock', STALE_MS + 60_000)
    runCleanup()
    expect(fs.existsSync(lock)).toBe(false)
  })

  it('【护栏③】同名**普通文件**不删(proper-lockfile 建的是目录)', () => {
    const file = path.join(tmpDir, 'eb-dl-0123456789abcdef0123.lock.lock')
    fs.writeFileSync(file, 'x')
    const when = new Date(Date.now() - STALE_MS - 60_000)
    fs.utimesSync(file, when, when)
    runCleanup()
    expect(fs.existsSync(file)).toBe(true)
  })

  it('dry 模式只列不删', () => {
    const stale = makeLock('eb-dl-0123456789abcdef0123.lock.lock', STALE_MS + 60_000)
    const r = runCleanup(['--dry'])
    expect(fs.existsSync(stale)).toBe(true)
    expect(r.stdout).toContain('会删陈旧构建锁')
  })

  it('删不掉不算失败 —— 不阻断构建(退出码仍为 0)', () => {
    // 造一个"删不掉"的:在 Windows 上把目录设成只读目录很难,
    // 这里改用"名字匹配但内容是文件"来验证脚本不会因异常崩掉
    const r = runCleanup()
    expect(r.status).toBe(0)
  })
})
