#!/usr/bin/env node
/**
 * PiPiClaw — 构建备份清理
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
 * 用法:
 *   node scripts/cleanup-build-backups.mjs          # 每个目录只留最近 1 个
 *   node scripts/cleanup-build-backups.mjs --keep 0 # 全删
 *   node scripts/cleanup-build-backups.mjs --dry    # 只列不删
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 只处理这三个产物目录的备份 */
const TARGETS = ['dist', 'dist-electron', 'release']
/** 名字必须严格是 `<target>.bak-<纯数字>` */
const BACKUP_RE = /^(dist|dist-electron|release)\.bak-\d+$/

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
const backups = listBackups()
if (!backups.length) {
  console.log('[cleanup] 没有构建备份目录,无需清理')
  process.exit(0)
}

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
