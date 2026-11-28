#!/usr/bin/env node
/**
 * New World — 生成 electron-updater 的更新元数据
 * ═══════════════════════════════════════════════════════════════════════
 * 【为什么需要这个脚本】
 *
 * electron-builder 在**正常退出**时会自己产出 `latest.yml` 与 `*.blockmap`
 * ——前者是 autoupdate 的版本描述，后者支持增量下载。
 *
 * 但在本环境下，EB 最后一步会去删临时文件 `*.Setup.__uninstaller.exe`，
 * 被宿主 safe-delete 垫片拦下（`SAFE_DELETE_BULK_CONFIRM_REQUIRED`），
 * 进程以 `failedTask=build` 非零退出 —— **产物已经生成了，但 EB 没走到
 * "写更新元数据"那一步**，于是 latest.yml / blockmap 根本没有。
 *
 * 后果（实测）：
 *   · 手动下载安装没问题 → 用户不觉得有事
 *   · **自动更新静默失效** → 去拉一个不存在的 latest.yml / 拿不到 blockmap →
 *     每次都得重下完整安装包（98MB），或干脆不更新
 *   · 而且用户端没有任何报错，你根本收不到反馈
 *
 * `build.mjs` 原先只按"产物存在"判成功，够用但不完整 —— 产物齐了、
 * 更新链路还是断的。这个脚本补的就是那一步。
 *
 * ─────────────────────────────────────────────────────────────────
 * 【latest.yml 的字段是怎么来的】
 *
 * electron-updater 读的格式（以 NSIS 为例）：
 * ```yaml
 * version: 4.5.0-alpha
 * files:
 *   - url: NewWorld-4.5.0-alpha-Setup.exe
 *     sha512: <base64>
 *     size: <bytes>
 * path: NewWorld-4.5.0-alpha-Setup.exe
 * sha512: <base64>
 * releaseDate: '2026-...'
 * ```
 * `sha512` 是 **base64**（不是 hex），这一点很容易写错 —— 写错的话
 * updater 校验失败会直接报「下载文件损坏」，比没有元数据更难查。
 *
 * 【blockmap 的取舍 —— 这里不做，只如实说明】
 * `.blockmap` 是 electron-builder 内部的分块索引格式（含 block size、
 * 每块 hash、压缩信息），**不是随手能算出来的**：它是 EB 在打包过程中
 * 顺带记录的分块信息，事后无法从 exe 反推（exe 是 NSIS 压缩过的）。
 * 所以本脚本只生成 latest.yml，blockmap 缺失时如实打印提示 ——
 * 增量更新退化为全量更新（每次重下完整包），功能可用但费流量。
 *
 * 想真正拿回 blockmap，唯一的路是让 EB 正常走完最后一步 ——
 * 那需要解决 safe-delete 拦截，属于宿主环境问题，不在代码能力范围内。
 *
 * 用法:
 *   node scripts/gen-update-metadata.mjs                 # 默认 release/
 *   node scripts/gen-update-metadata.mjs --dir=<path>    # 指定产物目录
 *   node scripts/gen-update-metadata.mjs --dry           # 只检查不写
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** electron-updater 只认这些安装包后缀（按优先级） */
const INSTALLER_EXTS = ['.exe', '.dmg', '.AppImage', '.deb']

function parseArgs() {
  const args = process.argv.slice(2)
  const dirArg = args.find((a) => a.startsWith('--dir='))
  return {
    dir: dirArg ? dirArg.slice('--dir='.length) : 'release',
    dry: args.includes('--dry'),
  }
}

function readVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf-8'))
    return String(pkg.version ?? '')
  } catch {
    return ''
  }
}

/** 在产物目录里找主安装包（排除 __uninstaller、blockmap、辅助文件） */
function findInstaller(dirAbs) {
  let names = []
  try {
    names = fs.readdirSync(dirAbs)
  } catch {
    return null
  }
  const candidates = names.filter((n) => {
    const lower = n.toLowerCase()
    if (!INSTALLER_EXTS.some((ext) => lower.endsWith(ext))) return false
    if (lower.includes('uninstaller')) return false
    if (lower.includes('.blockmap')) return false
    return true
  })
  if (candidates.length === 0) return null

  // 多个候选时取最大的（主安装包必然比零散辅助文件大）
  let best = null
  for (const name of candidates) {
    const full = path.join(dirAbs, name)
    let size = 0
    try { size = fs.statSync(full).size } catch { continue }
    if (!best || size > best.size) best = { name, full, size }
  }
  return best
}

/**
 * 计算 sha512 → **base64**。
 * 注意：electron-updater 用的是 base64，不是 hex。
 * 用 hex 会让 updater 在下载后校验失败，报「文件已损坏」。
 */
