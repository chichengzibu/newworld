#!/usr/bin/env node
/**
 * New World — 构建备份清理
 * ═══════════════════════════════════════════════════════════════════════
 * 【为什么需要】
 * `scripts/build.mjs` 的 moveAside() 每次构建把旧产物**改名**成
 * `<dir>.bak-<时间戳>`(改名是为了绕开 Windows safe-delete 的「批量删除确认」),
 * 但**从不清旧的** → 一次构建留 3 个备份(`dist` / `dist-electron` / `release`),
 * 而 `release` 一个就 ~466MB。
 *
 * 实测:连续构建十几次后仓库根目录堆了 **36 个备份目录、十几 GB** →
 * electron-builder 扫目录超时 → 「未找到打包产物(release/ 下无 exe/app)」→
 * **构建门禁失败**。
 *
 * 【安全护栏】
 * 只删**仓库根目录下**、且名字严格匹配 `<dist|dist-electron|release>.bak-<纯数字>`
 * 的目录 —— 别的名字一律不碰。
 *
 * ─────────────────────────────────────────────────────────────────
 * 【第二件事:清理 electron-builder 的陈旧临时锁】
 *
 * 现象(实测本批踩到两次):上一次 electron-builder 被**中途杀掉**(超时/中断)后,
 * 会在系统临时目录留下 `eb-dl-<hash>.lock.lock` 锁目录。
 * electron-builder 用 `proper-lockfile` 加锁,stale 窗口是 **10 分钟**;
 * 在这 10 分钟内再跑构建 → `⨯ Lock file is already being held`
 * → 打包产物一个都没出来 → 「未找到打包产物(release/ 下无 exe/app)」
 * → **构建门禁红**,而红的原因跟代码**毫无关系**。
 *
 * 护栏(与 proper-lockfile 自己的陈旧判定同一条线,不更激进):
 * ① 只在**系统临时目录**里找
 * ② 只认 electron-builder 自己的两种锁名:
 *    `eb-dl-<20位十六进制>.lock.lock` 与 `.electron-builder-toolset.lock.lock`
 * ③ **只删 mtime 超过 10 分钟的** —— 活着的持有者会持续刷新 mtime,
 *    10 分钟没动过的就是没人要的了(proper-lockfile 自己也这么判陈旧)
 * ④ 删不掉不算失败 —— 不阻断构建
 *
 * 用法:
 *   node scripts/cleanup-build-backups.mjs          # 每个目录只留最近 1 个
 *   node scripts/cleanup-build-backups.mjs --keep 0 # 全删
 *   node scripts/cleanup-build-backups.mjs --dry    # 只列不删
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 只处理这三个产物目录的备份 */
const TARGETS = ['dist', 'dist-electron', 'release']
/** 名字必须严格是 `<target>.bak-<纯数字>` */
const BACKUP_RE = /^(dist|dist-electron|release)\.bak-\d+$/

/**
 * electron-builder 的陈旧锁 —— 只认它自己起的这两种名字。
 *
 * `eb-dl-<key>.lock` 是 @electron/get 下载产物时加的锁,
 * proper-lockfile 会在它旁边建 `<target>.lock` **目录**,
 * 于是磁盘上看到的是 `eb-dl-<key>.lock.lock`。
 */
const STALE_LOCK_RE = /^(eb-dl-[0-9a-f]{20}\.lock|\.electron-builder-toolset\.lock)\.lock$/
/**
 * 陈旧阈值 —— 与 proper-lockfile 的 `stale` 选项一致(10 分钟)。
 * 活着的持有者会持续刷新 mtime,所以这个阈值不会误伤在跑的构建。
 */
const STALE_LOCK_MS = 10 * 60 * 1000

function parseArgs() {
  const args = process.argv.slice(2)
  const keepIdx = args.indexOf('--keep')
  const keep = keepIdx >= 0 ? Number(args[keepIdx + 1]) : 1
  return { keep: Number.isFinite(keep) ? keep : 1, dry: args.includes('--dry') }
}

