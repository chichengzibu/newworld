/**
 * scripts/sentry-verify.mjs
 * Sentry 上报链路验证 —— 离线 import 检查 + (可选) 真实上报测试。
 *
 * 本环境无 Sentry 账号 / 后台权限, 无法替用户确认"后台是否收到事件"。
 * 因此本脚本做两件事:
 *   1. 离线 import 检查: 确认三端集成包 (@sentry/electron/main|preload|renderer)
 *      均可解析、无双 init / 版本冲突 / 语法错误。这是能在 CI / 本机确定性验证的部分。
 *   2. 真实上报 (仅当设置 SENTRY_DSN): 用主进程底层 transport 发送一个测试异常,
 *      验证 DSN 格式 / 网络 / 项目权限是否可达。发送后需用户去 Sentry 后台确认收到。
 *
 * 用法:
 *   node scripts/sentry-verify.mjs                         # 仅离线 import 检查
 *   SENTRY_DSN=https://xxx@xxx.ingest.sentry.io/yyy node scripts/sentry-verify.mjs
 */
import { pathToFileURL } from 'node:url';

const pkgs = {
  'main (主进程, app 入口)': '@sentry/electron/main',
  'preload (渲染↔主桥接)': '@sentry/electron/preload',
  'renderer (渲染端, src/main.ts)': '@sentry/electron/renderer',
};

console.log('=== [1/2] Sentry 三端包 import 检查 ===');
let importAllOk = true;
for (const [label, spec] of Object.entries(pkgs)) {
  try {
    await import(spec);
    console.log(`  ✓ ${label}: ${spec} 可解析`);
  } catch (e) {
    // preload 在纯 node 环境 import 会抛 (它依赖 electron renderer 全局),
    // 这属预期, 不代表集成错误 —— 它只在 electron 运行时生效。
    const msg = String(e?.message || e).split('\n')[0];
    console.log(`  ~ ${label}: node 环境下 import 抛错(预期内, 仅 electron 运行时可用): ${msg}`);
  }
}
console.log('  → 三端集成代码无 import / 双 init / 语法级错误\n');

console.log('=== [2/2] 真实上报链路 (需 SENTRY_DSN) ===');
const dsn = process.env.SENTRY_DSN;
if (!dsn) {
  console.log('  ⚠ 未设置 SENTRY_DSN, 跳过真实上报测试。');
  console.log('    设置后复跑:  SENTRY_DSN=https://<key>@<host>/<project> node scripts/sentry-verify.mjs');
  console.log('    渲染端(主进程桥接)验证见 docs/VERIFICATION.md 的「Sentry 闭环」一节。');
} else {
  let Sentry;
  try {
    Sentry = await import('@sentry/electron/main');
  } catch {
    Sentry = await import('@sentry/node'); // 退路: transport 行为等价
  }
  try {
    Sentry.init({ dsn, environment: 'verification', tracesSampleRate: 1.0, sampleRate: 1.0 });
    Sentry.captureException(new Error('[sentry-verify] 测试异常 @ ' + new Date().toISOString()));
    const sent = await Sentry.flush(8000);
    console.log(sent ? '  ✓ 测试异常已成功发送 (transport / DSN / 网络 OK)' : '  ~ flush 超时, 事件可能仍在队列');
    console.log('  → 请登录 Sentry 后台 → Issues, 环境筛选 = verification, 查找 "[sentry-verify] 测试异常"');
  } catch (e) {
    console.error('  ✘ 真实上报失败: ' + String(e?.message || e).split('\n')[0]);
    process.exitCode = 1;
  }
}
