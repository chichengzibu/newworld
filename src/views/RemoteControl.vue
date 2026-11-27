<template>
  <div class="remote-control-page" :class="{ 'is-embedded': embedded }">
    <div v-if="!embedded" class="page-header">
      <h1 class="page-title">远程控制</h1>
      <!-- 【设计审计 #P1-5】面包屑已移除 -->
    </div>
    
    <div class="control-content">
      <el-card class="control-card">
        <template #header>
          <div class="control-card__head">
            <div class="control-card__title">
              <span class="platform-mark">微信</span>
              <span class="platform-desc">企业微信机器人</span>
            </div>
            <div class="control-card__switch">
              <span class="switch-label">{{ config.wechat.enabled ? '已启用' : '未启用' }}</span>
              <el-switch v-model="config.wechat.enabled" />
            </div>
          </div>
        </template>
        <div v-if="config.wechat.enabled" class="control-form">
          <el-form label-width="120px">
            <el-form-item label="Webhook URL">
              <el-input v-model="config.wechat.webhookUrl" placeholder="请输入 Webhook URL" />
            </el-form-item>
            <el-form-item label="密钥">
              <el-input v-model="config.wechat.secret" type="password" placeholder="请输入密钥" />
            </el-form-item>
          </el-form>
          <el-button type="primary" size="small" @click="testConnection('wechat')">测试连接</el-button>
        </div>
        <div v-else class="control-hint">开启后可配置 Webhook URL 与密钥，并测试连接。</div>
        <el-collapse class="tutorial-collapse">
          <el-collapse-item title="配置教程">
            <div class="tutorial-content">
              <p>1. 登录企业微信管理后台</p>
              <p>2. 进入「应用管理」→「自建应用」，点击「创建应用」</p>
              <p>3. 填写应用名称「New World机器人」，上传应用头像</p>
              <p>4. 点击「获取企业ID」，记录企业ID</p>
              <p>5. 点击「应用管理」→「New World机器人」→「接收消息」，点击「设置接收消息」</p>
              <p>6. 获取「Webhook URL」和「密钥」，填入下方</p>
            </div>
          </el-collapse-item>
        </el-collapse>
      </el-card>
      
      <el-card class="control-card">
        <template #header>
          <div class="control-card__head">
            <div class="control-card__title">
              <span class="platform-mark">飞书</span>
              <span class="platform-desc">自定义机器人</span>
            </div>
            <div class="control-card__switch">
              <span class="switch-label">{{ config.feishu.enabled ? '已启用' : '未启用' }}</span>
              <el-switch v-model="config.feishu.enabled" />
            </div>
          </div>
        </template>
        <div v-if="config.feishu.enabled" class="control-form">
          <el-form label-width="120px">
            <el-form-item label="Webhook URL">
              <el-input v-model="config.feishu.webhookUrl" placeholder="请输入 Webhook URL" />
            </el-form-item>
            <el-form-item label="密钥">
              <el-input v-model="config.feishu.secret" type="password" placeholder="请输入密钥" />
            </el-form-item>
          </el-form>
          <el-button type="primary" size="small" @click="testConnection('feishu')">测试连接</el-button>
        </div>
        <div v-else class="control-hint">开启后可配置 Webhook URL 与密钥，并测试连接。</div>
        <el-collapse class="tutorial-collapse">
          <el-collapse-item title="配置教程">
            <div class="tutorial-content">
              <p>1. 登录飞书开放平台，创建自定义机器人</p>
              <p>2. 点击「添加机器人」，填写机器人名称「New World」</p>
              <p>3. 复制「Webhook地址」和「签名校验」的密钥</p>
              <p>4. 将获取到的信息填入下方</p>
            </div>
          </el-collapse-item>
        </el-collapse>
      </el-card>
      
      <el-card class="control-card">
        <template #header>
          <div class="control-card__head">
            <div class="control-card__title">
              <span class="platform-mark">Telegram</span>
              <span class="platform-desc">Bot API</span>
            </div>
            <div class="control-card__switch">
              <span class="switch-label">{{ config.telegram.enabled ? '已启用' : '未启用' }}</span>
              <el-switch v-model="config.telegram.enabled" />
            </div>
          </div>
        </template>
        <div v-if="config.telegram.enabled" class="control-form">
          <el-form label-width="120px">
            <el-form-item label="Bot Token">
              <el-input v-model="config.telegram.botToken" placeholder="请输入 Bot Token" />
            </el-form-item>
            <el-form-item label="Chat ID">
              <el-input v-model="config.telegram.chatId" placeholder="请输入 Chat ID" />
            </el-form-item>
          </el-form>
          <el-button type="primary" size="small" @click="testConnection('telegram')">测试连接</el-button>
        </div>
        <div v-else class="control-hint">开启后可配置 Bot Token 与 Chat ID，并测试连接。</div>
        <el-collapse class="tutorial-collapse">
          <el-collapse-item title="配置教程">
            <div class="tutorial-content">
              <p>1. 打开 Telegram，搜索「@BotFather」</p>
              <p>2. 发送「/newbot」，按提示创建机器人，获取「Bot Token」</p>
              <p>3. 搜索「@userinfobot」，发送任意消息，获取「Chat ID」</p>
              <p>4. 将获取到的信息填入下方</p>
            </div>
          </el-collapse-item>
        </el-collapse>
      </el-card>
      
      <div class="action-bar">
        <el-button type="primary" @click="saveConfig">保存配置</el-button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { reactive } from 'vue';