function listBackups() {
  const found = []
  let entries = []
  try {
    entries = fs.readdirSync(repoRoot, { withFileTypes: true })
  } catch {
    return found
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    if (!BACKUP_RE.test(e.name)) continue
    const full = path.join(repoRoot, e.name)
    let mtime = 0
    try { mtime = fs.statSync(full).mtimeMs } catch { /* ignore */ }
    found.push({ name: e.name, full, mtime })
  }
  // 新的在前
  found.sort((a, b) => b.mtime - a.mtime)
  return found
}

const { keep, dry } = parseArgs()

/**
 * 剪掉每个产物目录的历史备份,只留最近 keep 个。
 */
export function cleanupBackups(backups, keep, dry) {
  // 每个 target 保留最近 keep 个,其余删掉
  const perTarget = new Map()
  for (const b of backups) {
    const target = b.name.replace(/\.bak-\d+$/, '')
    const list = perTarget.get(target) ?? []
    list.push(b)
    perTarget.set(target, list)
  }

  let removed = 0
  for (const [target, list] of perTarget) {
    const toRemove = list.slice(keep)
    for (const b of toRemove) {
      if (dry) {
        console.log(`[cleanup] (dry) 会删: ${b.name}`)
        continue
      }
      try {
        fs.rmSync(b.full, { recursive: true, force: true })
        removed++
        console.log(`[cleanup] 已删: ${b.name}`)
      } catch (err) {
        // 删不掉不算失败(可能被 safe-delete 拦着)—— 不阻断构建
        console.warn(`[cleanup] 删不掉(忽略): ${b.name} —— ${String(err)}`)
      }
    }
  }
  console.log(`[cleanup] 共 ${backups.length} 个备份,保留每个目录 ${keep} 个,删除 ${removed} 个`)
}

/**
 * 清掉 electron-builder 留下的**陈旧**临时锁。
 *
 * 【为什么只删"陈旧"的】
 * 锁是给并发构建用的:两个构建同时跑,第二个要等第一个。
 * 活着的持有者会持续刷新锁目录的 mtime(proper-lockfile 的心跳),
 * 所以"mtime 超过 10 分钟没动"= 没人要这个锁了 —— 判定口径与
 * proper-lockfile 自己的 stale 完全一致,不会误删在跑的构建的锁。
 */
export function cleanupStaleBuilderLocks(dry, tmpDir = os.tmpdir(), now = Date.now()) {
  const tmp = tmpDir
  let entries = []
  try {
    entries = fs.readdirSync(tmp, { withFileTypes: true })
  } catch {
    return
  }
  let removed = 0
  for (const e of entries) {
    if (!e.isDirectory()) continue
    if (!STALE_LOCK_RE.test(e.name)) continue
    const full = path.join(tmp, e.name)
    let mtime = 0
    try { mtime = fs.statSync(full).mtimeMs } catch { /* ignore */ }
    if (now - mtime < STALE_LOCK_MS) continue   // 还很新 —— 可能有人在用
    if (dry) {
      console.log(`[cleanup] (dry) 会删陈旧构建锁: ${e.name}`)
      continue
    }
    try {
      fs.rmSync(full, { recursive: true, force: true })
      removed++
      console.log(`[cleanup] 已删陈旧构建锁: ${e.name}`)
    } catch (err) {
      // 删不掉不算失败 —— 不阻断构建
      console.warn(`[cleanup] 删不掉陈旧构建锁(忽略): ${e.name} —— ${String(err)}`)
    }
  }
  if (removed > 0) {
    console.log(`[cleanup] 共删除 ${removed} 个陈旧 electron-builder 临时锁`)
  }
}

/**
 * 入口 —— 只在**直接运行**时执行(被 import 时不跑,好让单测能验护栏)。
 */
function main() {
  const { keep, dry } = parseArgs()
  const backups = listBackups()
  if (backups.length) {
    cleanupBackups(backups, keep, dry)
  } else {
    console.log('[cleanup] 没有构建备份目录,无需清理')
  }
  cleanupStaleBuilderLocks(dry)
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  main()
  process.exit(0)
}
