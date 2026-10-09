/**
 * PiPiClaw test:e2e launcher
 *
 * 职责(顺序):
 *  1. 把 PLAYWRIGHT_BROWSERS_PATH 钉为 '0'(官方约定:解析到项目本地
 *     node_modules/playwright-core 兄弟目录,浏览器随仓库可复现,
 *     不依赖用户全局缓存 —— 全局缓存会被清理,见验收条件3)
 *  2. 起纯前端 vite dev server(vite.config.e2e.mts,不带 Electron)
 *  3. 轮询 / 直至 ready
 *  4. 跑 vitest(config: vitest.e2e.config.ts)
 *  5. 无论成败都收掉 vite,退出码透传 vitest
 *
 * 为何不用 vitest 的 test.webServer:
 *  vitest 1.6.1 在 `run` 模式下 webServer 未可靠拉起(社区已知行为),
 *  实测 dev server 不监听 → 全例 ERR_CONNECTION_REFUSED。自托管最稳。
 *
 * 浏览器缺失时的行为(验收条件3):
 *  vitest 内 chromium.launch() 抛错 → 用例 failed → 退出码非 0,响亮报错。
 *
 * 用法: npm run test:e2e   (等价 node scripts/test-e2e.mjs)
 */
import { spawn, spawnSync } from 'node:child_process'
import process from 'node:process'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { existsSync } from 'node:fs'

process.env.PLAYWRIGHT_BROWSERS_PATH = '0'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 4173
// 注意:本机 vite 监听 IPv6 ::1 而非 127.0.0.1(已实测),
// 必须用 'localhost'(Node http 与 Chromium 均会走 Happy Eyeballs 落到 ::1)
const BASE = `http://localhost:${PORT}`

function log(msg) {
  console.log('[test:e2e] ' + msg)
}

function waitReady(base, timeoutMs) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(base + '/', (res) => {
        res.resume()
        resolve()
      })
      req.on('error', () => {
        if (Date.now() - started > timeoutMs) {
          reject(new Error(`dev server 未在 ${timeoutMs}ms 内就绪 (${base})`))
        } else {
          setTimeout(tick, 300)
        }
      })
    }
    tick()
  })
}

const viteBin = path.join(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js')
const vitestEntry = path.join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs')
if (!existsSync(viteBin) || !existsSync(vitestEntry)) {
  console.error('[test:e2e] 缺少本地 vite/vitest — 先 npm install')
  process.exit(2)
}

let viteProc = null
try {
  // 1. 起 dev server(纯前端,vite 配置已排除 electron 插件)
  viteProc = spawn(process.execPath, [viteBin, '--config', 'vite.config.e2e.mts', '--port', String(PORT), '--strictPort'], {
    cwd: repoRoot,
    // 让 vite 的启动日志可见,排障友好
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: '0' },
  })
  viteProc.stdout.on('data', (d) => {
    const s = d.toString()
    if (s.includes('ready') || s.includes('Local:') || s.includes('error')) process.stdout.write(s)
  })
  viteProc.stderr.on('data', (d) => process.stderr.write(d))
  viteProc.on('error', (e) => {
    console.error('[test:e2e] vite 启动失败: ' + e.message)
    process.exit(2)
  })

  // 2. 等 ready
  try {
    await waitReady(BASE, 60000)
  } catch (e) {
    console.error(' ' + e.message)
    process.exit(2)
  }

  // 3. 跑 vitest
  const r = spawnSync(process.execPath, [vitestEntry, 'run', '--config', 'vitest.e2e.config.ts'], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: '0' },
  })
  if (r.error) {
    console.error('  spawn vitest 失败: ' + r.error.message)
    process.exit(2)
  }
  // 4. 透传退出码(浏览器缺失 → chromium.launch throw → 用例 failed → 非 0)
  process.exitCode = r.status === null ? 1 : r.status
} finally {
  // 5. 收掉 vite
  if (viteProc) {
    try {
      viteProc.kill('SIGKILL')
    } catch {
      /* ignore */
    }
  }
}
