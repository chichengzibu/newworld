/**
 * New World — 用户旅程模拟（临时脚本，不入仓）
 * ═══════════════════════════════════════════════════════════════════════
 * 【它在做什么】
 * 以**真实用户**的路径驱动装好的应用（隔离 userData，不碰开发者的真实数据）：
 *   首启引导 → 技能页 → 开源技能库（刷新/搜索）→ 来源管理 → 私有技能仓库
 *   → 设置（主题）→ 聊天（无 provider 时发消息）
 *
 * 每步截图 + 收集 pageerror / console.error —— 测试绿不代表用户顺畅，
 * 这里要看的是"用户会卡在哪、会看到什么"。
 *
 * 用法: node scripts/user-simulation.mjs
 * 产物: .tmp/user-sim/*.png + report.json
 */
import { _electron as electron } from 'playwright';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mainEntry = join(repoRoot, 'dist-electron', 'main.js');
const outDir = join(repoRoot, '.tmp', 'user-sim');
mkdirSync(outDir, { recursive: true });

const userDataDir = mkdtempSync(join(tmpdir(), 'newworld-user-sim-'));

const findings = [];
const consoleErrors = [];
const pageErrors = [];
let shotIndex = 0;

const app = await electron.launch({
  args: [mainEntry, '--no-sandbox', `--user-data-dir=${userDataDir}`],
  cwd: repoRoot,
  env: {
    ...process.env,
    // 与 e2e helper 一致：走 prod 路径（loadFile dist/index.html）+ 跳过 splash
    NW_E2E: '1',
    NW_SKIP_SPLASH: '1',
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
  },
  timeout: 30_000,
});

const window = await app.firstWindow();
window.on('pageerror', (e) => pageErrors.push(String(e.message ?? e)));
window.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});

async function shot(name) {
  shotIndex += 1;
  const file = join(outDir, `${String(shotIndex).padStart(2, '0')}-${name}.png`);
  await window.screenshot({ path: file }).catch(() => {});
  return file;
}

async function note(step, ok, detail) {
  findings.push({ step, ok, detail });
  console.log(`[sim] ${ok ? '✅' : '⚠️'} ${step}${detail ? ' —— ' + detail : ''}`);
}

async function text(selector) {
  return (await window.locator(selector).first().innerText().catch(() => '')) || '';
}

async function gotoRoute(route) {
  await window.evaluate((r) => { window.location.hash = r; }, route);
  await window.waitForTimeout(1200);
}

