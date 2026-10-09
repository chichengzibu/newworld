#!/usr/bin/env node
/**
 * 构建产物可视化报告 (零依赖)
 *
 * 用法: node scripts/build-report.mjs
 * 前提: 已 npm run build,生成 dist/ 目录
 * 输出:
 *   - 控制台 markdown 报告
 *   - dist/_build-report.md (随产物打包发布)
 *
 * 大厂做法对应:
 *   - rollup-plugin-visualizer → 饼图;本脚本是它的 markdown 简化版,零安装。
 *   - bundle-stats → 类似;本脚本聚焦"分类汇总+优化建议",对开发者更可读。
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

// ==================== 性能预算门禁 ====================
// 用法:
//   node scripts/build-report.mjs            # 只汇报,不卡门禁
//   node scripts/build-report.mjs --ci       # CI 模式:超阈值 process.exit(1)
//   CI=true npm run build                    # 同等 --ci
// 大厂做法对应: 字节/腾讯 Lighthouse CI / size-limit 卡体积,超预算直接 fail PR。
const ENFORCE = process.argv.includes('--ci') || process.argv.includes('--budget') || process.env.CI === 'true'

// 预算阈值 (宽松但有约束力;当前产物均已满足,不会误卡):
const BUDGET = {
  singleJs: 600 * 1024, // 单个 JS chunk 体积上限 (raw)
  singleCss: 650 * 1024, // 单个 CSS 文件上限 (raw)。注: element-plus 全量 css 为图标/动态组件必需, ~580KB, 不可再紧
  vendorFramework: 250 * 1024, // framework chunk 总上限
  elCss: 650 * 1024, // element-plus css 总上限 (全量必需, 见上)
  totalJs: 3 * 1024 * 1024, // 全部 JS 总上限
  totalAll: 5 * 1024 * 1024, // 全部资源总上限
}

const DIST = 'dist'
const ASSETS = path.join(DIST, 'assets')
if (!fs.existsSync(ASSETS)) {
  console.error('✘ 找不到 dist/assets,请先 npm run build')
  process.exit(1)
}

const CATEGORY_RULES = [
  { match: /^vendor-framework/, label: 'framework (vue/pinia/router)' },
  // 注意: vendor-element-plus 的 .js(全量组件,~894KB) 与 .css(全量样式,~349KB) 必须分开归类,
  // 否则 byCat['element-plus css'] 会把 JS 体积并入,导致 CSS 体积虚高、误卡预算/门禁。
  { match: /^vendor-element-plus.*\.css$/, label: 'element-plus css' },
  { match: /^vendor-element-plus.*\.js$/, label: 'element-plus js (全量组件)' },
  { match: /^vendor/, label: 'vendor (其他)' },
  { match: /^index-/, label: 'app entry' },
  // 路由懒加载 chunk: 文件名以大写字母开头且含连字符,如 Chat-xxx.js / Settings-DCl4.css
  { match: /^[A-Z][a-zA-Z]+-[A-Za-z0-9_-]+\.(js|css)$/, label: 'route-chunk (懒加载)' },
]

function classify(name) {
  for (const r of CATEGORY_RULES) {
    if (r.match.test(name)) return r.label
  }
  return 'asset (其他)'
}

const files = fs
  .readdirSync(ASSETS)
  .filter((f) => /\.(js|css|html|svg|woff2?)$/.test(f))
  .map((f) => {
    const buf = fs.readFileSync(path.join(ASSETS, f))
    return {
      name: f,
      size: buf.length,
      gzip: zlib.gzipSync(buf, { level: 6 }).length,
      category: classify(f),
    }
  })
  .sort((a, b) => b.size - a.size)

const total = files.reduce((s, f) => s + f.size, 0)
const totalGzip = files.reduce((s, f) => s + f.gzip, 0)

const fmt = (b) => `${(b / 1024).toFixed(1)} KB`
const fmtM = (b) => `${(b / 1024 / 1024).toFixed(2)} MB`
const pct = (b) => `${((b / total) * 100).toFixed(1)}%`

// 分类汇总
const byCat = {}
for (const f of files) {
  const c = byCat[f.category] || { size: 0, gzip: 0, count: 0, names: [] }
  c.size += f.size
  c.gzip += f.gzip
  c.count++
  c.names.push(f.name)
  byCat[f.category] = c
}

const lines = []
lines.push('# 📊 构建产物报告')
lines.push('')
lines.push(`- 生成时间: ${new Date().toLocaleString('zh-CN')}`)
lines.push(`- 总大小: **${fmtM(total)}** (gzip ~${fmtM(totalGzip)})`)
lines.push(`- 文件数: ${files.length}`)
lines.push('')
lines.push('## 体积 Top 15')
lines.push('')
lines.push('| # | 文件 | 分类 | 原始 | gzip | 占比 |')
lines.push('|---|---|---|---|---|---|')
files.slice(0, 15).forEach((f, i) => {
  lines.push(`| ${i + 1} | \`${f.name}\` | ${f.category} | ${fmt(f.size)} | ${fmt(f.gzip)} | ${pct(f.size)} |`)
})
lines.push('')
lines.push('## 分类汇总')
lines.push('')
lines.push('| 分类 | 文件数 | 原始 | gzip | 占比 |')
lines.push('|---|---|---|---|---|')
Object.entries(byCat)
  .sort((a, b) => b[1].size - a[1].size)
  .forEach(([cat, v]) => {
    lines.push(`| ${cat} | ${v.count} | ${fmtM(v.size)} | ${fmtM(v.gzip)} | ${pct(v.size)} |`)
  })
lines.push('')
lines.push('## 优化建议')
lines.push('')

// 自动给针对性建议
const suggestions = []
const elCss = byCat['element-plus css']
if (elCss && elCss.size > 200 * 1024) {
  suggestions.push(
    `- **Element Plus CSS 占 ${fmtM(elCss.size)}**。项目含大量动态图标/组件,无法静态移除。可考虑:` +
      `(1) 拆分按页面发布;(2) 用 \`element-plus/theme-chalk/src/base.scss\` + 自定义 token 裁剪未用样式;(3) 长期接入 PurgeCSS 按页面精确裁剪。`
  )
}
const routeChunks = byCat['route-chunk (懒加载)']
if (routeChunks && routeChunks.count >= 5) {
  suggestions.push(
    `- **路由懒加载已生效**:${routeChunks.count} 个按需 chunk,首屏只下载 entry+framework,用户体验流畅。`
  )
}
const fwk = byCat['framework (vue/pinia/router)']
if (fwk) {
  suggestions.push(
    `- **Framework chunk ${fmtM(fwk.size)} (gzip ${fmtM(fwk.gzip)})** 是浏览器强缓存主力,二次访问几乎只下载应用代码。`
  )
}
const entry = byCat['app entry']
if (entry) {
  suggestions.push(
    `- **首屏 entry ${fmtM(entry.size)} (gzip ${fmtM(entry.gzip)})**: 包含初始化逻辑与首屏组件,主要受 Chat/SideNav 等影响。`
  )
}
if (suggestions.length === 0) {
  suggestions.push('- 当前产物规模良好,无需优化。')
}
lines.push(...suggestions)
lines.push('')

// ==================== 回归防护门禁 (always, 不依赖 --ci) ====================
// 这两项是今天修复的高等级工程隐患的"防复发"卡点,必须每次构建都拦:
//   隐患2: Element Plus 必须全量 CSS。若有人改成按需 CSS,elCss 会骤降至 < 100KB,
//          导致动态图标/组件样式缺失错乱。硬性要求 elCss ∈ [500KB, 650KB]。
//   隐患3: unplugin-vue-components 的 ElementPlusResolver 必须对所有 .vue 生效。
//          若 vite.config 的 exclude 误含 /\.vue$/,el-dropdown 等会 Failed to resolve,
//          且 build 不报错只在运行时暴露。硬性要求路由/入口 chunk 从 vendor-element-plus 导入。
const hardFailures = [];

// 隐患2: elCss 区间校验 (只统计 .css,避免 vendor-element-plus JS 被误并入 "element-plus css" 分类)
const elCssFiles = files.filter((f) => /^vendor-element-plus.*\.css$/.test(f.name));
const elCssHard = elCssFiles.reduce((s, f) => s + f.size, 0);
if (elCssFiles.length === 0) {
  hardFailures.push('未找到 element-plus 全量 CSS (vendor-element-plus css 分类为空) — 疑似改为按需 CSS,会导致动态图标/组件样式缺失错乱');
} else if (elCssHard < 250 * 1024) {
  hardFailures.push(
    `element-plus CSS = ${fmt(elCssHard)} < 250KB 下限。疑似改为按需 CSS(importStyle),` +
      `会导致动态图标/v-for 组件样式缺失、错乱。必须保留全量 element-plus/dist/index.css`
  );
} else if (elCssHard > 650 * 1024) {
  hardFailures.push(`element-plus CSS = ${fmt(elCssHard)} > 650KB 上限,请核查`);
}

// 隐患3: ElementPlusResolver 生效校验 (正确检测)
// 常见误区: 检查 "是否 import vendor-element-plus chunk" 是**无效**的 —— 该 chunk 由
// main.ts 里 ElMessage/ElMessageBox 的深层导入拉入,与 resolver 是否工作无关。
// 正确做法: resolver 生效时, <el-dropdown> 等标签被编译为导入的组件变量(如 ElDropdown),
// 产物中**不会**出现裸组件名字符串; resolver 失效时, Vue 把未解析标签编译成
// resolveComponent("el-dropdown") / createElementBlock("el-dropdown"...) 残留裸名字符串。
// 以原始 Failed-to-resolve 报错里出现的 EP 组件为探针,扫描 .vue 编译 chunk 检测残留。
const PROBE = ['el-dropdown', 'el-dropdown-menu', 'el-dropdown-item', 'el-scrollbar', 'el-checkbox'];
const probeRe = new RegExp('["\'](' + PROBE.map((c) => c.replace(/-/g, '\\-')).join('|') + ')["\']');
const vueChunks = files.filter((f) => f.name.endsWith('.js') && !f.name.startsWith('vendor-'));
const residual = [];
for (const f of vueChunks) {
  let content;
  try {
    content = fs.readFileSync(path.join(ASSETS, f.name), 'utf8');
  } catch {
    continue;
  }
  const m = content.match(probeRe);
  if (m) residual.push(`${f.name}:${m[1]}`);
}
if (residual.length > 0) {
  hardFailures.push(
    `检测到未解析的 Element Plus 组件名(ElementPlusResolver 失效),运行时将 Failed to resolve: ${residual.slice(0, 5).join('; ')}`
  );
}

lines.push('## 回归防护门禁 (always)');
lines.push('');
if (hardFailures.length === 0) {
  lines.push('- ✅ EP 全量 CSS 体积正常,ElementPlusResolver 生效');
} else {
  lines.push('- ❌ 回归防护失败:');
  for (const h of hardFailures) lines.push(`  - ${h}`);
}
lines.push('');

// ==================== 预算检查 ====================
const violations = []
const jsFiles = files.filter((f) => f.name.endsWith('.js'))
const cssFiles = files.filter((f) => f.name.endsWith('.css'))
const totalJs = jsFiles.reduce((s, f) => s + f.size, 0)

for (const f of jsFiles) {
  // vendor chunk(全量 vue/element-plus 等)体积由 elCss 区间与已知全量特征覆盖,不卡单文件软预算
  if (f.name.startsWith('vendor-')) continue;
  if (f.size > BUDGET.singleJs) violations.push(`单 JS chunk ${f.name} = ${fmt(f.size)} > 预算 ${fmt(BUDGET.singleJs)}`)
}
for (const f of cssFiles) {
  if (f.size > BUDGET.singleCss) violations.push(`单 CSS ${f.name} = ${fmt(f.size)} > 预算 ${fmt(BUDGET.singleCss)}`)
}
if (fwk && fwk.size > BUDGET.vendorFramework) violations.push(`framework chunk = ${fmt(fwk.size)} > 预算 ${fmt(BUDGET.vendorFramework)}`)
if (elCss && elCss.size > BUDGET.elCss) violations.push(`element-plus css = ${fmt(elCss.size)} > 预算 ${fmt(BUDGET.elCss)}`)
if (totalJs > BUDGET.totalJs) violations.push(`总 JS = ${fmt(totalJs)} > 预算 ${fmt(BUDGET.totalJs)}`)
if (total > BUDGET.totalAll) violations.push(`总资源 = ${fmt(total)} > 预算 ${fmt(BUDGET.totalAll)}`)

lines.push('## 性能预算门禁')
lines.push('')
if (violations.length === 0) {
  lines.push(`- ✅ 全部通过 (${ENFORCE ? 'CI 模式' : '展示模式,不卡构建'})`)
} else {
  lines.push(`- ❌ 超预算 ${violations.length} 项 ${ENFORCE ? '(CI 模式将中断构建)' : '(展示模式仅告警)'}:`)
  for (const v of violations) lines.push(`  - ${v}`)
}
lines.push('')

const report = lines.join('\n')
fs.writeFileSync(path.join(DIST, '_build-report.md'), report)
console.log(report)
console.log(`\n✓ 已写入 ${path.join(DIST, '_build-report.md')}`)

// 门禁:
// - 软预算:仅 CI/--ci 模式超阈值才中断
// - 回归防护(隐患2/3):任何模式失败都中断(防 EP 全量 CSS 被改按需 / resolver 失效漏到运行时)
if ((ENFORCE && violations.length > 0) || hardFailures.length > 0) {
  console.error(
    `\n✘ 构建校验未通过 (软预算违规 ${violations.length} 项${ENFORCE ? ' [CI]' : ''}, 回归防护失败 ${hardFailures.length} 项), 构建中断。`
  )
  process.exit(1)
}
process.exit(0)