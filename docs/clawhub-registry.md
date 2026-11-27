# ClawHub 远程仓库 (registry) 使用说明

把"作者推送技能 / 用户检查更新一键装"做实的最后一公里。之前 ClawHub 是纯本地模拟云端，用户装不进任何第三方技能；现在 App 能真去拉一个 registry、验签、安装。

## 信任链

- 作者用 Ed25519 私钥对 `.zip` 原始字节签名，把签名写入 `index.json`。
- App 用内置/配置的 Ed25519 公钥验签，通过后才调用 `importSkillFromZip` 安装。
- 公钥优先级：`NW_CLAWHUB_PUBKEY`(env) > `userData/clawhub-pubkey.txt` > 代码内置开发公钥。
- 开发私钥：`scripts/clawhub-dev-ed25519.key`（**生产请换成自己的私钥，并不要随包分发**）。

## 一、作者端：打包 + 签名 + 推送

```bash
node scripts/build-registry.mjs \
  --skill ./skills/my-skill \
  --id my-skill --name "My Skill" --desc "一句话说明" \
  --author "New World Team" --category ai --tags "web,summary" \
  --version 1.0.0 --registry ./registry-out
```

产出 `registry-out/<id>-<version>.zip` 与 `registry-out/index.json`。
把整个 `registry-out` 目录托管到 GitHub Release / raw / 任意 CDN（目录里 `zipUrl` 改成绝对 URL 亦可）。

## 二、用户端：检查更新 + 一键安装

1. 打开 **ClawHub 技能市场 → 远程仓库** 标签页。
2. 填入 registry 基址（或留空用 `NW_CLAWHUB_REGISTRY` 环境变量 / `userData/clawhub-registry.txt`）。
3. 点「连接仓库 / 检查更新」→ 列出远端技能及本地安装状态（已装/可更新/未安装）。
4. 点「安装 / 更新」→ 下载 → Ed25519 验签 → 装进本地技能目录（兼容 New World / OpenClaw / Claude Code 的 skill.md 格式）。

## registry 基址配置（任选其一）

- 环境变量：`NW_CLAWHUB_REGISTRY=https://your.cdn/nw-clawhub`
- 文件：`userData/clawhub-registry.txt` 写入基址
- 代码默认：`DEFAULT_REGISTRY`（占位，请替换）

## index.json 规范

```json
{
  "registry": "nw-clawhub",
  "version": 1,
  "updatedAt": 0,
  "skills": [
    {
      "id": "web-summary",
      "name": "Web Page Summarizer",
      "description": "抓取网页正文并三段式摘要",
      "version": "1.0.0",
      "author": "New World Team",
      "category": "ai",
      "tags": ["web", "summary", "llm"],
      "zipUrl": "https://cdn/.../web-summary-1.0.0.zip",
      "signature": "<hex ed25519 sig over zip bytes>",
      "changelog": ""
    }
  ]
}
```

## 关键代码入口

- `electron/skill/ClawHubRegistry.ts` — 拉取 / 验签 / 安装核心
- `electron/core/IpcServer.ts` — `skills:clawhub:registry:list` / `skills:clawhub:registry:install`
- `electron/preload.ts` — `clawhubRegistryList` / `clawhubRegistryInstall`
- `src/views/ClawHub.vue` — 远程仓库标签页
- `scripts/build-registry.mjs` — 作者端打包签名工具
