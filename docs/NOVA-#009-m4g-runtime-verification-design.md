# NOVA #009 — M4-G 实跑验证（把应用跑起来看）

> **状态**：已实现（2026-11-06）
> **对应台账**：DEV-119 ~ DEV-122
> **分支**：`feat/harness-wiring`

## 一、为什么做这件事

前几批我加了 **5 个新 UI 面板**（嵌入后端配置 / 技能目录 / 效果统计 / 边际效用 /
技能验证）+ 成本卡片 + 接受度列 —— 但**一次都没真的渲染过**。
typecheck 通过 ≠ 界面正常。

于是这一批第一次**把应用跑起来看**。

## 二、实跑发现了什么

### 2.1 i18n key 缺失（真实缺陷）

控制台里 33 条警告，内容全是：

```
Not found 'nav.search' key in 'zh' locale messages.  (SideNav.vue)
Not found 'nav.voice'  key in 'zh' locale messages.  (SideNav.vue)
Not found 'common.ok'  key in 'zh' locale messages.  (ExecutionModeSwitch.vue)
```

**侧边栏的「搜索」和「语音」两个图标没有文案** —— 路由是存在的
（`/search` → `Search.vue`，`/voice` → `Voice.vue`）、图标画得出来，
唯独 tooltip 与 aria-label 是空的。

### 2.2 为什么这类问题特别难发现

| # | 原因 |
|---|---|
| ① | **不报错、不崩** —— 只是少一行文案 |
| ② | **动态 key 扫不出来** —— SideNav 用的是 `t(item.titleKey)`，字面量 grep 完全看不见 |
| ③ | **语言包是嵌套对象** —— 用扁平字符串比对会漏掉一大半（全是假警报） |
| ④ | **没有对照检查** —— 没有「源码用的 key ⊆ 语言包有的 key」这条断言 |

### 2.3 我自己写的审计脚本也骗了我两次

第一次审计脚本按扁平字符串比对 → 报「360 个 key 缺失」，全是假警报。
第二次修好了嵌套解析 → 仍报「nav.chat 缺失」，而 `nav.chat` 明明存在
（我的解析器在嵌套对象上路径拼错了）。

**最终是用 `import` 语言包模块拿到真实结构**才得到准数：
**zh 缺 3 个、en 缺 3 个、两种语言 key 集合完全一致（各 540 个）**。

这个过程本身说明一件事：**审计工具本身也要被验证**。
所以下面的测试里有一条专门断言「审计能抓到确实缺 key 的情况」。

## 三、实现

### 3.1 补 3 个缺失 key

`nav.search` / `nav.voice` / `common.ok` —— 中英文各补一份。

### 3.2 i18n key 审计测试（`tests/unit/i18n-key-audit.test.ts`）

| 用例 | 守什么 |
|---|---|
| zh-CN 覆盖源码用到的所有 key | 缺一个就红，并指出**在哪个文件** |
| en-US 覆盖源码用到的所有 key | 同上 |
| 两种语言 key 集合一致 | 没有「只翻一边」 |
| **审计本身有效** | 用**真实存在过的缺失 key**（nav.search / nav.voice / common.ok）做对照 —— 断言它们既被收集到、现在也都在语言包里 |

收集方式覆盖两类：
- 字面量 `t('...')` / `$t('...')`
- **动态取值** `titleKey` / `labelKey` / `i18nKey` / `messageKey` / `nameKey`

### 3.3 修一个 flaky 测试（墙钟断言）

`FileOrganizer.test.ts` 断言 `result.durationMs < 1000` —— **墙钟断言在机器繁忙时随机变红**。
本批实测：应用占着 CPU 时失败、单独跑必绿。

墙钟断言**测的是机器负载，不是代码**。改法：
- 核心断言保持功能性（10 个文件全部归位）—— 那才是要守的
- 时间上限放宽到 5000ms（实测 ~100ms，50 倍余量）—— 仍能捕获病态回归
  （每文件 sleep 一下、改成 O(n²) 扫描）

### 3.4 仓库卫生

| 项 | 问题 | 处置 |
|---|---|---|
| `release.bak-*` | build.mjs 的 `moveAside()` 产物，**近 1GB 构建产物进了仓库**（.gitignore 只覆盖了 dist/dist-electron 的 bak） | 补 .gitignore + 从索引移除 + 清本地残留 |
| `.tmp-nova-shots/*.png` | 开发期截图，非产品资产，全仓无引用 | 补 .gitignore + 从索引移除 |
| `scripts/.tmp-*.py` | 我自己写的临时脚本误入仓 | 移除 |

## 四、验证

| 项 | 之前 | 现在 |
|---|---|---|
| vitest | 123 files / 1448 passed | **124 files / 1452 passed / 0 FAIL** |
| 后端 typecheck | 0 error | **0 error** |
| 前端 vue-tsc | 0 | **0** |
| **实跑控制台警告** | **33 条**（全是 i18n 缺 key） | **1 条**（Electron 的 CSP 开发提示，与本项目无关） |

## 五、遗留与后续

| # | 遗留 | 归属 | 说明 |
|---|---|---|---|
| 1 | **路由的 `meta.title` 是硬编码中文** | 后续 | `src/router/index.ts` 里写 `meta: { title: '搜索' }`，没走 i18n —— 切英文时浏览器标签页标题还是中文 |
| 2 | **i18n 审计只覆盖 `t()` 与几个 key 字段名** | 已知边界 | 若将来引入别的动态 key 约定（如 `labelKey` 之外），需要同步扩展收集规则 |
| 3 | **没有端到端的界面冒烟测试** | 后续 | 本批是人工实跑 + 截图。自动化需要 Playwright 级别的设施（项目已有 `tests/e2e/` 但只覆盖 nova-search 一条） |
| 4 | **实跑只覆盖了首屏** | 后续 | 本批验证了启动与 i18n；5 个新面板的渲染只做到「typecheck + 构建通过」，未逐个截图确认 |
