// CSP 加固验证: 无头 chromium 加载 dist, 断言
//  1) 无 EvalError / CSP violation / vue-i18n 报错
//  2) i18n 文案真实渲染(AST + runtime JIT 路径生效)
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const DIST = path.resolve(process.cwd(), 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  let file = path.join(DIST, urlPath === '/' ? 'index.html' : urlPath);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const page = await browser.newPage();
const messages = [];
page.on('console', (m) => messages.push(`[${m.type()}] ${m.text().slice(0, 300)}`));
page.on('pageerror', (e) => messages.push(`[pageerror] ${String(e).slice(0, 300)}`));
// electronAPI 桩(与 renderer-smoke 一致)
await page.addInitScript(() => {
  window.electronAPI = new Proxy({}, { get: () => () => Promise.resolve(null) });
  if (!window.matchMedia) window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
});
await page.goto(base, { waitUntil: 'networkidle' });
await page.waitForTimeout(3000);

const body = await page.evaluate(() => document.body.innerText);
const all = messages.join('\n');

const evalErrs = messages.filter((m) => /EvalError|Refused to evaluate|Content Security Policy|SyntaxError|UNEXPECTED_RETURN_TYPE|Unexpected return type/i.test(m));
const sampleTexts = ['设置', '模型', '对话', '技能', 'New World'].filter((t) => body.includes(t));

console.log('=== console 消息 (' + messages.length + ') ===');
console.log(all.slice(0, 2000) || '(空)');
console.log('=== 检查结果 ===');
console.log('eval/CSP/i18n 错误数:', evalErrs.length);
if (evalErrs.length) console.log(evalErrs.join('\n'));
console.log('页面命中中文文案:', sampleTexts.join(', '));
console.log('正文前 300 字:', body.slice(0, 300).replace(/\n+/g, ' | '));
const pass = evalErrs.length === 0 && sampleTexts.length >= 2;
console.log(pass ? '✓ CSP + i18n(AST/JIT) 验证通过' : '✘ 验证未通过');
await browser.close();
server.close();
process.exit(pass ? 0 : 1);