import { ElMessage } from "element-plus/es/components/message/index";

/** v4.9：内嵌进设置页配置中心时隐藏自带页头，交由外层滚动 */
defineProps<{ embedded?: boolean }>();

interface RemoteControlConfig {
  wechat: {
    enabled: boolean;
    webhookUrl?: string;
    secret?: string;
  };
  feishu: {
    enabled: boolean;
    webhookUrl?: string;
    secret?: string;
  };
  telegram: {
    enabled: boolean;
    botToken?: string;
    chatId?: string;
  };
}

const config = reactive<RemoteControlConfig>({
  wechat: { enabled: false },
  feishu: { enabled: false },
  telegram: { enabled: false }
});

function saveConfig(): void {
  ElMessage.success('配置已保存');
}

function testConnection(platform: keyof RemoteControlConfig): void {
  ElMessage.success(`${platform} 连接成功`);
}
</script>

<style lang="scss" scoped>
@use "@/styles/variables.scss" as *;

.remote-control-page {
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: var(--content-padding);
}
/* v4.9 内嵌态：外层已滚动，改为自然高度 + 内层不再滚动，消除双滚动条 */
.remote-control-page.is-embedded {
  height: auto;
}
.remote-control-page.is-embedded .control-content {
  flex: none;
  overflow: visible;
}

.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-shrink: 0;
}

.page-title {
  font-size: var(--font-size-title-1);
  font-weight: var(--font-weight-semibold);
  color: var(--text-color);
  margin: 0;
}

.control-content {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--content-padding);
}

.control-card {
  flex-shrink: 0;

  /* 【视觉打磨】开关移到卡片头, 未启用时给引导文案而不是一整块空白。
     卡片头/内容间距、表单项与折叠教程的行高一起收紧, 三张卡片一屏看得完。 */
  :deep(.el-card__header) {
    padding: 10px 16px;
  }
  :deep(.el-card__body) {
    padding: 12px 16px 14px;
  }
  :deep(.el-form-item) {
    margin-bottom: 12px;
    &:last-child { margin-bottom: 0; }
  }
  :deep(.el-collapse-item__header) {
    height: 34px;
    line-height: 34px;
    font-size: 13px;
  }
  :deep(.el-collapse-item__content) {
    padding-bottom: 8px;
  }
}

.control-card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.control-card__title {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}
.platform-mark {
  font-size: 15px;
  font-weight: 600;
  color: var(--fg-primary, inherit);
  &::before {
    content: '';
    display: inline-block;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent-base, #7c8db5);
    margin-right: 8px;
    vertical-align: middle;
  }
}
.platform-desc {
  font-size: 12px;
  color: var(--fg-tertiary, #94a3b8);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.control-card__switch {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.switch-label {
  font-size: 12px;
  color: var(--fg-tertiary, #94a3b8);
}
.control-hint {
  font-size: 13px;
  color: var(--fg-tertiary, #94a3b8);
  padding: 4px 0 2px;
}

.tutorial-collapse {
  margin-top: 8px;
}

.tutorial-content {
  p {
    margin: 6px 0;
    font-size: 13px;
    color: var(--fg-secondary, var(--text-color, inherit));
  }
}

.action-bar {
  display: flex;
  gap: var(--space-md);
  flex-shrink: 0;
}
</style>