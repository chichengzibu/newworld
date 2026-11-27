# New World 鸿蒙 PC — DevEco Studio 真机调试手册

> 目标：从零到在**鸿蒙 PC（HarmonyOS PC）真机**上跑通 New World（Electron + Vue3）。
> 打包路线：**鸿蒙 PC 官方 Electron runtime `v34.6.3-20260105.1`** + `ohos/` HAP 壳工程 → HAP。
> 配套文档：[`docs/跨平台适配方案-Win-macOS-Linux-鸿蒙PC.md`](./跨平台适配方案-Win-macOS-Linux-鸿蒙PC.md)
> 编写日期：2026-08-07　适用代码基线：`v4.5.0-alpha`（`electron/platform/` 抽象层已落地）

---

## 0. 阅读约定

### 0.1 状态标记

| 标记 | 含义 |
|------|------|
| ✅ **代码已核实** | 已对照本仓库源码确认，含 `文件:行号` 引用，可直接照做 |
| ⚠️ **需真机/工具链验证** | 依赖真实 DevEco / OHOS Electron runtime / 鸿蒙 PC 设备，本机无法确认，首次真机联调时必须逐条实测并回填本文档 |
| 🚧 **待壳工程 owner 提供** | 由 `ohos/` 壳工程负责人交付后才能确定的值（bundleName / abilityName / 环境变量注入点等） |

### 0.2 前置事实（写手册时的仓库现状）

| 事项 | 现状 | 影响 |
|------|------|------|
| `ohos/` 壳工程 | ✅ 已由团队成员产出（97 文件，Stage 模型，含 ets 入口 / 构建脚本 / 签名占位） | 本手册第 2 章起的值均已按其实际配置对齐 |
| `npm run ohos:sync` / `ohos:build` | ✅ 已定义于 `package.json:12-13` | 见 §5.1 |
| `hvigorw` wrapper | ❌ `ohos/` 下**尚不存在** | 由 DevEco 首次打开工程时下发，**不能手工编造**（`ohos/README.md` TODO #8）。见 §2.4 |
| OHOS Electron runtime 依赖坐标 | ❌ `ohos/oh-package.json5` 中为注释占位 | 拿到官方发布物后才能 `ohpm install`（TODO #3） |
| 签名配置 | ❌ `ohos/build-profile.json5` 的 `signingConfigs` 为**空数组**，且 product 未引用 `signingConfig` | 见 §3 |
| Electron 版本 | `package.json:51` 为 `^30.5.1` | 与 OHOS runtime `34.6.3` 有 4 个大版本差，见 §1.4 |
| PlatformHost 抽象 | ✅ 已落地：`electron/platform/`（6 文件） | 验证清单 §8 全部基于它 |

**已确定的工程标识（后续命令直接用这三个值）** ✅

| 标识 | 值 | 来源 |
|------|-----|------|
| `bundleName` | `com.newworld.nw` | `ohos/AppScope/app.json5` |
| `abilityName` | `EntryAbility` | `ohos/entry/src/main/module.json5` → `abilities[0].name` |
| `moduleName` | `entry` | `ohos/entry/src/main/module.json5` → `module.name` |
| `versionName` / `versionCode` | `4.5.0` / `4050000` | `ohos/AppScope/app.json5`（鸿蒙不允许 `-alpha` 后缀） |
| `compatibleSdkVersion` | `5.0.0(12)` | `ohos/build-profile.json5` |

> 壳工程自身的 14 项集成 TODO 见 [`ohos/README.md`](../ohos/README.md) §四，**那份是壳工程侧的权威清单**，本手册不重复，只在受影响的步骤上标注引用。

### 0.3 术语

- **HAP**：HarmonyOS Ability Package，鸿蒙应用安装包，本项目最终产物。
- **hvigor**：鸿蒙工程构建系统（类比 Gradle），命令行封装为 `hvigorw` / `hvigorw.bat`。
- **hdc**：HarmonyOS Device Connector，鸿蒙的 adb 等价物。
- **ArkWeb**：鸿蒙 Web 内核，OHOS Electron 的渲染层由它承载（替代标准 Chromium）。
- **AGC**：AppGallery Connect，华为应用分发与证书管理平台。

---

## 1. 环境准备

### 1.1 DevEco Studio 安装

⚠️ **需工具链验证**：版本号与下载入口请以华为开发者联盟官网当期发布为准，本节只给流程与校验方法，不写死链接。

**Windows（推荐 x64，16GB+ 内存）**

1. 从华为开发者联盟官网 DevEco Studio 页面下载 Windows 版安装包（`.exe`）。
2. 安装路径**不要含中文、空格**，推荐 `D:\DevEco\DevEcoStudio`。
   > 含空格会导致 hvigor 传参与 node 路径解析在部分插件下出错。
3. 首次启动会引导安装 Node.js + ohpm。**若本机已装 Node，仍建议让 DevEco 用它自带的**——DevEco 对 Node 版本有强绑定，混用会出现 `hvigor` 依赖解析失败。
4. 安装后校验：

```bash
# DevEco 自带工具链位置（Windows 典型路径，按实际安装路径调整）
# hvigor:  <DevEco>/tools/hvigor/bin/hvigorw.js
# ohpm:    <DevEco>/tools/ohpm/bin/ohpm.bat
# hdc:     <DevEco>/sdk/default/openharmony/toolchains/hdc.exe
```

**macOS（Intel / Apple Silicon 均有对应包）**

1. 下载 `.dmg`，拖入 `/Applications`。
2. Apple Silicon 机器需确认下载的是 arm64 包；x64 包在 Rosetta 下 hvigor 会明显变慢。
3. 首次启动同样走 Node + ohpm 引导。

### 1.2 配置命令行工具到 PATH

把 `hdc`、`ohpm`、`hvigorw` 加进 PATH，后续章节的命令才能直接跑。

**Windows（Git Bash，本项目约定用正斜杠）**

```bash
# 追加到 ~/.bashrc（DEVECO 路径按实际安装位置改）
export DEVECO="/d/DevEco/DevEcoStudio"
export PATH="$DEVECO/sdk/default/openharmony/toolchains:$PATH"
export PATH="$DEVECO/tools/ohpm/bin:$PATH"
export PATH="$DEVECO/tools/hvigor/bin:$PATH"
```

**macOS**

```bash
export DEVECO="/Applications/DevEco-Studio.app/Contents"
export PATH="$DEVECO/sdk/default/openharmony/toolchains:$PATH"
export PATH="$DEVECO/tools/ohpm/bin:$PATH"
export PATH="$DEVECO/tools/hvigor/bin:$PATH"
```

校验：

```bash
hdc -v          # 期望输出 hdc 版本号（如 Ver: 3.1.0a）
ohpm -v
node -v         # 应为 DevEco 自带版本
```

> ⚠️ `hdc -v` 若报 `command not found`，先确认 `sdk/default/openharmony/toolchains` 目录确实存在——SDK 未安装时该目录为空。

### 1.3 HarmonyOS SDK 安装

在 DevEco 内：**File → Settings → SDK**（macOS：**DevEco Studio → Preferences → SDK**）

1. 选择 **HarmonyOS SDK** 页签。
2. 勾选目标 API 版本（🚧 **须与 `ohos/` 壳工程 `build-profile.json5` 的 `compatibleSdkVersion` / `compileSdkVersion` 完全一致**，否则 `assembleHap` 会在 sync 阶段直接失败）。
3. 至少勾选：`Native`（NAPI 需要）、`Toolchains`（含 hdc / 签名工具）、`Previewer`（可选）。
4. SDK 落盘路径记为 `$OHOS_SDK`，Windows 默认 `C:\Users\<user>\AppData\Local\OpenHarmony\Sdk`，macOS 默认 `~/Library/OpenHarmony/Sdk`。

### 1.4 OHOS Electron runtime `v34.6.3-20260105.1`

⚠️ **需工具链验证**：该 runtime 由华为通过官方渠道分发（开发者联盟 / DevEco 插件市场 / OpenHarmony SIG 仓库），**获取方式请向 runtime 提供方或团队内部镜像确认**，本文不臆造下载地址。

获取后需确认三件事：

| 校验项 | 方法 | 失败后果 |
|--------|------|---------|
| runtime 版本串完整匹配 | 解压后查 `version` / `electron.d.ts` 头部，应含 `34.6.3` 与构建号 `20260105.1` | 版本漂移会导致 preload / IPC 行为不一致 |
| ABI 架构 | 鸿蒙 PC 主流为 `arm64`，部分为 `x86_64`。用 `hdc shell param get const.product.cpu.abilist` 确认设备 | 架构不符 → HAP 安装成功但启动即崩 |
| Node ABI 版本 | Electron 34 对应 Node 20.x 系 | 本项目零原生模块（`package.json:30-43` 全为纯 JS/TS），**此项风险为 0**，无需重编译 `.node` |

**版本对齐注意（关键）**

