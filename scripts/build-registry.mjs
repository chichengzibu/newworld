#!/usr/bin/env node
/**
 * 作者端工具: 把本地技能文件夹打包成 .zip + Ed25519 签名, 写进 registry 的 index.json。
 *
 * 用法:
 *   node scripts/build-registry.mjs \
 *     --skill ./skills/my-skill \
 *     --id my-skill \
 *     --name "My Skill" \
 *     --desc "一句话说明" \
 *     --author "New World Team" \
 *     --category ai \
 *     --tags "web,summary" \
 *     --version 1.0.0 \
 *     --registry ./registry-out \
 *     --key ./scripts/clawhub-dev-ed25519.key
 *
 * 产物:
 *   <registry>/<id>-<version>.zip   (技能包)
 *   <registry>/index.json           (技能清单, 含签名与 zipUrl)
 *
 * zipUrl 默认相对路径 "<id>-<version>.zip"; 发布到远端后把整个 registry 目录
 * 托管到 GitHub Release / raw / 任意 CDN, 用户端填基址即可拉取。
 *
 * 生产: 用自己的 Ed25519 私钥替换 --key, 并确保 App 端 NW_CLAWHUB_PUBKEY
 * (或 userData/clawhub-pubkey.txt) 持有对应公钥。内置开发密钥仅用于联调。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import crypto from 'node:crypto'
import JSZip from 'jszip'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const val = argv[i + 1]?.startsWith('--') ? true : argv[++i]
      out[key] = val
    }
  }
  return out
}

function fail(msg) {
  console.error('❌ ' + msg)
  process.exit(1)
}

const args = parseArgs(process.argv.slice(2))
const skillDir = args.skill
const id = args.id
const name = args.name
const desc = args.desc || ''
const author = args.author || 'New World Team'
const category = args.category || 'ai'
const tags = (args.tags || '').split(',').map((t) => t.trim()).filter(Boolean)
const version = args.version || '1.0.0'
const registryRoot = path.resolve(args.registry || './registry-out')
// 私钥顺序: --key 参数 > NW_CLAWHUB_KEY 环境变量 > 旧位置(scripts/)。
// 私钥已移出工作区到 C:\Users\Administrator\.newworld-secrets\,
// 由用户级环境变量 NW_CLAWHUB_KEY 指向(见 setx,新 shell 生效)。
const keyPath = path.resolve(
  args.key || process.env.NW_CLAWHUB_KEY || path.join(__dirname, 'clawhub-dev-ed25519.key'),
)

if (!skillDir || !id || !name) {
  fail('缺少必填参数: --skill <目录> --id <id> --name <名称>')
}
if (!fs.existsSync(skillDir) || !fs.statSync(skillDir).isDirectory()) {
  fail(`技能目录不存在: ${skillDir}`)
}
if (!fs.existsSync(keyPath)) {
  fail(
    `私钥不存在: ${keyPath}\n` +
      `  优先传 --key <路径>,或设置环境变量 NW_CLAWHUB_KEY 指向私钥文件 ` +
      `(本机已移出工作区: C:\\Users\\Administrator\\.newworld-secrets\\clawhub-dev-ed25519.key)`,
  )
}

// 1) 打 zip: 把 skillDir 内所有文件压进去 (保留相对结构)
const zip = new JSZip()
const walk = (dir, rel) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    const r = rel ? path.join(rel, e.name) : e.name
    if (e.isDirectory()) walk(full, r)
    else zip.file(r, fs.readFileSync(full))
  }
}
walk(skillDir, '')
const zipBuf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })

// 2) 签名: 对 zip 原始字节用 Ed25519 私钥签名 -> hex
const privateKey = crypto.createPrivateKey(fs.readFileSync(keyPath, 'utf-8'))
const signature = crypto.sign(null, zipBuf, privateKey).toString('hex')

// 3) 落盘 zip + 更新 index.json
fs.mkdirSync(registryRoot, { recursive: true })
const zipName = `${id}-${version}.zip`
fs.writeFileSync(path.join(registryRoot, zipName), zipBuf)

const indexPath = path.join(registryRoot, 'index.json')
let index = { registry: 'nw-clawhub', version: 1, updatedAt: Date.now(), skills: [] }
if (fs.existsSync(indexPath)) {
  try {
    index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'))
    index.skills = index.skills || []
  } catch {
    /* 损坏则重建 */
  }
}
const entry = {
  id,
  name,
  description: desc,
  version,
  author,
  category,
  tags,
  zipUrl: zipName, // 相对路径; 远端托管时换成绝对 URL 亦可
  signature,
  changelog: args.changelog || '',
}
const existingIdx = index.skills.findIndex((s) => s.id === id)
if (existingIdx >= 0) index.skills[existingIdx] = entry
else index.skills.push(entry)
index.updatedAt = Date.now()
fs.writeFileSync(indexPath, JSON.stringify(index, null, 2))

console.log(`✅ 已打包并签名: ${zipName}`)
console.log(`   技能: ${name}@${version}  (${zipBuf.length} bytes)`)
console.log(`   签名: ${signature.slice(0, 32)}...`)
console.log(`   index.json 已更新, 共 ${index.skills.length} 个技能`)
console.log(`   发布: 把 ${registryRoot} 整个目录托管到 CDN, 用户端填基址即可拉取`)
