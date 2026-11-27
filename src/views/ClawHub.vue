<template>
  <div class="clawhub-page">
    <div class="page-header">
      <div class="header-left">
        <h1 class="page-title">{{ '私有技能仓库' }}</h1>
        <p class="page-desc">
          {{ '连接你自己托管的技能仓库（带 Ed25519 签名的 zip 包），查看并安装。' }}
        </p>
      </div>
    </div>

    <!--
      【M4-X 清理】本页原先有 5 个页签,其中 4 个是**本地演示**:
      「浏览市场(本地)」「发布技能(本地)」「审核队列(本地)」「技能模板」。
      审计结论(逐条查过读写路径):
      - 本地市场的"下载"按钮是 **stub**(只弹 toast,什么都不装)
      - 本地市场"审核通过"的条目**永远装不上** —— 它只写 userData/clawhub-skills.json
      - 「一键实例化」把技能写到 `userData/templates/` —— **SkillLoader 从不扫这个目录**
        (它只扫技能目录 + 用户自加目录),所以模板实例化出来的东西**不是技能**;
        且 SelfLearner 也不读模板 → 整条链是死的
      故这 4 个页签连同其后端(ClawHubManager)一并删除 —— M3-F 已有先例:
      「零生产调用方的 CRUD 是负担,静默的空转比缺功能更难查」。

      留下的这一页是**远程仓库** —— 唯一真正走网络、且**信任模型不同**的能力:
      自建仓库的包由作者私钥签名、应用验签(公开可校验);
      与「开源技能库」那些无签名的公开 SKILL.md 集合不是一回事。
    -->
    <el-alert
      type="info"
      :closable="false"
      show-icon
      style="margin-bottom: var(--space-md);"
      :title="'公开的开源技能在技能页的「开源技能库」里找；本页用于自建仓库（签名包）。'"
    />

    <el-card>
      <div class="registry-header">
        <el-input
          v-model="registryBaseUrl"
          placeholder="registry 基址，例如 https://example.com/my-registry"
          clearable
          style="width: 420px;"
        />
        <el-button type="primary" :loading="registryLoading" @click="loadRegistry">
          {{ registryList.length ? '检查更新' : '连接仓库' }}
        </el-button>
        <span v-if="registryList.length" class="registry-meta">
          共 {{ registryList.length }} 个 · 可更新 {{ registryList.filter((r) => r.hasUpdate).length }} 个
        </span>
        <span v-else-if="!registryLoading" class="registry-meta registry-meta--muted">
          {{ '未连接或离线。先在远端放好 index.json 与签名 .zip。' }}
        </span>
      </div>

      <div v-if="registryList.length === 0 && registryLoading" class="empty-state">
        <el-skeleton :rows="3" animated />
      </div>

      <div v-else-if="registryList.length === 0" class="empty-hint">
        <!-- 【设计审计 #P1-5】环境变量/文件路径是运维细节 → 用户视角一句话, 细节收进 hover -->
        <p :title="'基址: 环境变量 NW_CLAWHUB_REGISTRY 或页面内填写; 签名公钥: 环境变量 NW_CLAWHUB_PUBKEY 或 userData/clawhub-pubkey.txt'">
          {{ '尚未连接私有技能仓库 — 在上方填入仓库地址并连接，即可浏览与安装签名技能包。' }}
        </p>
      </div>

      <el-row v-else :gutter="16" class="registry-grid">
        <el-col v-for="r in registryList" :key="r.id" :xs="24" :sm="12" :md="8" :lg="6">
          <el-card class="registry-card" shadow="hover">
            <div class="registry-card-header">
              <h4>{{ r.name }}</h4>
              <el-tag size="small" type="info">{{ r.category }}</el-tag>
            </div>
            <p class="registry-desc">{{ r.description }}</p>
            <div class="registry-tags">
              <el-tag v-for="t in r.tags" :key="t" size="small" effect="plain">{{ t }}</el-tag>
            </div>
            <div class="registry-version">
              <span>{{ '远端' }} v{{ r.version }}</span>
              <span v-if="r.installedVersion">
                · {{ '已装' }} v{{ r.installedVersion }}
                <el-tag v-if="r.hasUpdate" size="small" type="warning">{{ '可更新' }}</el-tag>
                <el-tag v-else size="small" type="success">{{ '已最新' }}</el-tag>
              </span>
              <span v-else>· {{ '未安装' }}</span>
            </div>
            <el-button
              type="primary"
              size="small"
              class="registry-install-btn"
              :loading="installingId === r.id"
              @click="installFromRegistry(r)"
            >
              {{ r.installedVersion ? (r.hasUpdate ? '更新' : '重装') : '安装' }}
            </el-button>
          </el-card>
        </el-col>
      </el-row>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { ElMessage } from 'element-plus/es/components/message/index';