本项目 devDependency 为 `electron@^30.5.1`（`package.json:51`），而 OHOS runtime 为 34.x。两者需要按下面策略处理：

1. **构建期**：`vite.config.mts:85` 已把 `electron` 声明为 external，主进程 bundle 不内联 Electron，因此**本地用 30.x 出包、真机用 34.x 运行**在技术上可行。
2. **API 差异面**：30 → 34 的破坏性变更主要落在 `BrowserWindow` 选项、`webContents` 事件、`session` API。本项目 Electron 符号面很窄（见适配方案 §二·发现 2），主要触点是 `WindowManager` / `MiniWindow` / `IpcServer`。
3. **建议**：单开分支把 devDependency 升到 34.x 并跑完现有测试（`npm run test`、`npm run typecheck`），再上真机。**不要在 30.x 本地通过就直接认为 34.x 真机没问题。** ⚠️ 需真机验证。

---

## 2. 工程导入与环境配置

### 2.1 目录关系

```
D:/pipiclaw/piclaw/
├── electron/            # Electron 主进程（含 platform/ 抽象层）
├── src/                 # Vue3 渲染层
├── dist/                # vite build 产物（渲染层）
├── dist-electron/       # vite build 产物（main.js / preload.js / mcp/bin）
└── ohos/                # HAP 壳工程 ← DevEco 打开的就是这个目录
    ├── AppScope/app.json5              # bundleName / versionCode / 图标
    ├── build-profile.json5             # product / SDK 版本 / signingConfigs
    ├── oh-package.json5                # ohpm 依赖（Electron runtime 占位）
    ├── hvigorfile.ts
    ├── entry/
    │   ├── build-profile.json5
    │   ├── src/main/module.json5       # Ability / metadata / 权限
    │   ├── src/main/ets/
    │   │   ├── AppAbilityStage.ets     # ★ Electron 主进程挂载点（TODO #1）
    │   │   ├── entryability/EntryAbility.ets  # ★ 窗口移交（TODO #2）
    │   │   └── pages/Index.ets         # 启动占位页
    │   └── assets/app/                 # ★ Electron 产物落这里（非 rawfile）
    │       ├── package.json            #   Electron 应用清单
    │       ├── dist/
    │       └── dist-electron/
    ├── scripts/
    │   ├── sync-assets.mjs             # dist/ + dist-electron/ → entry/assets/app/
    │   └── pack-hap.mjs                # 调 hvigor 打 HAP，环境未就绪时显式失败
    └── signature/                      # 签名材料（已 gitignore）
```

> ⚠️ 产物落点当前是 `entry/assets/app/`，**不是** `resources/rawfile/`。这一选择尚未定稿（`ohos/README.md` TODO #4，三选一：rawfile 解压 / hvigor 插件声明 / runtime 直读路径）。
> 需要切换时用环境变量覆盖，无需改脚本：
> ```bash
> NW_OHOS_ASSET_DIR=ohos/entry/src/main/resources/rawfile/app npm run ohos:build
> ```

### 2.2 打开工程

1. DevEco → **File → Open** → 选择 `D:/pipiclaw/piclaw/ohos`（**选 `ohos/`，不是仓库根目录**；选根目录会因为找不到 `build-profile.json5` 而无法识别为鸿蒙工程）。
2. 首次打开自动触发 **Sync**。
3. **首次打开的关键副作用**：DevEco 会在 `ohos/` 下生成 **`hvigorw` / `hvigorw.bat` / `hvigor/hvigor-config.json5`**。这三个文件目前仓库里没有，且**不能手工编造**（`ohos/README.md` TODO #8）。**没有它们，§5.2 的所有 `hvigorw` 命令和 `ohos/scripts/pack-hap.mjs` 都跑不了。**
4. Sync 失败时优先看 **Build 面板**，常见三类：
   - `SDK not found` → 回 §1.3 检查 API 版本勾选。
   - `ohpm install failed` → 网络/镜像问题，见 §2.4。
   - `compatibleSdkVersion mismatch` → 本机未装 `5.0.0(12)`（`ohos/build-profile.json5` 声明值）。

### 2.3 配置 SDK 路径

**File → Project Structure → Project → SDK**，确认指向 §1.3 的 `$OHOS_SDK`。

同时设置环境变量——`ohos/scripts/pack-hap.mjs` 会**显式探测**它，缺失即报错退出：

```bash
export DEVECO_SDK_HOME="$OHOS_SDK"      # 或 HOS_SDK_HOME，二者任一
```

生成 wrapper 后校验：

```bash
cd /d/newworld/piclaw/ohos
ls hvigorw hvigorw.bat hvigor/hvigor-config.json5   # 三者应齐全
./hvigorw --version                                  # Windows: ./hvigorw.bat --version
./hvigorw --sync --no-daemon
```

> `--no-daemon` 在 CI 与首次排错时建议加上：hvigor 守护进程会缓存旧配置，导致改了 `build-profile.json5` 却不生效。

### 2.4 hvigor / ohpm 环境

```bash
cd /d/newworld/piclaw/ohos

# 安装壳工程依赖（等价于 npm install），会生成 oh_modules/
ohpm install --all

# 查看 ohpm 源
ohpm config get registry
# 内网/受限网络下改镜像（🚧 内部镜像地址向团队确认）
# ohpm config set registry <内部镜像>
```

> ⚠️ **Electron runtime 依赖当前是注释占位**：`ohos/oh-package.json5` 与 `ohos/entry/oh-package.json5` 的 `dependencies` 里只有 TODO 注释，没有真实坐标。拿到官方发布物后二选一填入（ohpm 远程包 或 本地 `.har` 文件引用），**两个文件都要改**，再重跑 `ohpm install` 重新生成 `oh-package-lock.json5`。

**清理命令**（构建行为诡异时先跑这个）：

```bash
cd /d/newworld/piclaw/ohos
./hvigorw clean --no-daemon
rm -rf entry/build .hvigor
```

---

## 3. 签名配置

鸿蒙对**所有** HAP 强制签名，未签名包 `hdc install` 会直接报错。分调试签名与发布签名两套。

> **当前状态**：`ohos/build-profile.json5` 的 `app.signingConfigs` 是**空数组 `[]`**，且 `products[0]` 里的 `"signingConfig": "default"` 被注释掉了。
> **两处都要补**，只补一处会报 `signing config is not found`。证书文件统一放 `ohos/signature/`（已 gitignore，见其 `README.md`）。

### 3.1 调试签名（DevEco 自动生成，日常联调用这个）

1. DevEco 右上角登录**华为开发者账号**（必须实名认证通过，否则自动签名不可用）。
2. **File → Project Structure → Signing Configs**
3. 勾选 **Automatically generate signature** → 点 **Sign In** / **Try Again**。
4. 成功后 DevEco 会自动产出并写回配置，产物默认落在：
   - Windows：`C:\Users\<user>\.ohos\config\`
   - macOS：`~/.ohos/config/`

   包含：`default_<projectName>_<xxx>.cer`（调试证书）、`.p12`（密钥库）、`.p7b`（调试 Profile）。
   > 建议把这三件套复制/软链到 `ohos/signature/` 并按 `ohos/signature/README.md` 的命名（`nw-debug.p12/.cer/.p7b`），保持团队一致。
5. 生成后 `ohos/build-profile.json5` 的 `signingConfigs` 会被自动填充，并**同时**取消 product 的 `signingConfig` 注释：

```json5
// ohos/build-profile.json5
{
  "app": {
    "signingConfigs": [
      {
        "name": "default",
        "type": "HarmonyOS",
        "material": {
          "storeFile": "./signature/nw-debug.p12",
          "storePassword": "<自动生成的加密串>",
          "keyAlias": "debugKey",
          "keyPassword": "<自动生成的加密串>",
          "certpath": "./signature/nw-debug.cer",
          "profile": "./signature/nw-debug.p7b",
          "signAlg": "SHA256withECDSA"
        }
      }
    ],
    "products": [
      {
        "name": "default",
        "compatibleSdkVersion": "5.0.0(12)",
        "runtimeOS": "HarmonyOS",
        "signingConfig": "default"        // ← 这行当前被注释，必须取消注释
      }
    ]
  }
}
```

> ⚠️ **调试证书绑定设备**：自动生成的 Profile 内嵌了当前已连接设备的 UDID。**换一台鸿蒙 PC 就要重新生成**，否则安装报 `error: install failed due to grant request permissions failed` 或签名校验失败。

**注意事项**

- `build-profile.json5` 里的 `storePassword` / `keyPassword` 是 DevEco 加密串，**不要手工改，也不要提交到公共仓库**。
- 建议 `.gitignore` 增加 `ohos/build-profile.json5` 的本地覆盖策略，或把签名段抽到本地未跟踪文件（🚧 由壳工程 owner 决定方案）。

### 3.2 发布签名（AGC 申请，正式分发用）

⚠️ **需工具链验证**：AGC 控制台的菜单名称随版本变动，以下为流程主干。

**Step 1 — 生成密钥库与 CSR**

DevEco：**Build → Generate Key and CSR**

- Key store file：新建 `.p12`，密码自行保管
- Alias：如 `nw_release`
- Validity：建议 25 年
- CN/OU/O/C 按公司信息填
- 产出：`nw.p12` + `nw.csr`

命令行等价（SDK 自带 `keytool` 场景）：

```bash
keytool -genkeypair -alias nw_release \
  -keyalg EC -sigalg SHA256withECDSA -dname "CN=New World,O=YourOrg,C=CN" \
  -keystore nw.p12 -storetype pkcs12 -validity 9125

