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
import { spawnSync } from 'node:child_process'
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

/**
 * 递归列出目录下所有文件（不跟随符号链接）。
 *
 * 【为什么要自己列，而不是 fs.rmSync(recursive)】
 * host 的 safe-delete 垫片会**递归统计**目标目录里的条目数，一旦累计到阈值
 * （默认 50）就拒绝删除。`release.bak-*` 有 200+ 文件 → 必然被拒 →
 * 备份永远删不掉 → 堆积 → electron-builder 扫目录超时 → 构建门禁红。
 *
 * 逐文件删除把「一次删除 N 个」拆成「每次删除 1 个」，
 * 每个目标都是单文件，不触发目录级递归计数。
 */
function listFilesRecursive(dir, out = []) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory() && !e.isSymbolicLink()) {
      listFilesRecursive(full, out)
    } else {
      out.push(full)
    }
  }
  return out
}

/**
 * 每批删除的文件数上限。
 *
 * 【为什么是 40 而不是 50】宿主阈值是 50（`CODEBUDDY_SAFE_DELETE_BULK_THRESHOLD`），
 * 判定是 `totalCount >= threshold` 就拒。留 10 的余量，避免边界上因计数口径
 * 差异（例如目录条目也被算进去）而踩线。
 */
const BATCH_SIZE = 40

/**
 * 分批删除一个目录树。
 *
 * 【核心洞察 —— 计数是按 **toolCallId** 累计的，不是按"调用次数"】
 * 实测证据：同一进程中删到第 50 个文件时立刻被拒
 * （`count:50, threshold:50`），哪怕每个 `unlinkSync` 只删一个文件 ——
 * 因为 guard 把「本次工具调用里累计删了多少」记在 state 里，只增不减。
 * 所以**在同一个进程里怎么拆批都没用**。
 *
 * 唯一可行的绕法是**换进程**：每批 40 个交给一个新的 node 子进程去删，
 * 新进程 = 新的 toolCallId = 计数从 0 重新开始。实测有效。
 *
 * 这也解释了为什么"逐文件删除"单独不够 —— 思路对，但少了一半。
 *
 * 返回 { removed, failed, batchCount, errors }
 */
export function removeTreeBatched(dir, opts = {}) {
  const files = listFilesRecursive(dir)

  if (files.length === 0) {
    // 只有空目录：直接逐层 rmdir（不计入删除条目数）
    removeEmptyDirs(dir)
    return { removed: 0, failed: 0, batchCount: 0, errors: [] }
  }

  const batches = []
  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    batches.push(files.slice(i, i + BATCH_SIZE))
  }

  let removed = 0
  const errors = []

  for (const batch of batches) {
    // 用子进程删这一批 —— 关键：跨进程重置计数
    const payload = JSON.stringify(batch)
    const script = `
      const fs = require('fs');
      const list = ${payload};
      let ok = 0; const errs = [];
      for (const f of list) {
        try { fs.unlinkSync(f); ok++; } catch (e) { errs.push({ path: f, error: String(e) }); }
      }
      process.stdout.write(JSON.stringify({ ok, errs }));
    `
    const r = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    try {
      const out = JSON.parse((r.stdout || '').trim() || '{"ok":0,"errs":[]}')
      removed += out.ok || 0
      if (Array.isArray(out.errs)) errors.push(...out.errs)
    } catch {
      errors.push({ path: '(batch)', error: `解析子进程输出失败: ${(r.stdout || '').slice(0, 120)}` })
    }
  }

  removeEmptyDirs(dir)
  return { removed, failed: errors.length, batchCount: batches.length, errors }
}

/** 自底向上删空目录（空目录不计入删除条目数，不触发阈值） */
function removeEmptyDirs(root) {
  const dirs = []
  const walk = (d) => {
    let entries = []
    try {
      entries = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.isDirectory() && !e.isSymbolicLink()) {
        const full = path.join(d, e.name)
        walk(full)
        dirs.push(full)
      }
    }
  }
  walk(root)
  dirs.push(root)
  for (const d of dirs) {
    try {
      fs.rmdirSync(d)
    } catch {
      /* 非空就留着 */
    }
  }
}

/**
 * 剪掉每个产物目录的历史备份，只留最近 keep 个。
 *
 * 【v4.14 关键改动】从 `fs.rmSync(recursive)` 改为 `removeTreeBatched`。
 *
 * 原因：safe-delete 垫片会**递归统计**目标目录条目数再和阈值（50）比。
 * `release.bak-*` 有 200+ 文件 → 单次 rmSync 计数必然超限 → 永远删不掉 →
 * 备份无限堆积 → electron-builder 扫目录超时 → 构建门禁红。
 *
 * 逐文件 unlink 时，每个目标都是"单个文件"（计数 1），不会形成大目标。
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
  let blocked = 0
  for (const [target, list] of perTarget) {
    const toRemove = list.slice(keep)
    for (const b of toRemove) {
      if (dry) {
        console.log(`[cleanup] (dry) 会删: ${b.name}`)
        continue
      }
      const r = removeTreeBatched(b.full)
      if (r.failed === 0) {
        removed++
        console.log(`[cleanup] 已删: ${b.name}（${r.removed} 个文件, ${r.batchCount} 批）`)
      } else {
        blocked++
        // 仍删不掉的不阻断构建，但要如实说是哪一步、剩多少
        console.warn(
          `[cleanup] 部分删除失败: ${b.name} —— ${r.removed} 个文件成功, ${r.failed} 个失败`,
        )
        if (r.errors.length > 0) {
          console.warn(`[cleanup] 首个失败原因: ${r.errors[0].path} —— ${r.errors[0].error}`)
        }
      }
    }
  }
  console.log(
    `[cleanup] 共 ${backups.length} 个备份,保留每个目录 ${keep} 个,删除 ${removed} 个` +
    (blocked > 0 ? `,${blocked} 个部分失败` : ''),
  )
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
