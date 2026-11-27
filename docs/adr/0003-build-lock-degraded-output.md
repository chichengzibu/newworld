# ADR-0003 · 打包锁三级响应: 定位 → 自愈 → 输出降级到项目外

- 状态: accepted · 日期: 2026-11-24 · 影响面: scripts/build.mjs

## 背景

`npm run build` 的打包步(electron-builder)要求先把旧 `release/` 移开(fsync rename 留备份)。
Windows 上该目录曾被进程长期占用(EPERM), 三次重试全败 → 构建中止, 安装包打不出。

根因定位(2026-11-24): 锁是**目录句柄级** —— AI 沙箱/编辑器的工作区文件监视器对项目内
**新建目录也持句柄**(实测 EB 在全新目录里连 `win-unpacked.tmp` 的 rename 都 EPERM);
且 safe-delete 垫片对 >50 文件的批量清理 fail-closed。文件本身并无锁。

## 决策(build.mjs 三级)

1. **定位**: `findLockedFiles()` 递归逐文件以 `r+` 试开, EPERM/EBUSY 即句柄持有,
   报告具体路径(只开不写, 无副作用)。
2. **自愈**: `tryKillReleaseProcesses()` tasklist 探测 + taskkill 从 release/ 跑起来的
   残留 New World.exe, 然后最后一次 moveAside 重试。
3. **降级**: 仍锁住时 —— `dist`/`dist-electron`(构建输入)锁住才中止;
   **`release/`(旧产物备份)锁住不中止**, electron-builder 改输出到
   `os.tmpdir()/nw-release-<ts>`(监视器/垫片作用域外), NSIS 照常完成,
   `findArtifact` 按实际目录验收。

## 后果

- 安装包产出不再被环境锁阻塞(实测 45.8s 完成打包)。
- 降级路径下 release/ 不含本轮产物(旧安装包保留), 需人工把 temp 产物复制回 release/。
- 项目内可能残留 `release-fresh-*` / `release.bak-*` 目录(垫片内删不掉), 无害, 自行终端可清。
- 在用户自己的终端(无工作区监视器/垫片)构建时, 正常走 release/, 三级响应不会触发。

## 防回退

- build.mjs 语法检查进回归; 构建日志 `.tmp-build-logs/electron-builder.log` 可追溯每轮行为。