keytool -certreq -alias nw_release -keystore nw.p12 -file nw.csr
```

**Step 2 — AGC 申请证书**

AGC 控制台 → **用户与访问 → 证书管理** → 新增证书 → 上传 `nw.csr` → 下载 `.cer`（发布证书）。

> 发布证书每个账号有数量上限（通常调试 2 张、发布 1 张），别乱申请。

**Step 3 — AGC 申请 Profile**

AGC → **我的项目 → 选择项目 → HarmonyOS 应用 → Profile 管理** → 新增：

- 类型：**发布（Release）**
- 包名：**必须为 `com.newworld.nw`** ✅（`ohos/AppScope/app.json5`，与 `electron-builder.json5:3` 的 appId 一致）
- 关联刚申请的发布证书
- 下载 `.p7b`

**Step 4 — 配置到工程**

关掉自动签名，手工填 `signingConfigs`，并把 product 的 `signingConfig` 指向它：

```json5
{
  "name": "release",
  "type": "HarmonyOS",
  "material": {
    "storeFile": "./signature/nw-release.p12",
    "storePassword": "<CI 从 Secrets 注入，勿提交>",
    "keyAlias": "nw_release",
    "keyPassword": "<CI 从 Secrets 注入，勿提交>",
    "certpath": "./signature/nw-release.cer",
    "profile": "./signature/nw-release.p7b",
    "signAlg": "SHA256withECDSA"
  }
}
```

⚠️ **需工具链验证**：无 IDE 的 CI 签名走 `hap-sign-tool.jar` / `binary-sign-tool`，参数与 SDK 版本相关，本机无 SDK 未实测（`ohos/signature/README.md` 已同样标注）。

**配置位置速查**

| 文件 | 作用 | 当前值 |
|------|------|--------|
| `ohos/build-profile.json5` → `app.signingConfigs[]` | 证书材料定义 | **`[]` 空** |
| `ohos/build-profile.json5` → `app.products[0].signingConfig` | 指定 product 用哪套签名 | **被注释** |
| `ohos/build-profile.json5` → `app.products[0].compatibleSdkVersion` | SDK 下限 | `5.0.0(12)` |
| `ohos/entry/src/main/module.json5` → `module.name` / `abilities[0].name` | §6 的 `aa start` 参数 | `entry` / `EntryAbility` |
| `ohos/AppScope/app.json5` → `bundleName` / `versionCode` / `versionName` | `hdc install` / `bm dump` 的包名 | `com.newworld.nw` / `4050000` / `4.5.0` |
| `ohos/signature/` | 证书材料存放（已 gitignore） | 空 |

---

## 4. 设备连接

### 4.1 鸿蒙 PC 开启 USB 调试

在鸿蒙 PC 上：

1. **设置 → 关于本机** → 连续点击「版本号」**7 次** → 提示「已进入开发者模式」。
2. **设置 → 系统 → 开发者选项** → 打开：
   - **USB 调试**
   - **仅充电时允许 ADB 调试**（若有该项，建议开）
3. 用 USB-C 数据线连电脑，PC 端弹窗「**是否允许 USB 调试**」→ 勾选「一律允许」→ 确定。

> ⚠️ 鸿蒙 PC ↔ 开发机若都是 PC，需确认线缆支持数据传输（不少 Type-C 线只供电）。⚠️ 需真机验证：部分鸿蒙 PC 机型走**网络调试**更稳，见 §4.3。

### 4.2 hdc 连接与校验

```bash
# 1. 列出设备（最常用）
hdc list targets
# 期望输出类似：
#   FMR0223C13000649
# 输出 [Empty] 表示没识别到设备

# 2. 详细模式（看连接类型 / 状态）
hdc list targets -v

# 3. 进 shell
hdc shell
# 或指定设备（多设备时必须带 -t）
hdc -t FMR0223C13000649 shell

# 4. 单条命令直出
hdc shell "param get const.product.model"
hdc shell "param get const.product.software.version"
hdc shell "param get const.product.cpu.abilist"   # 确认 arm64 / x86_64（对应 §1.4）
```

### 4.3 网络调试（USB 不稳时的替代方案）

```bash
# 设备与开发机同网段，先用 USB 连一次开端口
hdc tmode port 5555
# 断开 USB，改走 TCP
hdc tconn 192.168.1.100:5555
hdc list targets    # 应出现 192.168.1.100:5555
```

### 4.4 连接排查决策树

| 现象 | 排查动作 |
|------|---------|
| `hdc list targets` 输出 `[Empty]` | ① 重启 hdc server：`hdc kill && hdc start -r`<br>② 换线换口（优先主板直连 USB，不走 Hub）<br>③ 设备端重新确认调试授权弹窗 |
| `[Fail]Failed to communicate with daemon` | hdc 版本与设备 OS 版本不匹配 → 用 DevEco 当前 SDK 里的 hdc，别用旧版 |
| 设备状态显示 `Offline` / `Unauthorized` | 设备上重新授权；或 `hdc shell` 前先 `hdc kill` |
| Windows 识别不到 | 设备管理器看是否有黄色感叹号 → 装 HDC 驱动（DevEco SDK 内附） |
| 多设备并存报错 | 所有命令加 `-t <connectKey>` |
| 端口被占用 | `hdc kill -r`；或改 `HDC_SERVER_PORT` 环境变量后重启 server |

---

## 5. 构建

整体三段式，已由 `package.json:12-13` 的脚本串起来：

```
① vite build                        →  dist/ + dist-electron/
② node ohos/scripts/sync-assets.mjs →  ohos/entry/assets/app/
③ node ohos/scripts/pack-hap.mjs    →  调 hvigorw assembleHap
                                    →  ohos/entry/build/default/outputs/default/entry-default-signed.hap
```

### 5.1 `npm run ohos:build`

```bash
cd /d/newworld/piclaw

