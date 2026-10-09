# 签名材料目录（占位）

本目录用于存放鸿蒙 HAP 的签名材料。**所有证书/密钥文件均已 gitignore，不得提交仓库。**

## 需要的文件

| 文件 | 说明 | 来源 |
|------|------|------|
| `pipiclaw-debug.p12` | 调试密钥库 | DevEco Studio 自动生成 |
| `pipiclaw-debug.cer` | 调试证书 | DevEco Studio 自动生成 |
| `pipiclaw-debug.p7b` | 调试 Profile | DevEco Studio 自动生成（需登录华为开发者账号） |
| `pipiclaw-release.p12` | 发布密钥库 | 本地生成，妥善备份 |
| `pipiclaw-release.cer` | 发布证书 | AppGallery Connect 申请 |
| `pipiclaw-release.p7b` | 发布 Profile | AppGallery Connect 申请（绑定 bundleName `com.pipiclaw.app`） |

## 生成方式

### Debug（本机调试）

TODO（需 DevEco 确认）：本机未安装 DevEco Studio，以下为标准流程，未实测。

1. DevEco Studio 打开 `ohos/` 工程
2. `File → Project Structure → Signing Configs`
3. 勾选 `Automatically generate signature`，登录华为开发者账号
4. DevEco 会自动生成上述 debug 三件套并写回 `ohos/build-profile.json5` 的 `app.signingConfigs`

### Release（正式分发）

TODO（需 AGConnect 确认）：

1. AppGallery Connect 创建应用，`bundleName` 必须为 `com.pipiclaw.app`（与 `AppScope/app.json5` 一致）
2. 生成密钥与 CSR，申请发布证书与 Profile
3. 把 `.p12 / .cer / .p7b` 放入本目录，在 `build-profile.json5` 中新增 release 签名配置

## 命令行签名（CI 场景）

TODO（需官方工具链确认）：鸿蒙提供 `hap-sign-tool.jar` / `binary-sign-tool` 用于无 IDE 签名，
具体参数与 SDK 版本相关，本机无 SDK，未验证。CI 中应从 Secrets 注入密钥口令，
不要把口令写进 `build-profile.json5`。

## 注意

- `build-profile.json5` 中 `signingConfigs` 当前为空数组，且 product 未引用 `signingConfig`。
  证书就绪后需同时补全这两处，否则 hvigor 会报「signing config not found」。
- 未签名的 HAP 只能在开启开发者模式的设备上通过 `hdc install` 安装。