function sha512Base64(filePath) {
  const hash = crypto.createHash('sha512')
  const buf = fs.readFileSync(filePath)
  hash.update(buf)
  return hash.digest('base64')
}

function sha256Hex(filePath) {
  const hash = crypto.createHash('sha256')
  hash.update(fs.readFileSync(filePath))
  return hash.digest('hex')
}

/** 生成 latest.yml 文本（字段顺序与 electron-builder 一致，便于对照） */
export function buildLatestYml({ version, fileName, sha512, size, releaseDate }) {
  return [
    `version: ${version}`,
    'files:',
    `  - url: ${fileName}`,
    `    sha512: ${sha512}`,
    `    size: ${size}`,
    `path: ${fileName}`,
    `sha512: ${sha512}`,
    `releaseDate: '${releaseDate}'`,
    '',
  ].join('\n')
}

/** 生成 SHA256SUMS.txt（人工校验用；与 latest.yml 的 sha512 互不替代） */
export function buildSha256Sums({ fileName, sha256 }) {
  return [
    '# SHA256 校验值',
    '',
    '本版本未进行代码签名。Windows 首次运行可能提示「未知发布者」，',
    '这是未签名软件的预期行为，不表示文件有问题。',
    '',
    '校验方式：',
    '  Windows:     Get-FileHash <文件名> -Algorithm SHA256',
    '  macOS/Linux: shasum -a 256 <文件名>',
    '',
    '如果校验值与本文件一致，说明下载完整且未被篡改。',
    '',
    `${sha256}  ${fileName}`,
    '',
  ].join('\n')
}

function main() {
  const { dir, dry } = parseArgs()
  const dirAbs = path.isAbsolute(dir) ? dir : path.join(repoRoot, dir)

  const installer = findInstaller(dirAbs)
  if (!installer) {
    console.log(`[update-meta] ${dir}/ 下没有找到安装包，跳过生成更新元数据`)
    return
  }

  const version = readVersion()
  if (!version) {
    console.warn('[update-meta] package.json 里读不到 version，跳过')
    return
  }

  const latestPath = path.join(dirAbs, 'latest.yml')
  const sumsPath = path.join(dirAbs, 'SHA256SUMS.txt')
  const blockmapPath = `${installer.full}.blockmap`

  const hasBlockmap = fs.existsSync(blockmapPath)
  const alreadyHasLatest = fs.existsSync(latestPath)

  /**
   * 【v4.14 修】SHA256SUMS.txt 必须**无条件**生成 —— 它跟 latest.yml 无关。
   *
   * 原实现把两者打包在一个 early-return 里：只要 EB 自己产出了 latest.yml
   * 就整段跳过，结果 SHA256SUMS.txt 根本没生成（实测踩到：EB 正常构建后
   * release/ 里只有 latest.yml + blockmap，没有校验文件）。
   * 两者用途不同：latest.yml 给 updater 读，SHA256SUMS 给人核对下载完整性。
   */
  const sha256 = sha256Hex(installer.full)
  const sums = buildSha256Sums({ fileName: installer.name, sha256 })
  if (!dry) {
    fs.writeFileSync(sumsPath, sums, 'utf-8')
    console.log(`[update-meta] ✓ 已写 SHA256SUMS.txt`)
    console.log(`[update-meta]   sha256: ${sha256}`)
  }

  if (alreadyHasLatest && hasBlockmap) {
    // electron-builder 自己产出了 —— 不覆盖它的结果（它的 blockmap 索引更权威）
    console.log(`[update-meta] latest.yml 与 blockmap 已由 electron-builder 生成，跳过补写`)
    return
  }

  const sha512 = sha512Base64(installer.full)
  const releaseDate = new Date().toISOString()

  const yml = buildLatestYml({
    version,
    fileName: installer.name,
    sha512,
    size: installer.size,
    releaseDate,
  })

  if (dry) {
    console.log(`[update-meta] (dry) 会写 latest.yml:\n${yml}`)
    return
  }

  fs.writeFileSync(latestPath, yml, 'utf-8')

  console.log(`[update-meta] ✓ 已补写 latest.yml（${installer.name}, ${(installer.size / 1048576).toFixed(1)}MB）`)

  if (!hasBlockmap) {
    console.warn(
      '[update-meta] ⚠ 没有 blockmap —— electron-builder 最后一步被 safe-delete 拦截,' +
      '未走到生成分块索引那步。',
    )
    console.warn(
      '              影响：增量更新退化为全量更新（每次重下完整安装包）。功能可用，只是费流量。',
    )
    console.warn(
      '              blockmap 无法事后从 exe 反推（NSIS 压缩过），需让 EB 正常走完最后一步才能拿到。',
    )
  }
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  main()
}