npm run ohos:sync      # 只做 ② —— 已有 dist/ 时用它，秒级
npm run ohos:build     # ①+②+③ 全量
```

**② `sync-assets.mjs` 做的事**（已实现，非待办）：

1. 校验 `dist/` 与 `dist-electron/` 存在，不存在直接报错退出
2. 拷贝**整个** `dist-electron/`（含 `main.js` + `preload.js` + `mcp/bin/*.mjs`，后者由 `vite.config.mts:16-46` 的 `copyMcpBinPlugin` 产出）
   > 只拷 `preload.js` 是不够的——`main.js` 才是主进程入口
3. 拷贝 `dist/`
4. 生成 Electron 应用清单 `ohos/entry/assets/app/package.json`（`main: dist-electron/main.js`）
5. **断言 preload 为 CJS**，不符合直接失败（对应验证项 V15，构建期就拦住）

**③ `pack-hap.mjs` 做的事**：探测 `DEVECO_SDK_HOME`/`HOS_SDK_HOME`、`hvigorw` wrapper、`oh_modules`，**任一缺失即打印指引并以退出码 1 明确失败，绝不伪造成功**（与仓库既有原则一致，见适配方案 §七的沙箱假阳性教训）。

当前在未装 SDK 的机器上执行第 ③ 步的真实输出：

```
[ohos:pack] 环境检查未通过:
  - 未设置 DEVECO_SDK_HOME / HOS_SDK_HOME
  - 未找到 hvigor wrapper: <ohos>/hvigorw.bat
  - 未找到 ohos/oh_modules（尚未执行 ohpm install）
```

看到这段输出**属于预期**，说明 §1.3 / §2.3 / §2.4 还没走完，不是脚本坏了。

**产物校验**：

```bash
# 校验 Electron 产物存在且 base 正确（对应验证项 V14）
ls dist/index.html dist-electron/main.js dist-electron/preload.js
grep -o 'src="[^"]*"' dist/index.html | head -5
# 期望看到 ./assets/xxx.js（相对路径），不是 /assets/xxx.js

# 校验已同步进壳工程
ls ohos/entry/assets/app/dist/index.html ohos/entry/assets/app/dist-electron/main.js
head -1 ohos/entry/assets/app/dist-electron/preload.js   # 期望 require("electron") 形态
```

### 5.2 Step 2 — hvigor 构建 HAP

`ohos:build` 的第 ③ 步就是替你跑这一段。手工执行等价于：

**GUI 方式**：DevEco → **Build → Build Hap(s)/APP(s) → Build Hap(s)**

**命令行方式（推荐，可 CI 化）**：

```bash
cd /d/newworld/piclaw/ohos
# Windows Git Bash 用 ./hvigorw.bat，macOS/Linux 用 ./hvigorw

# Debug HAP（§3.1 调试签名）
./hvigorw assembleHap \
  --mode module \
  -p product=default \
  -p module=entry@default \
  -p buildMode=debug \
  --no-daemon

# Release HAP（§3.2 发布签名）
./hvigorw assembleHap \
  --mode module \
  -p product=default \
  -p module=entry@default \
  -p buildMode=release \
  --no-daemon

# 打 .app 包（提交 AGC 用，非真机调试）
./hvigorw assembleApp --mode project -p product=default --no-daemon
```

> `product=default` / `module=entry` 均取自 `ohos/build-profile.json5` 的 `products[0].name` 与 `modules[0].name`，✅ 已确认。

产物路径：

```
ohos/entry/build/default/outputs/default/entry-default-signed.hap   ← 装这个
ohos/entry/build/default/outputs/default/entry-default-unsigned.hap ← 装不了
```

> ⚠️ **文件名带 `-signed` 才是签好名的**。看到只有 `unsigned` 说明 §3 签名没配上，回去查 `signingConfigs`。

**常见构建失败**

| 报错关键字 | 原因 | 处置 |
|-----------|------|------|
| `hvigorw: command not found` / `未找到 hvigor wrapper` | DevEco 还没打开过工程 | §2.2 步骤 3 |
| `Cannot find module 'hvigor'` / 找不到 `oh_modules` | ohpm 依赖没装 | `ohpm install --all` |
| `compatibleSdkVersion is not supported` | 本机未装 `5.0.0(12)` | §1.3 补装对应 API，或改 `build-profile.json5` |
| `signing config is not found` | `signingConfigs` 空 或 product 未引用 | §3，**两处都要补** |
| 找不到 Electron runtime 包 | `oh-package.json5` 依赖仍是注释占位 | §2.4，填坐标后 `ohpm install` |
| `resource file too large` | Electron runtime 体积大 | ⚠️ 资源注入方式未定稿（`ohos/README.md` TODO #4），向 runtime 提供方确认 |
| 构建成功但产物没更新 | hvigor daemon 缓存 | 加 `--no-daemon` + `./hvigorw clean` |

---

## 6. 安装与启动

### 6.1 安装

```bash
HAP=/d/newworld/piclaw/ohos/entry/build/default/outputs/default/entry-default-signed.hap

# 首次安装
hdc install "$HAP"

# 覆盖安装（保留数据，日常迭代用这个）
hdc install -r "$HAP"

# 期望输出：
#   install bundle successfully.

# 卸载（bundleName 以 AppScope/app.json5 为准）
hdc uninstall com.newworld.nw
```

**安装失败对照表**

| 输出 | 含义 | 处置 |
|------|------|------|
| `failed to install bundle. code:9568320 error: signature verification failed` | 签名不被设备信任 | 调试证书未包含该设备 UDID → §3.1 重新生成 |
| `error: install parse profile prop check error` | Profile 与 bundleName 不匹配 | 核对 `module.json5` / `app.json5` 的 bundleName |
| `error: install failed due to older sdk version` | 设备 OS 低于 compileSdkVersion | 降 SDK 或升设备 |
| `error: install already exist` | 已装同包名 | 用 `-r` 或先 `uninstall` |
| `[Fail]Error opening file` | HAP 路径错/含中文空格 | 用绝对路径，路径纯英文 |

### 6.2 确认安装信息

```bash
# 列出所有已装包，确认包名在列
hdc shell bm dump -a | grep newworld

# 查本应用详情（含 abilities 列表 — abilityName 从这里取最准）
hdc shell bm dump -n com.newworld.nw
```

### 6.3 启动

```bash
# 标准启动
hdc shell aa start -b com.newworld.nw -a EntryAbility -m entry
#   -b bundleName    ← AppScope/app.json5
#   -a abilityName   ← entry/src/main/module.json5 → abilities[0].name
#   -m moduleName    ← entry/src/main/module.json5 → module.name

# 以调试模式启动（挂 debugger 时用，见 §7.3）
hdc shell aa start -b com.newworld.nw -a EntryAbility -m entry -D

# 强制停止
hdc shell aa force-stop com.newworld.nw

# 查当前运行的 ability
hdc shell aa dump -a
```

> ✅ 三个参数均已由壳工程确定（见 §0.2 表格），可直接照抄。取不准时用 `bm dump -n com.newworld.nw` 反查。
>
> ⚠️ **启动后可能停在占位页**：`ohos/entry/src/main/ets/pages/Index.ets` 是启动占位页，`EntryAbility.ets` 需在 runtime 接管窗口后跳过 `loadContent('pages/Index')`（`ohos/README.md` TODO #2）。若真机上看到的是占位页而非 New World UI，说明 TODO #1/#2 尚未闭合，**不是 New World 侧的问题**，此时 §8 的验证清单还跑不了。

---

## 7. 调试

New World 在鸿蒙上有**三层日志**，排障时按顺序看：

```
① hilog          → 系统级 / ability 生命周期 / 启动崩溃      ← 先看这层
② electron-log   → 应用主进程日志（落文件，§7.2）            ← §8 验证清单全靠它
③ ArkWeb DevTools→ 渲染层 console / DOM / 网络（§7.4）
```

### 7.1 hilog

```bash
# 实时全量日志
hdc hilog

# 等价写法
hdc shell hilog

# —— 过滤 ——
# 按 tag 过滤
hdc shell hilog -T New World

# 按级别（D/I/W/E/F）
hdc shell hilog -L E

# 只看本应用（先取 pid）
PID=$(hdc shell "pidof com.newworld.nw")
hdc shell hilog -P "$PID"

# 主机侧过滤（最实用，Git Bash 下直接管道）
hdc hilog | grep -E "New World|MiniWindow|TrayManager|GlobalShortcut|AutoUpdater|SandboxL1|DockerDetector"

# —— 常用控制 ——
hdc shell hilog -r            # 清空缓冲区（复现前先清）
hdc shell hilog -b DEBUG      # 全局日志级别调到 DEBUG
hdc shell hilog -p off        # 关闭隐私脱敏，让 <private> 显示真实值
hdc shell hilog -x            # dump 后退出（脚本化采集用）
hdc shell hilog -g            # 查看当前缓冲区大小
hdc shell hilog -G 16M        # 调大缓冲区，避免日志刷丢

# 落盘到本地文件
hdc hilog > ./ohos-hilog-$(date +%Y%m%d-%H%M%S).log
```

**采集崩溃现场**

```bash
# 崩溃栈（native / js crash 都在这）
hdc shell ls /data/log/faultlog/faultlogger/
hdc file recv /data/log/faultlog/faultlogger/ ./faultlog/

# 应用运行日志目录
hdc shell ls /data/log/hilog/
```

> ⚠️ **需真机验证**：OHOS Electron runtime 把主进程 `stdout`/`console.log` 映射到 hilog 的哪个 tag/domain，需实测确认。若发现 `log.info(...)` 不进 hilog，就完全依赖 §7.2 的文件日志。

### 7.2 取应用文件日志（New World 主通道）

`LogManager.ts:39-42` 把日志写到 `<userData>/logs/newworld.log`，而 ohos 下 `userData` 由 `HarmonyHost.ts:43-45` 决定：

```ts
// electron/platform/HarmonyHost.ts:44
return process.env.NW_USER_DATA ?? join(homedir(), '.nw-ohos')
```

```bash
# 先确认 userData 实际落点
hdc shell "ls -la /data/app/el2/100/base/com.newworld.nw/haps/entry/files/"

# 取日志（路径按上一步实际结果调整）
hdc file recv /data/app/el2/100/base/com.newworld.nw/haps/entry/files/logs/newworld.log ./nw-ohos.log

# 看
grep -nE "ohos|鸿蒙|降级" ./nw-ohos.log
```

> ⚠️ **需真机验证**：鸿蒙应用沙箱下 `os.homedir()` 的返回值不确定（可能是 `/` 或不可写路径）。**强烈建议壳工程在拉起 Electron 主进程时显式注入 `NW_USER_DATA` 指向应用沙箱 `files` 目录**，否则日志与配置全部写不进去，且失败是静默的。详见验证项 V4。

### 7.3 DevEco Debugger 挂载

**方式 A — 直接调试运行**

1. DevEco 顶部 device 下拉选中真机。
2. 点 **Debug**（虫子图标）或 `Shift+F9`。
3. DevEco 自动执行：build → install → `aa start -D` → attach。

**方式 B — Attach 到已运行进程**

**Run → Attach Debugger to Process** → 选 `com.newworld.nw`。

**方式 C — 命令行起调试态，DevEco 再 attach**

```bash
hdc shell aa start -b com.newworld.nw -a EntryAbility -m entry -D
```

> ⚠️ **需真机验证**：DevEco 的 ArkTS debugger 调的是 **ets 壳层**。**Electron 主进程（Node 侧）的断点大概率挂不上**。主进程调试建议走：
> - `--inspect` 端口 + `hdc fport tcp:9229 tcp:9229` + Chrome DevTools（⚠️ 需确认 runtime 是否支持 `--inspect`）
> - 或退化为**日志调试**（本项目 §8 验证清单即按此设计，全部用日志关键字判定）

```bash
# 端口转发（若 runtime 支持 inspect）
hdc fport tcp:9229 tcp:9229
hdc fport ls          # 查看已建立的转发
hdc fport rm tcp:9229 # 删除
```

### 7.4 渲染层检查（Electron WebContents / ArkWeb）

本项目已内置两条通路：

1. **IPC 开 DevTools** — `main.ts:61-68` 注册了 `open-devtools`，渲染层可直接触发：
   ```js
   // 渲染进程 console 或临时按钮
   window.electronAPI?.send?.('open-devtools')
   ```
2. **开发模式自动开** — `main.ts:137-139`，条件是 `isDev`（即 `!app.isPackaged`）。

> ⚠️ **需真机验证**：ArkWeb 是否支持 `openDevTools()` 唤起独立 DevTools 窗口。若不支持，改用 **ArkWeb 远程调试**：
> ```bash
> hdc fport tcp:9222 tcp:9222
> # 开发机 Chrome 打开 chrome://inspect，配置 localhost:9222 后 Inspect
> ```
> 该端口是否默认开启由 runtime 决定，需向 runtime 提供方确认。

---

## 8. New World 专属验证清单

> **这是本手册的核心。** 全部 **18 项（V0–V17）**均基于本仓库真实代码，给出「代码位置 → 期望行为 → 验证命令/日志关键字 → 失败处置」。
> 建议做成 checklist，首次真机联调逐条打勾。
>
> **前置门槛**：本清单要求应用已真正拉起 Electron 主进程。若 `ohos/README.md` 的 TODO #1（`AppAbilityStage.ets` 启动主进程 + 注入环境变量）与 TODO #2（窗口移交）未闭合，V1 之后的项全部无法验证——先闭合那两项。

### 验证前准备

```bash
hdc shell hilog -r                      # 清缓冲
hdc shell hilog -b DEBUG                # 提日志级别
hdc shell aa force-stop com.newworld.nw
hdc hilog > ./v-run.log &               # 开始采集
hdc shell aa start -b com.newworld.nw -a EntryAbility -m entry
```

---

### V0 🔴 `initHost()` 注入时机（**阻断级，上真机前必须先确认**）

| 项 | 内容 |
|----|------|
| 代码 | `electron/main.ts:75` 在 `app.whenReady().then()` **内部**调用 `initHost()`；但 `electron/main.ts:40` 是**模块顶层**的 `const log = LogManager.getInstance();`，其构造函数 `electron/core/LogManager.ts:39` 立即调用 `getHost().getPath('userData')`；而 `electron/platform/runtime.ts:20-25` 在未注入时**直接抛错** |
| 风险 | 模块加载阶段 `getHost()` 早于 `initHost()` → 抛 `[platform] PlatformHost 尚未初始化,请在主进程启动时调用 initHost()` → **主进程启动即崩，四个平台通杀，不止鸿蒙** |
| 验证 | 先在开发机跑 `npm run build && npx electron dist-electron/main.js`，看是否出现该错误串；真机上表现为 HAP 启动后无窗口、hilog 出现同一错误串 |
| 日志关键字 | `PlatformHost 尚未初始化` |
| 处置 | 把 `initHost()` 提到 `main.ts` **模块顶层、所有会触发 `getHost()` 的 import 之前**（或让 `LogManager` 惰性初始化）。参考 `sandbox/workspace.ts` 已采用的「模块级常量改惰性求值」手法（见适配方案 §九）。**本手册不改代码，此项需由主进程 owner 修复** |

---

### V1 `isOhos()` 判定命中

| 项 | 内容 |
|----|------|
| 代码 | `electron/platform/detect.ts:15-27`，三重信号：`NW_PLATFORM=ohos` → `process.platform==='ohos'` → `/etc/os-release` 匹配 `HarmonyOS\|OpenHarmony\|OHOS` |
| 期望 | 返回 `true` |
| 验证 | 见 V3 日志；或设备上直接看 `hdc shell cat /etc/os-release` 是否含关键字 |
| 命令 | `hdc shell "cat /etc/os-release"` |
| 失败处置 | 鸿蒙 Node 运行时通常把 `process.platform` 报为 `'linux'`（`detect.ts:6-8` 注释已说明），且应用沙箱**可能读不到 `/etc/os-release`** → 此时三条信号全灭。**兜底：注入 `NW_PLATFORM=ohos`** —— 壳工程已把它列入 `ohos/entry/assets/app/package.json` 的 `newworld.requiredEnv`，实际注入动作待 `AppAbilityStage.ets` 实现（`ohos/README.md` TODO #1）。这是最可靠的一条，建议**无条件注入**，不要依赖自动探测 |

---

### V2 `initHost()` 选中 `HarmonyHost` 而非 `ElectronHost`

| 项 | 内容 |
|----|------|
| 代码 | `electron/platform/index.ts:19-24`：`id === 'ohos' ? new HarmonyHost() : new ElectronHost()` |
| 期望 | 实例为 `HarmonyHost` |
| 验证 | 间接判定：`HarmonyHost.getPath('userData')`（`HarmonyHost.ts:47-65`）返回 `~/.nw-ohos`，而 `ElectronHost`（`ElectronHost.ts:37-39`）返回 Electron 标准 userData。看日志文件实际落点即可区分 |
| 命令 | `hdc shell "find /data/app/el2/100/base/com.newworld.nw -name 'newworld.log'"` |
| 失败处置 | 落点是标准 Electron userData → 说明走了 `ElectronHost` → 回 V1 |

---

### V3 `disableHardwareAcceleration` 在 ohos 生效

| 项 | 内容 |
|----|------|
| 代码 | `electron/main.ts:42-51`，`isOhos()` 为真时在 ready 前调用，try/catch 包裹 |
| 期望 | 打出成功日志，且 GPU 进程不反复重启 |
| 日志关键字 | ✅ `[main] ohos: disableHardwareAcceleration 已启用`<br>⚠️ `[main] ohos: disableHardwareAcceleration 调用失败(非致命)` |
| 命令 | `hdc hilog \| grep "disableHardwareAcceleration"` |
| 失败处置 | 无任何该行日志 → `isOhos()` 返回了 false（回 V1）；出现「调用失败」→ runtime 不支持该 API，需向 runtime 提供方确认替代开关。⚠️ 需真机验证 |
| 附加观察 | 用 `hdc shell "ps -ef \| grep newworld"` 观察是否有 GPU 子进程反复出现/消失 |

---

### V4 userData / logs 路径可写

| 项 | 内容 |
|----|------|
| 代码 | `HarmonyHost.ts:43-45`（base）、`HarmonyHost.ts:47-65`（getPath）、`LogManager.ts:39-42`（日志落点） |
| 期望 | `<userData>/logs/newworld.log` 存在且持续增长 |
| 命令 | `hdc shell "ls -la <userData>/logs/"`（userData 路径见 §7.2） |
| 失败处置 | 文件不存在 → `homedir()` 在鸿蒙沙箱下返回了不可写路径。**注入 `NW_USER_DATA`**，壳工程 `ohos/README.md` §2.2 建议值为 `context.filesDir`（即 `/data/app/el2/100/base/com.newworld.nw/haps/entry/files`）。⚠️ 需真机验证沙箱真实路径 |
| 注意 | electron-log 写失败**不抛错**，是静默的——不要因为「没报错」就认为日志正常 |

---

### V5 `getVersion()` 注入

| 项 | 内容 |
|----|------|
| 代码 | `HarmonyHost.ts:67-69`：`process.env.NW_VERSION ?? '0.0.0'` |
| 期望 | 返回真实版本，**不是 `0.0.0`** |
| 验证 | 应用「设置 → 关于」页显示版本；或日志首行 `main.ts:71` 打的 `New World 应用启动 { version: ... }` |
| 日志关键字 | `New World 应用启动` |
| 失败处置 | 显示 `0.0.0` → 未注入 `NW_VERSION`（`requiredEnv` 已声明，注入待 TODO #1） |
| ⚠️ 版本号三处不一致 | 根 `package.json:3` = `4.5.0-alpha`；`ohos/AppScope/app.json5` `versionName` = `4.5.0`（鸿蒙不允许 `-alpha` 后缀）；`ohos/entry/assets/app/package.json` = `4.5.0-alpha`。**注入时以 `versionName` 为准**，并按 `ohos/README.md` TODO #14 由 CI 统一同步 |
| 备注 | `main.ts:71` 用的是 `app.getVersion()` 而非 `getHost().getVersion()`，两者在 ohos 下可能不一致，⚠️ 需真机对比 |

---

### V6 `getAppPath()` 注入

| 项 | 内容 |
|----|------|
| 代码 | `HarmonyHost.ts:75-77`：`process.env.NW_APP_PATH ?? join(base, 'app')` |
| 期望 | 指向 HAP 内实际资源目录 |
| 影响面 | 技能加载与自学习模块依赖它（适配方案 §九提到 `SelfLearner` / `SkillLoader` 已改走 `getHost().getAppPath()`） |
| 验证 | 应用内技能列表非空；日志无 `ENOENT` 类路径错误 |
| 命令 | `grep -nE "ENOENT\|no such file" ./nw-ohos.log` |
| 失败处置 | 注入 `NW_APP_PATH` 指向 rawfile 解包后的目录。🚧 待壳工程确定资源释放策略 |

---

### V7 temp 路径可用

| 项 | 内容 |
|----|------|
| 代码 | `HarmonyHost.ts:56-57`：`process.env.TMPDIR ?? '/tmp'` |
| 期望 | 返回可写目录 |
| 命令 | `hdc shell "ls -ld /tmp"` → 若不存在或只读，必须注入 `TMPDIR` |
| 失败处置 | 注入 `TMPDIR` 指向沙箱内 `.../haps/entry/temp`。⚠️ 需真机验证鸿蒙沙箱 `/tmp` 是否可写 |

---

### V8 MiniWindow 降级为 no-op 且不崩

| 项 | 内容 |
|----|------|
| 代码 | `electron/core/MiniWindow.ts:37-41` 提前 return（返回值是 `null as unknown as BrowserWindow`）；`MiniWindow.ts:100-111` 的 `show()` 有 `if (this.miniWindow)` 空值保护；调用方 `electron/core/IpcServer.ts:183-184` |
| 期望 | 触发悬浮窗时只打警告，**不抛异常、不白屏、不崩主进程** |
| 日志关键字 | `[MiniWindow] 鸿蒙 PC 不支持独立悬浮窗,降级为主窗口内路由` |
| 命令 | `hdc hilog \| grep "MiniWindow"` |
| 验证动作 | 应用内触发悬浮窗入口（走 `IpcServer` 的 `MiniWindow.getInstance().show()`），观察是否崩溃 |
| 失败处置 | 若出现 `Cannot read properties of null` → 说明有调用方绕过了 `show()` 的空值保护，直接用了 `create()` 返回值。搜 `MiniWindow` 全部调用点（当前仅 `IpcServer.ts:183` 与 `main.ts:265`） |
| 已知副作用 | `show()` 每次都会重新调 `create()`（因为 `this.miniWindow` 恒为 null），**日志会反复刷同一条警告**——属预期，非 bug |

---

### V9 TrayManager 降级

| 项 | 内容 |
|----|------|
| 代码 | `electron/core/TrayManager.ts:37-41`，`isOhos()` 时直接 return，不 `new Tray()` |
| 期望 | 不创建托盘、不报错；`main.ts:99-100` 的 `trayManager.create()` 正常返回 |
| 日志关键字 | `[TrayManager] 鸿蒙 PC 无系统托盘,降级跳过` |
| 命令 | `hdc hilog \| grep "TrayManager"` |
| 失败处置 | 出现 `Failed to create tray` 或 native crash → `isOhos()` 未命中，回 V1 |
| 连带检查 | 托盘承担「关闭窗口最小化到托盘」，ohos 下该行为消失，关窗即退出，属预期。需确认 `main.ts` 的 `window-all-closed` 处理不会导致数据未落盘 |

---

### V10 GlobalShortcut 降级（两处）

| 项 | 内容 |
|----|------|
| 代码 | ① `electron/core/GlobalShortcut.ts:44-48`（`registerAll()`）<br>② `electron/core/GlobalShortcut.ts:240-244`（`registerD1ScreenshotShortcut()`，返回 `false`） |
| 期望 | 两处都跳过注册，不阻断启动 |
| 日志关键字 | `[GlobalShortcut] 鸿蒙 PC 无全局快捷键,降级跳过`<br>`[GlobalShortcut][D1] 鸿蒙 PC 无全局快捷键,跳过注册` |
| 命令 | `hdc hilog \| grep "GlobalShortcut"` |
| 失败处置 | 出现 `GlobalShortcut[D1]: ... FAIL` 而非「跳过注册」→ 说明走进了真实注册分支，回 V1 |
| 连带检查 | D1 截屏问答功能（`Ctrl+Shift+S`）在 ohos 下不可用，UI 若有该入口需灰置。⚠️ 需真机确认 UI 表现 |

---

### V11 AutoUpdater 降级 + **已知缺口**

| 项 | 内容 |
|----|------|
| 代码 | `electron/core/AutoUpdater.ts:20-24`：`initialize()` 在 ohos 提前 return ✅ |
| 期望 | 不注册 electron-updater 事件、不发起 5 秒后的自动检查（`AutoUpdater.ts:75-81`） |
| 日志关键字 | `[AutoUpdater] 鸿蒙 PC 走应用商店更新,禁用 electron-updater` |
| 命令 | `hdc hilog \| grep "AutoUpdater"` |
| 🔴 **缺口** | `registerIpcHandlers()`（`AutoUpdater.ts:91+`）**没有 `isOhos()` 短路**，而 `main.ts:88` 是**无条件调用**的。因此渲染层「设置页」点「检查更新」仍会走到 `AutoUpdater.ts:92-104` 的 `autoUpdater.checkForUpdates()` → 在 ohos 下大概率抛错 |
| 验证 | 真机进设置页点「检查更新」，看是否出现 `[AutoUpdater] checkForUpdates failed` |
| 处置 | 短期：确认它只返回 `{success:false, error}` 而**不崩溃**（代码有 try/catch，理论安全）。长期：在 `registerIpcHandlers()` 内也加 ohos 分支返回「请前往应用商店更新」。**本手册不改代码，登记为待办** |

---

### V12 SandboxL1 在 ohos 为 unsupported（**不假成功**）

| 项 | 内容 |
|----|------|
| 代码 | `electron/sandbox/SandboxL1.ts:72-88`（`currentMode()` / `capability()`）、`SandboxL1.ts:148-157`（stub 分支返回 `ok:false`）<br>三个探测器：`l1/seatbelt.ts:81-83`（`darwin`）、`l1/bwrap.ts:31-39`（`linux` + 实际执行 `bwrap --version`）、`l1/windowsJob.ts:35-37`（`win32`） |
| 期望链路 | ohos 下 `os.platform()` 报 `'linux'` → seatbelt=false → bwrap 探测执行 `bwrap --version` 失败 → false → windowsJob=false → **`currentMode()` 返回 `'stub'`** → `capability()` 返回 `{mode:'stub', available:false}` → `run()` 返回 `{ok:false, exitCode:1, stderr:'L1 隔离不可用', fallback:true}` |
| 关键要求 | **绝不能返回 `ok:true`**。适配方案 §七把「沙箱假成功」列为最高优先级风险 |
| 日志关键字 | `SandboxL1: mode=stub` |
| 命令 | ① `hdc shell "which bwrap"` → **期望空**（有输出即为风险，见下）<br>② `hdc hilog \| grep "SandboxL1"` |
| 🔴 风险点 | 若鸿蒙 PC 镜像里**碰巧有 `bwrap`**，`isBwrapAvailable()`（`bwrap.ts:31-38`）会返回 `true` → `capability()` 误报 `available:true`（`SandboxL1.ts:86`）→ 实际隔离行为未经验证。**首次真机务必先跑 `which bwrap`** |
| 文案陷阱 | `SandboxL1.ts:83` 的 reason 用 `os.platform()` 拼串，ohos 下会输出「**平台 linux W9 不支持 L1 隔离**」而非 ohos。看到 `linux` 字样属**预期**，不要误判为平台检测失效——`isOhos()` 与 `os.platform()` 是两套判定 |

---

### V13 dockerDetector 走真实探测

| 项 | 内容 |
|----|------|
| 代码 | `electron/sandbox/dockerDetector.ts:52-70`。`dockerDetector.ts:56-59` 的注释明确：已删除 win32 硬编码 `unsupported` 短路，统一走 `docker --version` |
| 期望 | ohos 下执行 `docker --version` 失败 → `status: 'not-installed'`（**不是 `unsupported`**），并带 `installUrl` |
| 日志关键字 | `DockerDetector: docker --version fail` |
| 命令 | ① `hdc shell "docker --version"` → 期望 command not found<br>② `hdc hilog \| grep "DockerDetector"` |
| UI 表现 | `dockerDetector.ts:125-136` 的 `healthCheck()` 应返回 `Docker 未安装,前往 ...` |
| 已知瑕疵 | `installUrlFor()`（`dockerDetector.ts:108-119`）按 `os.platform()` 分支，ohos 报 `'linux'` → 会返回 Linux 版 Docker 安装地址，对鸿蒙用户无意义。非阻断，登记为体验待办 |
| 失败处置 | 若返回 `unsupported` → 说明代码里还有平台短路残留，回查 `detect()` |

---

### V14 vite `base:'./'` — 不白屏

| 项 | 内容 |
|----|------|
| 代码 | `vite.config.mts:48-51`：`base: './'`（注释明确为鸿蒙 HAP 白屏而设）；加载点 `electron/core/WindowManager.ts:100`：`loadFile(join(__dirname, '../dist/index.html'))` |
| 期望 | 主窗口正常渲染，非纯白 |
| 构建期验证 | `grep -o 'src="[^"]*"' dist/index.html` → 必须是 `./assets/...`，出现 `/assets/...` 即错 |
| 运行期验证 | 日志出现 `加载生产构建页面`（`WindowManager.ts:101`） |
| 🔴 **连带陷阱** | `WindowManager.ts:37-40` 的 `isDev` 判定是 `!app.isPackaged && NW_E2E!=='1' && !CI`。**若 OHOS runtime 下 `app.isPackaged` 返回 `false`**（HAP 不是 asar 结构，很可能如此），`isDev` 为真 → 会去 `loadURL('http://localhost:5173')`（`WindowManager.ts:97`）→ **必定白屏 + `ERR_CONNECTION_REFUSED`** |
| 判定方法 | 看日志是 `加载开发服务器: http://localhost:5173` 还是 `加载生产构建页面` |
| 处置 | 壳工程注入 **`NW_E2E=1`** 即可强制走 prod 分支（`WindowManager.ts:39` 现成的逃生舱）。注意 `MiniWindow.ts:43` 也用了 `!app.isPackaged`，但 ohos 下 MiniWindow 已在 V8 提前 return，不受影响 |
| ⚠️ | `app.isPackaged` 在 OHOS runtime 下的真实取值，**需真机验证** |

---

### V15 preload 为 CJS 且加载成功

| 项 | 内容 |
|----|------|
| 代码 | `vite.config.mts:102-120` 独立构建 preload；`WindowManager` / `MiniWindow.ts:65` 通过 `join(__dirname,'preload.js')` 引用 |
| 期望 | `dist-electron/preload.js` 首行为 `require("electron")` 形态（CJS），**不是 `import`** |
| 构建期验证 | `head -3 dist-electron/preload.js` |
| 运行期验证 | 渲染层 `window.electronAPI` 存在；日志无 `Unable to load preload script` |
| 命令 | `hdc hilog \| grep -i "preload"` |
| 失败处置 | 社区已知坑：ohos runtime 下 preload 若为 ESM 直接崩渲染进程。若产物变成 ESM，检查 `vite.config.mts` preload 段的 build 配置 |

---

### V16 OpenClaw 网关端口可监听

| 项 | 内容 |
|----|------|
| 代码 | `electron/openclaw/OpenClawGateway.ts:24`：`DEFAULT_OPENCLAW_PORT = 18789`；启动点 `main.ts:126-134` |
| 期望 | 日志出现 `========== OpenClaw网关启动成功 ==========` |
| 命令 | ① `hdc hilog \| grep "OpenClaw网关"`<br>② `hdc shell "netstat -an \| grep 18789"` |
| 失败处置 | 鸿蒙对应用监听本地端口有权限约束 → 检查 `module.json5` 是否声明 `ohos.permission.INTERNET`（🚧 壳工程 owner 确认）。⚠️ 需真机验证鸿蒙是否允许应用内 HTTP server 监听 localhost |

---

### V17 单实例锁缺失（**已知缺口**）

| 项 | 内容 |
|----|------|
| 现状 | 全仓库搜索 `requestSingleInstanceLock` **零命中**，仅 `electron/platform/PlatformHost.ts:36` 定义了 `'second-instance'` 事件类型但无人使用 |
| 风险 | 鸿蒙 PC 上重复点图标可能拉起第二个实例 → 两个进程抢 18789 端口（V16）→ 第二个网关启动失败；同时抢 `newworld.log` 与配置文件写入 |
| 验证 | 连续两次 `hdc shell aa start -b com.newworld.nw -a EntryAbility -m entry`，然后 `hdc shell "ps -ef \| grep newworld"` 看进程数 |
| 期望 | 只有一组进程 |
| 处置 | 若鸿蒙 ability 的 `launchType`（`module.json5`）已设为 `singleton`，系统层已保证单实例，Electron 侧可不加锁 → 🚧 与壳工程 owner 确认 `launchType` 配置。否则需在主进程补 `app.requestSingleInstanceLock()` |

---

### 验证清单汇总表

| # | 验证项 | 等级 | 主要代码位置 |
|---|--------|------|-------------|
| V0 | `initHost()` 注入时机 | 🔴 阻断 | `main.ts:40,75` / `LogManager.ts:39` / `runtime.ts:20-25` |
| V1 | `isOhos()` 判定 | 🔴 阻断 | `platform/detect.ts:15-27` |
| V2 | `HarmonyHost` 被选中 | 🔴 阻断 | `platform/index.ts:19-24` |
| V3 | `disableHardwareAcceleration` | 🟡 重要 | `main.ts:42-51` |
| V4 | userData/logs 可写 | 🔴 阻断 | `HarmonyHost.ts:43-65` / `LogManager.ts:39-42` |
| V5 | `getVersion()` 注入 | 🟢 一般 | `HarmonyHost.ts:67-69` |
| V6 | `getAppPath()` 注入 | 🟡 重要 | `HarmonyHost.ts:75-77` |
| V7 | temp 路径 | 🟡 重要 | `HarmonyHost.ts:56-57` |
| V8 | MiniWindow 降级 | 🟡 重要 | `MiniWindow.ts:37-41,100-111` |
| V9 | Tray 降级 | 🟡 重要 | `TrayManager.ts:37-41` |
| V10 | GlobalShortcut 降级 | 🟡 重要 | `GlobalShortcut.ts:44-48,240-244` |
| V11 | AutoUpdater 降级 + IPC 缺口 | 🟡 重要 | `AutoUpdater.ts:20-24,91+` / `main.ts:88` |
| V12 | SandboxL1 unsupported | 🔴 阻断 | `SandboxL1.ts:72-88,148-157` / `l1/*.ts` |
| V13 | dockerDetector 真实探测 | 🟢 一般 | `dockerDetector.ts:52-70` |
| V14 | `base:'./'` 不白屏 | 🔴 阻断 | `vite.config.mts:51` / `WindowManager.ts:37-40,97-101` |
| V15 | preload CJS | 🔴 阻断 | `vite.config.mts:102-120` |
| V16 | 网关端口 18789 | 🟡 重要 | `OpenClawGateway.ts:24` / `main.ts:126-134` |
| V17 | 单实例锁 | 🟢 一般 | 全仓库缺失 |

---

## 9. 已知坑

### 9.1 ArkWeb 与 Electron renderer 的差异

| 差异 | 说明 | 对 New World 的影响 | 应对 |
|------|------|-------------------|------|
| 内核不是 Chromium | ArkWeb 基于 Web 引擎但特性集与 Chromium 版本不完全对齐 | Element Plus（`package.json:36`）、highlight.js、marked 都是标准 DOM/CSS，风险低 | 重点回归**滚动性能**与**CSS 变量/backdrop-filter** ⚠️ 真机验证 |
| DevTools 唤起方式 | 可能不支持 `webContents.openDevTools()` 独立窗口 | `main.ts:61-68` 的 `open-devtools` IPC 可能无效 | 走 §7.4 的 `hdc fport tcp:9222` 远程调试 |
| `window.open` / 多窗口 | ArkWeb 多窗口代理能力弱 | 已通过 V8 的 MiniWindow 降级规避 | 保持单窗口 + 路由 |
| `<webview>` / iframe 沙箱 | 行为可能不同 | 项目暂无 webview | 无影响 |
| localStorage 配额 | 配额策略可能与 Chromium 不同 | 渲染层若缓存会话历史需注意 | ⚠️ 真机压测 |

### 9.2 NAPI 桥接

- **本项目零原生模块**（`package.json:30-43` 全部为纯 JS/TS，无 `.node`），**这是最大红利**——社区所有鸿蒙迁移案例耗时最长的环节（原生模块重编译）本项目直接跳过。
- 但**壳工程 ↔ Electron 主进程之间**仍需一层桥：环境变量注入（V1/V4/V5/V6/V7）、ability 生命周期传递、退出信号。
- `HarmonyHost.ts:33-37` 目前用 `process.on('SIGINT'|'SIGTERM')` 桥接 `before-quit`。⚠️ **需真机验证鸿蒙关闭应用时是否真的发 SIGTERM**——若不发，`before-quit` 监听器全部不触发，**配置与会话数据可能不落盘**。这是数据丢失级风险，务必实测。
- 若需 ets → Node 双向通信，需要 runtime 提供的 NAPI 通道。🚧 向 runtime 提供方确认协议。

### 9.3 GPU / WebGL

- 已在 `main.ts:42-51` 无条件对 ohos 禁用硬件加速（V3）。
- **不要额外禁用软件光栅化回退**（如 `--disable-software-rasterizer`），否则禁用 GPU 后无路可走，直接黑屏。
- WebGL / Canvas 密集场景在软件渲染下会明显掉帧。本项目目前无 3D，风险低。
- 若真机上禁用硬件加速后仍卡，可试 `--disable-gpu-compositing` 等开关。⚠️ 需真机逐个试，效果因机型而异。

### 9.4 字体渲染

- 鸿蒙 PC 默认中文字体为 **HarmonyOS Sans**，与 Windows 的**微软雅黑**、macOS 的 **PingFang** 度量不同。
- 典型症状：按钮文字换行、表格列宽错位、图标与文字基线不齐。
- 建议 CSS `font-family` 显式加入鸿蒙字体并留兜底：
  ```css
  font-family: 'HarmonyOS Sans SC', 'HarmonyOS Sans', 'PingFang SC',
               'Microsoft YaHei', system-ui, sans-serif;
  ```
- ⚠️ 需真机截图对比。重点看：设置页表单、会话列表、代码块（highlight.js 用等宽字体，鸿蒙下等宽字体可用性需实测）。

### 9.5 userData 路径（**最高频踩坑点**）

| 问题 | 说明 |
|------|------|
| `os.homedir()` 不可靠 | `HarmonyHost.ts:44` 的兜底 `join(homedir(), '.nw-ohos')` 在鸿蒙应用沙箱下可能落到不可写位置 |
| 失败是静默的 | electron-log 写盘失败不抛错（V4），表现为「应用能跑但没有任何日志」，极易误判 |
| 沙箱路径形态 | 典型为 `/data/app/el2/<userId>/base/<bundleName>/haps/<moduleName>/files`，`<userId>` 常见 100 |
| **强制建议** | 壳工程**无条件注入** `NW_USER_DATA`，不要依赖 `homedir()` 兜底 |
| 配套 | 同理注入 `TMPDIR`（V7）、`NW_APP_PATH`（V6）、`NW_VERSION`（V5）、`NW_PLATFORM=ohos`（V1）、`NW_E2E=1`（V14） |

**环境变量注入清单（交给壳工程 owner 的完整列表）** 🚧

```bash
NW_PLATFORM=ohos                                   # V1  平台判定，必需
NW_USER_DATA=<沙箱 files 目录>                      # V4  数据/日志落点，必需
NW_APP_PATH=<HAP 资源目录>                          # V6  技能加载
NW_VERSION=4.5.0-alpha                             # V5  版本显示
TMPDIR=<沙箱 temp 目录>                                   # V7  临时文件
NW_E2E=1                                           # V14 强制走 prod 加载路径
NW_SKIP_UPDATE_CHECK=1                             # V11 双保险，跳过自动更新检查
```

### 9.6 单实例锁

见 V17。补充：鸿蒙侧可通过 `module.json5` 的 `abilities[].launchType: "singleton"` 在系统层保证，优先用系统能力，比 Electron 侧加锁更可靠。

### 9.7 其他

| 坑 | 说明 |
|----|------|
| `isPackaged` 恒 true | `HarmonyHost.ts:71-73` 硬编码 `true` → `LogManager.ts:62-68` 会把日志级别锁在 `info`，**debug 日志看不到**。真机排障时若需要 debug 级，得临时改代码或另加开关 |
| 剪贴板 / 通知 / shell.openExternal | 适配方案 §二列出的「各 1–2 次调用」的桌面 API，ohos 下行为未知 | ⚠️ 逐个真机验证 |
| `chcp 65001` | `LogManager.ts:33-37` 已用 `process.platform === 'win32'` 正确包裹，ohos 不受影响 ✅ |
| HAP 体积 | Electron runtime 本身上百 MB，可能触及商店包体限制 | ⚠️ 需确认鸿蒙应用商店的 HAP 体积上限 |

---

## 10. 命令速查

```bash
# —— 设备 ——
hdc list targets                                  # 列设备
hdc list targets -v                               # 详细
hdc kill && hdc start -r                          # 重启 hdc server
hdc -t <key> shell                                # 多设备指定
hdc tconn <ip>:5555                               # 网络调试

# —— 构建 ——
cd /d/newworld/piclaw && npm run ohos:build       # Electron 产物（脚本待补，§5.1）
cd ohos && hvigorw clean --no-daemon
cd ohos && hvigorw assembleHap --mode module -p product=default -p module=entry@default --no-daemon

# —— 安装启动 ——
hdc install -r ohos/entry/build/default/outputs/default/entry-default-signed.hap
hdc shell aa start -b com.newworld.nw -a EntryAbility -m entry
hdc shell aa force-stop com.newworld.nw
hdc uninstall com.newworld.nw
hdc shell bm dump -n com.newworld.nw

# —— 日志 ——
hdc shell hilog -r                                # 清缓冲
hdc shell hilog -b DEBUG                          # 提级别
hdc hilog | grep -E "New World|ohos|降级"
hdc file recv <userData>/logs/newworld.log ./

# —— 一键跑验证清单 ——
hdc shell hilog -r && \
hdc shell aa force-stop com.newworld.nw && \
hdc shell aa start -b com.newworld.nw -a EntryAbility -m entry && \
hdc hilog | grep -E "disableHardwareAcceleration|MiniWindow|TrayManager|GlobalShortcut|AutoUpdater|SandboxL1|DockerDetector|加载生产构建页面|OpenClaw网关"
```

---

## 11. 需真机 / 工具链才能确认的事项汇总

首次真机联调时，请逐条实测并把结论回填到本文档。

| # | 待确认项 | 所在章节 |
|---|---------|---------|
| 1 | DevEco Studio 与 HarmonyOS SDK 的具体版本号、下载入口 | §1.1 / §1.3 |
| 2 | OHOS Electron runtime `v34.6.3-20260105.1` 获取渠道与目录结构 | §1.4 |
| 3 | 设备 CPU ABI（arm64 / x86_64）与 runtime 是否匹配 | §1.4 / §4.2 |
| 4 | Electron 30 → 34 的实际 API 破坏面 | §1.4 |
| 5 | Electron runtime 放 rawfile 还是 libs、体积是否超限 | §5.2 / §9.7 |
| 6 | 壳工程真实 `bundleName` / `abilityName` / `moduleName` | §6.3 |
| 7 | 主进程 `console.log` 是否进 hilog、对应 tag | §7.1 |
| 8 | 鸿蒙应用沙箱内 userData 真实路径 | §7.2 / V4 |
| 9 | Electron 主进程能否用 `--inspect` 远程调试 | §7.3 |
| 10 | ArkWeb 是否支持 `openDevTools()` / 9222 远程调试端口 | §7.4 |
| 11 | `isOhos()` 三条信号在真机是否至少命中一条 | V1 |
| 12 | `app.isPackaged` 在 OHOS runtime 下的取值（决定是否白屏） | V14 |
| 13 | `disableHardwareAcceleration` 是否被 runtime 支持 | V3 |
| 14 | 设备上是否存在 `bwrap`（影响 SandboxL1 是否误报可用） | V12 |
| 15 | 鸿蒙是否允许应用监听 localhost:18789 | V16 |
| 16 | 关闭应用时是否发 SIGTERM（决定数据能否落盘） | §9.2 |
| 17 | 鸿蒙 PC 中文字体渲染差异 | §9.4 |
| 18 | `/tmp` 是否可写 | V7 |

---

## 12. 待办登记（本手册发现、需代码侧修复）

| # | 问题 | 位置 | 等级 |
|---|------|------|------|
| 1 | `initHost()` 晚于模块级 `getHost()` 调用，四平台通杀的启动崩溃风险 | `main.ts:40,75` + `LogManager.ts:39` | 🔴 P0 |
| 2 | `AutoUpdater.registerIpcHandlers()` 无 ohos 短路 | `AutoUpdater.ts:91+` + `main.ts:88` | 🟡 P1 |
| 3 | 缺 `npm run ohos:build` 脚本 | `package.json:6-29` | 🟡 P1 |
| 4 | 无单实例锁 | 全仓库 | 🟢 P2 |
| 5 | `dockerDetector.installUrlFor()` ohos 下返回 Linux 地址 | `dockerDetector.ts:108-119` | 🟢 P2 |
| 6 | `HarmonyHost.isPackaged()` 恒 true 导致 debug 日志不可见 | `HarmonyHost.ts:71-73` | 🟢 P2 |

> 以上仅登记，**本手册不改动任何代码文件**。
