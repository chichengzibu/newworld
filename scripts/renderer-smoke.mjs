/**
 * scripts/renderer-smoke.mjs
 * Renderer 无头冒烟测试 (Playwright + 静态服务 dist)。
 *
 * 目标: 在脱离 Electron 主进程 / 无显示器的环境下, 验证渲染端最关键的问题 ——
 *   Element Plus 组件 (el-dropdown / el-scrollbar / el-checkbox 等) 是否已被
 *   ElementPlusResolver 正确解析为组件, 而不是降级成原生 HTML 标签
 *   (表现为浏览器控制台刷 "Failed to resolve component: el-dropdown")。
 *
 * 做法:
 *   1. 起一个本地静态 server 服务 dist/ (index.html 用绝对路径 /assets/*)
 *   2. 用 chromium 无头加载, 注入 mock window.electronAPI (桩) 避免 IPC 缺失导致 App 崩
 *   3. 收集 console error/warning, 过滤出组件解析类报错
 *   4. 断言: 无 "Failed to resolve component" / 裸 "el-dropdown" 等 → PASS
 *
 * 注意: 这仅验证 renderer 模板编译 / resolver 是否生效, 不含 Electron main / preload。
 *       真实交互 (DevPanel / 虚拟滚动手感) 仍需用户在本地 npm run dev 肉眼确认。
 */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const DIST = path.resolve(process.cwd(), 'dist');
if (!fs.existsSync(DIST)) {
  console.error('✘ dist 不存在, 请先运行构建 (node scripts/build.mjs --skip-electron)');
  process.exit(1);
}

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/') p = '/index.html';
  const fp = path.join(DIST, p);
  if (!fp.startsWith(DIST) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
    // SPA 回退到 index.html
    const idx = path.join(DIST, 'index.html');
    res.setHeader('Content-Type', 'text/html');
    res.end(fs.readFileSync(idx));
    return;
  }
  res.setHeader('Content-Type', MIME[path.extname(fp)] || 'application/octet-stream');
  res.end(fs.readFileSync(fp));
});

await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const base = `http://localhost:${port}`;

const browser = await chromium.launch();
const page = await browser.newPage();

const problems = [];
const capturedConsole = [];
page.on('console', (m) => {
  const t = m.type();
  const txt = m.text();
  capturedConsole.push(`[${t}] ${txt}`);
  if (t === 'error' || t === 'warning') {
    if (/Failed to resolve component|el-dropdown|el-scrollbar|el-checkbox|el-switch|resolveComponent/i.test(txt)) {
      problems.push(`[${t}] ${txt}`);
    }
  }
});
page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));

// 注入 mock electronAPI, 避免渲染端调用 IPC 时因 window.electronAPI 缺失而崩溃
await page.addInitScript(() => {
  const handler = {
    get: () => new Proxy(function () {}, { apply: () => Promise.resolve({ success: true, data: {} }), get: () => handler }),
  };
  try {
    window.electronAPI = new Proxy({}, handler);
  } catch {
    /* readonly 保护, 忽略 */
  }
});

try {
  await page.goto(base + '/', { waitUntil: 'load', timeout: 30000 });
  // 给 App 挂载 + router redirect / → /chat + ChatSidebar 渲染留时间
  await page.waitForTimeout(3500);
  // 主动切到 chat 路由, 触发 ChatSidebar 的 el-dropdown / el-scrollbar 渲染
  await page.evaluate(() => {
    if (window.history && location.hash !== '#/chat') location.hash = '#/chat';
  });
  await page.waitForTimeout(2500);
} catch (e) {
  console.error('⚠ 页面加载异常: ' + String(e?.message || e).split('\n')[0]);
}

await browser.close();
server.close();

if (problems.length) {
  console.error('\n✘ Renderer 冒烟发现组件解析问题:');
  for (const p of problems) console.error('  - ' + p);
  // 同时把其余 console 也打印, 便于排查
  console.error('\n--- 完整 console 摘要 (最后 20 条) ---');
  for (const c of capturedConsole.slice(-20)) console.error('  ' + c);
  process.exit(1);
} else {
  console.log('✓ Renderer 冒烟通过: 无 el-dropdown / el-scrollbar / el-checkbox 等 "Failed to resolve component" 报错');
  console.log(`  (共收集 ${capturedConsole.length} 条 console 输出, 0 条组件解析类报错)`);
}