try {
  await window.waitForLoadState('domcontentloaded');
  await window.waitForTimeout(2500);
  await shot('first-launch');

  // ── 1. 首启引导（v4.8 已按用户决策整体移除）────────────────
  const guideCount = await window.locator('.first-launch-guide').count();
  await note('首屏无引导遮罩', guideCount === 0,
    guideCount === 0 ? '直接进入对话页' : '仍存在引导组件，需检查挂载点');

  // ── 2. 技能页 ─────────────────────────────────────────────
  await gotoRoute('/skills');
  await window.waitForTimeout(1500);
  await shot('skills-page');
  const hasDir = await window.locator('.skills-dir-card').count();
  const hasHub = await window.locator('.skills-hub-card').count();
  const hasTrial = await window.locator('.skills-trial-card').count();
  await note('技能页三张卡都在', hasDir > 0 && hasHub > 0 && hasTrial > 0,
    `技能目录=${hasDir} 开源技能库=${hasHub} 技能验证=${hasTrial}`);

  const pageText = await window.locator('.skills-page').innerText().catch(() => '');
  await note('技能页显示样本指引', /至少 6 个配对任务/.test(pageText),
    /至少 6 个配对任务/.test(pageText) ? '' : `没找到指引文案（页面 ${pageText.length} 字）`);

  // ── 3. 开源技能库：刷新索引（联网）──────────────────────────
  const refreshBtn = window.locator('button:has-text("刷新索引")').first();
  if (await refreshBtn.count()) {
    await refreshBtn.click();
    // 最多等 30s（GitHub 拉取 + 解析）
    const started = Date.now();
    let hubItems = 0;
    while (Date.now() - started < 30_000) {
      await window.waitForTimeout(1500);
      hubItems = await window.locator('.hub-item').count();
      if (hubItems > 0) break;
    }
    await shot('hub-refreshed');
    await note('开源技能库刷新出条目', hubItems > 0, `条目数=${hubItems}（等待 ${Math.round((Date.now() - started) / 1000)}s）`);
  } else {
    await note('开源技能库刷新按钮存在', false);
  }

  // ── 4. 搜索 ───────────────────────────────────────────────
  const search = window.locator('.skills-hub-card input').first();
  if (await search.count()) {
    await search.fill('pdf');
    await search.press('Enter');
    await window.waitForTimeout(2500);
    await shot('hub-search-pdf');
    const n = await window.locator('.hub-item').count();
    await note('搜索 pdf', n > 0, `结果 ${n} 条`);
  }

  // ── 5. 来源管理对话框 ──────────────────────────────────────
  const sourcesBtn = window.locator('button:has-text("管理来源")').first();
  if (await sourcesBtn.count()) {
    await sourcesBtn.click();
    await window.waitForTimeout(1200);
    await shot('sources-dialog');
    const dlgText = await window.locator('.el-dialog').first().innerText().catch(() => '');
    await note('来源管理对话框打开', dlgText.length > 0,
      dlgText.includes('内置') ? '列出内置源' : '未见内置源标记');
    await window.keyboard.press('Escape');
    await window.waitForTimeout(500);
  }

  // ── 6. 私有技能仓库 ───────────────────────────────────────
  await gotoRoute('/clawhub');
  await window.waitForTimeout(1200);
  await shot('private-registry');
  const regText = await window.locator('.clawhub-page').innerText().catch(() => '');
  await note('私有仓库页说明与开源库的分工', regText.includes('开源技能库'));
  await note('私有仓库给出配置指引', /NW_CLAWHUB_REGISTRY|clawhub-registry\.txt/.test(regText));

  // ── 7. 设置 + 主题 ────────────────────────────────────────
  await gotoRoute('/settings');
  await window.waitForTimeout(1200);
  await shot('settings');
  const darkRadio = window.locator('.radio-group label:has-text("深色"), .radio-group label:has-text("Dark")').first();
  if (await darkRadio.count()) {
    await darkRadio.click().catch(() => {});
    await window.waitForTimeout(800);
    await shot('settings-dark');
    const isDark = await window.evaluate(() => document.documentElement.classList.contains('dark'));
    await note('切深色主题生效', isDark, isDark ? '' : 'html.dark 未加上');
  }

  // ── 8. 聊天：无 provider 时发一条消息（最真实的新用户动作）──
  await gotoRoute('/');
  await window.waitForTimeout(1500);
  const box = window.locator('textarea').first();
  if (await box.count()) {
    await box.fill('你好，帮我整理一下桌面');
    await window.waitForTimeout(300);
    await window.keyboard.press('Enter');
    await window.waitForTimeout(6000);
    await shot('chat-send-no-provider');
    const chatText = await window.locator('body').innerText().catch(() => '');
    const hasReply = /整理|收到|抱歉|未配置|provider|模型/i.test(chatText);
    await note('无 provider 发消息有反馈（不是白屏/卡死）', hasReply,
      hasReply ? '页面有文字反馈' : '没有可读反馈');
  } else {
    await note('聊天输入框存在', false);
  }
} catch (e) {
  await note('旅程脚本异常', false, String(e));
  await shot('error-state').catch(() => {});
} finally {
  const report = {
    finishedAt: new Date().toISOString(),
    userDataDir,
    findings,
    pageErrors,
    consoleErrors: consoleErrors.slice(0, 40),
    screenshots: shotIndex,
  };
  writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2), 'utf-8');
  console.log('\n===== 用户旅程结果 =====');
  for (const f of findings) console.log(`${f.ok ? '✅' : '⚠️'} ${f.step}${f.detail ? ' —— ' + f.detail : ''}`);
  console.log(`pageerror: ${pageErrors.length} · console.error: ${consoleErrors.length}`);
  for (const e of pageErrors.slice(0, 5)) console.log('  [pageerror]', e.slice(0, 160));
  for (const e of consoleErrors.slice(0, 8)) console.log('  [console.error]', e.slice(0, 160));
  console.log(`产物: ${outDir}`);
  await app.close().catch(() => {});
  // 保留 userData 供排查（很小），不自动删
  void readFileSync;
}
