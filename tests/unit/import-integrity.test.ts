/**
 * PiPiClaw — 导入完整性测试（构建断链护栏）
 * ═══════════════════════════════════════════════════════════════
 * 【这个护栏是为哪件事加的】
 * commit 7f6d988「清理无用文件 141 个」删掉了
 *   electron/runtime/actor/{Actor,ActorRegistry}.ts
 *   electron/runtime/conversation/{State,Transition}.ts
 * 而 IpcBridge.ts / Conversation.ts / MessageQueue.ts 仍然 import 它们。
 *
 * 后果:**electron 主进程构建失败**(vite SSR bundle 解析不到),
 * `npm run build` 直接挂 → 应用无法打包。
 * 而这一切:不报运行时错、不让任何单测变红、grep 也能"看到"import 还在。
 *
 * 【为什么这类检查值得单独一个测试】
 * 删文件与改 import 是两次独立的操作,任何单测都覆盖不到它们的**一致性**。
 * 这个测试就是那个一致性检查:全仓扫相对 import,逐个验证能解析。
 *
 * 【为什么之前没人发现】
 * typecheck 有 22 条存量错误(其中 7 条正是断链),但没人把 typecheck 的失败
 * 当成"构建会挂"的信号 —— 直到真去跑一次 npm run build。
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(full)
  }
  return out
}

/** 一个相对 import 能否解析到具体文件 */
function resolves(importer: string, spec: string): boolean {
  const base = path.resolve(path.dirname(importer), spec)
  const candidates = [
    base + '.ts',
    base + '.tsx',
    base + '.d.ts',
    base + '.js',
    base + '.mjs',
    base + '.vue',
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
    path.join(base, 'index.js'),
    path.join(base, 'index.d.ts'),
  ]
  return candidates.some((c) => {
    try { return fs.existsSync(c) && fs.statSync(c).isFile() } catch { return false }
  })
}

/**
 * 去掉注释 —— 否则注释里提到的路径会被当成真 import。
 * (如 platform/index.ts 的文件头注释里写着「请直接 import './platform/runtime'」)
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')      // 块注释
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')   // 行注释(避开 http:// 这种)
}

/**
 * 模板目录不是 importer —— 里面的 import 是**要生成出去的代码文本**,
 * 不是本仓库的依赖。扫它只会得到假警报。
 */
function isTemplateFile(f: string): boolean {
  return f.includes(`${path.sep}sandbox${path.sep}templates${path.sep}`)
}

describe('导入完整性 —— electron 主进程不得有断链', () => {
  it('所有相对 import 都能解析到文件', () => {
    const files = walk(path.join(ROOT, 'electron'))
    const broken: string[] = []

    for (const f of files) {
      if (isTemplateFile(f)) continue
      const raw = fs.readFileSync(f, 'utf-8')
      const src = stripComments(raw)
      for (const m of src.matchAll(/(?:from|import)\s+'(\.[^']+)'/g)) {
        if (!resolves(f, m[1])) {
          const line = raw.slice(0, m.index!).split('\n').length
          broken.push(`${path.relative(ROOT, f)}:${line} → ${m[1]}`)
        }
      }
    }

    expect(
      broken,
      `断链会让 electron 主进程构建失败(npm run build 挂)。修法:补回被删的模块,` +
      `或修正 import 路径。\n${broken.join('\n')}`,
    ).toEqual([])
  })

  it('electron 目录下不残留零字节文件(删除操作留下的空壳)', () => {
    const files = walk(path.join(ROOT, 'electron'))
    const empty = files
      .filter((f) => fs.statSync(f).size === 0)
      .map((f) => path.relative(ROOT, f))
    expect(empty, `零字节文件是删除操作留下的空壳:\n${empty.join('\n')}`).toEqual([])
  })

  it('相对 import 的路径不越出仓库根(防手滑写错 ../ 层级)', () => {
    const files = walk(path.join(ROOT, 'electron'))
    const escaping: string[] = []
    for (const f of files) {
      if (isTemplateFile(f)) continue
      const raw = fs.readFileSync(f, 'utf-8')
      const src = stripComments(raw)
      for (const m of src.matchAll(/from\s+'(\.\.[^']+)'/g)) {
        const resolved = path.resolve(path.dirname(f), m[1])
        if (!resolved.startsWith(ROOT)) {
          const line = raw.slice(0, m.index!).split('\n').length
          escaping.push(`${path.relative(ROOT, f)}:${line} → ${m[1]}`)
        }
      }
    }
    expect(escaping, `相对 import 越出仓库根:\n${escaping.join('\n')}`).toEqual([])
  })
})
