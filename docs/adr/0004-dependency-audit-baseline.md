# ADR-0004 · 依赖审计基线: 生产面 critical 硬门禁 + 已知 high 台账

- 状态: accepted · 日期: 2026-11-24 · 影响面: ci.yml / .github/dependabot.yml / package-lock.json

## 背景

引入依赖治理时的实测: 全量 37 漏洞(3 critical / 16 high / 18 moderate)。
非破坏性 `npm audit fix` 后 25(3 critical / 10 high / 12 moderate)。
**3 个 critical 全部在 dev 链**(vitest/tinypool, 不随安装包发布);
生产面 0 critical / 7 high, 其中:
- `@intlify/core-base` / `@intlify/shared` 9.14.5(high): 修复需升级 vue-i18n 9→11, breaking。
- `@vue/server-renderer`(vue 的 SSR 转递依赖, 本应用无 SSR)、`nanoid`(转递)。

## 决策

1. **CI 硬门禁**: `npm audit --omit=dev --audit-level=critical` —— 只审生产依赖,
   只卡 critical。理由: 安装包只包含生产依赖; dev 链漏洞不构成用户攻击面。
2. **已知 high 台账**(本 ADR 即台账): 上述 7 high 记录在案, 不静默、不遗忘。
3. **Dependabot**: npm + github-actions 周更, minor/patch 分组小步合入;
   intlify/vue-i18n 9→11 升级单独立项(涉及 ADR-0002 管线回归验证), 不走自动合入。
4. 本地 npmmirror 镜像不支持 audit 端点 —— 本地审计需加
   `--registry=https://registry.npmjs.org`; CI 默认 npmjs 无此问题。

## 后果

- 门禁今天即可全绿且可持续(不因历史债假红)。
- 生产面出现新 critical → CI 直接红, 无豁免通道。
- high 的清理依赖 vue-i18n 大版本升级, 在此之前由 Dependabot 保持 transitive 依赖新鲜。

## 防回退

- ci.yml audit 步骤为硬失败; dependabot.yml 常驻。
- 升级 vue-i18n 时必须重验 ADR-0002 三配置 + final-acceptance A0。