/**
 * 私有技能仓库（自建、带签名）。
 *
 * 【与「开源技能库」的区别 —— 信任模型不同,不是同一件事的两种 UI】
 * - 开源技能库(SkillHub,技能页内):公开的 SKILL.md 集合,**无签名**,
 *   靠"公开可校验"取信 —— 拿到的就是上游仓库里那份字节。
 * - 私有仓库(本页):自建托管,**每个 zip 由作者私钥签名、应用验签**,
 *   改一个字节就装不上。
 * 两者可以并存:公开的找开源库,自建的走本页。
 */
const registryList = ref<any[]>([]);
const registryLoading = ref(false);
const registryBaseUrl = ref('');
const installingId = ref<string | null>(null);

async function loadRegistry(): Promise<void> {
  registryLoading.value = true;
  try {
    const r = await (window as any).electronAPI.channel.clawhubRegistryList(
      registryBaseUrl.value.trim() || undefined,
    );
    if (r?.success) {
      registryList.value = r.data || [];
      if (registryList.value.length === 0) {
        ElMessage.info('仓库为空或暂不可达');
      }
    } else {
      ElMessage.error('连接仓库失败: ' + (r?.error || '未知错误'));
    }
  } catch (e) {
    ElMessage.error('连接仓库失败: ' + String(e));
  } finally {
    registryLoading.value = false;
  }
}

async function installFromRegistry(entry: any): Promise<void> {
  installingId.value = entry.id;
  try {
    const r = await (window as any).electronAPI.channel.clawhubRegistryInstall(
      entry.id,
      registryBaseUrl.value.trim() || undefined,
    );
    if (r?.success) {
      ElMessage.success(`已安装: ${entry.name}`);
      await loadRegistry();
    } else {
      ElMessage.error('安装失败: ' + (r?.error || '未知错误'));
    }
  } catch (e) {
    ElMessage.error('安装失败: ' + String(e));
  } finally {
    installingId.value = null;
  }
}
</script>

<style lang="scss" scoped>
.clawhub-page {
  padding: var(--space-lg);
}
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: var(--space-lg);
}
.header-left {
  min-width: 0;
}
.page-title {
  font-size: 20px;
  font-weight: 600;
  margin: 0 0 4px;
}
.page-desc {
  color: var(--fg-tertiary);
  font-size: 13px;
  margin: 0;
}
.registry-header {
  display: flex;
  gap: 12px;
  align-items: center;
  margin-bottom: 16px;
}
.registry-meta {
  font-size: 12px;
  color: var(--fg-tertiary);
}
.registry-meta--muted {
  opacity: 0.75;
}
.empty-hint {
  color: var(--fg-tertiary);
  font-size: 13px;
  padding: var(--space-md) 0;
}
.registry-grid {
  margin-top: 8px;
}
.registry-card {
  margin-bottom: 16px;
  height: 230px;
  display: flex;
  flex-direction: column;
}
.registry-card :deep(.el-card__body) {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 14px;
}
.registry-card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}
.registry-card-header h4 {
  margin: 0;
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.registry-desc {
  font-size: 12px;
  color: var(--fg-tertiary);
  margin: 0 0 8px;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.registry-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 8px;
}
.registry-version {
  margin-top: auto;
  font-size: 12px;
  color: var(--fg-tertiary);
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
}
.registry-install-btn {
  width: 100%;
}
</style>
