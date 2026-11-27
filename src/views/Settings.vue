<template>
  <div class="settings-page">
    <div class="page-header">
      <h1 class="page-title">{{ t('settings.title') }}</h1>
    </div>

    <div class="settings-layout">
      <nav class="settings-nav" role="tablist" :aria-label="t('settings.title')">
        <button
          v-for="tab in navTabs"
          :key="tab.key"
          type="button"
          role="tab"
          :id="`settings-tab-${tab.key}`"
          :aria-selected="activeTab === tab.key"
          :aria-controls="`settings-panel-${tab.key}`"
          :tabindex="activeTab === tab.key ? 0 : -1"
          :class="['settings-nav__btn', { 'is-active': activeTab === tab.key }]"
          @click="activeTab = tab.key"
          @keydown.up.prevent="focusSiblingTab(-1)"
          @keydown.down.prevent="focusSiblingTab(1)"
        >
          <el-icon class="settings-nav__icon" aria-hidden="true" :size="16">
            <component :is="tab.icon" />
          </el-icon>
          <span class="settings-nav__label">{{ tab.label }}</span>
          <span v-if="tab.count" class="settings-nav__count">{{ tab.count }}</span>
        </button>

        <!-- v4.7: 设置升级为「配置容器」。此前模型/IM/权限/远程/账号散落在 rail、
             更多菜单与命令面板三处,用户不知道去哪配。现在统一从设置页进入。 -->
        <div
          class="settings-config-nav"
          role="group"
          :aria-label="t('settings.configNavTitle')"
          data-testid="settings-config-nav"
        >
          <div class="settings-config-nav__title">{{ t('settings.configNavTitle') }}</div>
          <div class="settings-config-nav__desc">{{ t('settings.configNavDesc') }}</div>
          <!-- v4.9：不再是整页跳转 —— 点击在右侧面板内切换（保留 href 兼容深链与既有测试） -->
          <a
            v-for="link in SETTINGS_LINKS"
            :key="link.path"
            :class="['settings-link', { 'is-active': activeTab === link.path }]"
            :href="`#${link.path}`"
            :title="t(link.descKey)"
            :data-path="link.path"
            :aria-current="activeTab === link.path ? 'page' : undefined"
            @click.prevent="selectConfig(link.path)"
          >
            <el-icon class="settings-link__icon" :size="15" aria-hidden="true">
              <component :is="link.icon" />
            </el-icon>
            <span class="settings-link__body">
              <span class="settings-link__title">{{ t(link.titleKey) }}</span>
              <span class="settings-link__desc">{{ t(link.descKey) }}</span>
            </span>
          </a>
        </div>
      </nav>

      <div class="settings-panels">

        <!-- v4.9：配置中心四项内嵌面板 —— 左侧选栏保留，右侧切换，不再整页跳转。
             必须是 .settings-panels 的直接子级（与其它 panel 同级），否则会被
             某个 v-show=false 的 panel 包住而整体 display:none。 -->
        <div
          v-if="embeddedConfigPath"
          :id="`settings-panel-${embeddedConfigPath}`"
          class="settings-panel settings-panel--embedded"
          role="tabpanel"
        >
          <KeepAlive>
            <component :is="embeddedConfigComponent" :key="embeddedConfigPath" embedded />
          </KeepAlive>
        </div>
        <div
          v-show="activeTab === 'basic'"
          id="settings-panel-basic"
          class="settings-panel"
          role="tabpanel"
          aria-labelledby="settings-tab-basic"
        >
          <div class="tab-content">
            <div class="settings-h">
              <h2>{{ t('settings.basicTitle') }}</h2>
              <div class="settings-h__desc">New World v4.4 · 1 改 token 已应用</div>
            </div>

            <section class="settings-section">
              <div class="setting-row">
                <div>
                  <div class="setting-label">{{ t('settings.autostartLabel') }}</div>
                  <div class="setting-desc">{{ t('settings.autostartDesc') }}</div>
                </div>
                <button
                  class="toggle"
                  :class="{ on: autostartEnabled }"
                  :aria-pressed="autostartEnabled"
                  :aria-label="t('settings.autostartLabel')"
                  @click="autostartEnabled = !autostartEnabled"
                />
              </div>

              <div class="setting-row">
                <div>
                  <div class="setting-label">{{ t('settings.showThinkingLabel') }}</div>
                  <div class="setting-desc">{{ t('settings.showThinkingDesc') }}</div>
                </div>
                <button
                  class="toggle"
                  :class="{ on: showThinkingBlock }"
                  :aria-pressed="showThinkingBlock"
                  :aria-label="t('settings.showThinkingLabel')"
                  @click="showThinkingBlock = !showThinkingBlock"
                />
              </div>

              <div class="setting-row">
                <div>
                  <div class="setting-label">{{ t('settings.themeLabel') }}</div>
                  <div class="setting-desc">{{ t('settings.themeDesc') }}</div>
                </div>
                <div class="radio-group">
                  <button
                    v-for="opt in themeOptions"
                    :key="opt.value"
                    :class="['radio', { active: selectedTheme === opt.value }]"
                    :aria-pressed="selectedTheme === opt.value"
                    @click="handleThemeChange(opt.value)"
                  >
{{ opt.label }}
</button>
                </div>
              </div>

              <div class="setting-row">
                <div>
                  <div class="setting-label">{{ t('settings.defaultModelLabel') }}</div>
                  <div class="setting-desc">{{ t('settings.defaultModelDesc') }}</div>
                </div>
                <select
                  class="select-input"
                  :value="defaultModelId"
                  @change="(e: Event) => defaultModelId = (e.target as HTMLSelectElement).value"
                >
                  <option v-if="modelsStore.providers.length === 0" value="">{{ t('settings.noModel') }}</option>
                  <optgroup
                    v-for="provider in modelsStore.providers"
                    :key="provider.id"
                    :label="provider.name"
                  >
                    <option
                      v-for="model in provider.models"
                      :key="model.id"
                      :value="`${provider.id}::${model.id}`"
                    >
{{ model.name }}
</option>
                  </optgroup>
                </select>
              </div>

              <div class="setting-row">
                <div>
                  <div class="setting-label">{{ t('settings.languageLabel') }}</div>
                  <div class="setting-desc">{{ t('settings.languageDesc') }}</div>
                </div>
                <div class="radio-group">
                  <button
                    v-for="opt in languageOptions"
                    :key="opt.value"
                    :class="['radio', { active: currentLocale === opt.value }]"
                    :aria-pressed="currentLocale === opt.value"
                    @click="handleLanguageChange(opt.value)"
                  >
{{ opt.label }}
</button>
                </div>
              </div>
            </section>

            <!-- M4.9 Codex 式双闸门：沙箱档位 + 自动审查 -->
            <div class="settings-h" style="margin-top: var(--space-4)">
              <h2>执行安全</h2>
              <div class="settings-h__desc">
                决定助手能在你电脑上"碰什么"，以及"什么时候需要先问你"。
              </div>
            </div>

            <section class="settings-section">
              <div class="setting-row">
                <div>
                  <div class="setting-label">沙箱档位</div>
                  <div class="setting-desc">{{ sandboxTierDesc }}</div>
                </div>
                <div class="radio-group">
                  <button
                    v-for="opt in sandboxTierOptions"
                    :key="opt.value"
                    :class="['radio', { active: sandboxTier === opt.value }]"
                    :aria-pressed="sandboxTier === opt.value"
                    @click="handleSandboxTierChange(opt.value)"
                  >
                    {{ opt.label }}
                  </button>
                </div>
              </div>

              <div class="setting-row">
                <div>
                  <div class="setting-label">自动审查低风险操作</div>
                  <div class="setting-desc">
                    开启后，低风险的「需确认」命令由模型先判一次、自动放行；
                    删库/格式化/提权/外传数据等硬禁区永不放行。
                  </div>
                </div>
                <el-switch
                  :model-value="autoReviewEnabled"
                  @change="(v: unknown) => handleAutoReviewChange(Boolean(v))"
                />
              </div>
            </section>

            <div class="settings-h" style="margin-top: var(--space-4)">
              <h2>{{ t('settings.shortcut') }}</h2>
              <div class="settings-h__desc">{{ t('settings.shortcutTip') }}</div>
            </div>

            <section class="settings-section">
              <div class="setting-row">
                <div>
                  <div class="setting-label">{{ t('settings.globalShortcut') }}</div>
                  <div class="setting-desc">Ctrl+Alt+P</div>
                </div>
                <ShortcutRecorder
                  v-model="shortcutConfig.toggle"
                  default-accelerator="Ctrl+Alt+P"
                />
              </div>
              <div class="setting-row">
                <div>
                  <div class="setting-label">{{ t('settings.feedback') }}</div>
                  <div class="setting-desc">{{ t('settings.openFeedback') }}</div>
                </div>
                <button class="btn-secondary" @click="showFeedbackModal = true">
                  {{ t('settings.openFeedback') }}
                </button>
              </div>
            </section>
          </div>
        </div>

        <div
          v-show="activeTab === 'models'"
          id="settings-panel-models"
          class="settings-panel"
          role="tabpanel"
          aria-labelledby="settings-tab-models"
        >
          <div class="tab-content">
            <div class="section-header">
              <div class="section-info">
                <span class="provider-count">{{ modelsStore.enabledCount }}/{{ modelsStore.totalCount }} {{ t('models.enabled') }}</span>
              </div>
              <el-button type="primary" @click="handleAddProvider">
                <el-icon><Plus /></el-icon>
                {{ t('models.addProvider') }}
              </el-button>
            </div>

            <el-empty v-if="modelsStore.providers.length === 0" :description="t('models.noProviders')">
              <el-button type="primary" @click="handleAddProvider">{{ t('models.addProvider') }}</el-button>
            </el-empty>

            <div v-else class="provider-grid">
              <el-card
                v-for="provider in modelsStore.providers"
                :key="provider.id"
                class="provider-card"
                :class="{ disabled: !provider.enabled }"
                shadow="hover"
              >
                <template #header>
                  <div class="provider-header">
                    <div class="provider-info">
                      <span class="provider-icon">
                        <el-icon :size="16"><component :is="getProviderIcon(provider.type)" /></el-icon>
                      </span>
                      <div class="provider-title">
                        <span class="provider-name">{{ provider.name }}</span>
                        <span class="provider-type">{{ getProviderTypeName(provider.type) }}</span>
                      </div>
                    </div>
                    <el-switch
                      :model-value="provider.enabled"
                      @change="(val: boolean) => handleToggleProvider(provider.id, val)"
                      :loading="isTogglingProvider(provider.id)"
                    />
                  </div>
                </template>

                <div class="provider-body">
                  <div class="connection-status">
                    <el-tag
                      :type="provider.enabled ? 'success' : 'info'"
                      size="small"
                      effect="plain"
                    >
                      {{ provider.enabled ? t('models.enabled') : t('models.disabled') }}
                    </el-tag>
                    <span class="model-count">{{ t('models.modelsCount', { count: provider.models.length }) }}</span>
                  </div>

                  <div class="models-list" v-if="provider.models.length > 0">
                    <el-scrollbar class="models-scrollbar">
                      <div
                        v-for="model in provider.models"
                        :key="model.id"
                        class="model-item"
                        :class="{ default: model.id === provider.defaultModel }"
                      >
                        <span class="model-name">{{ model.name }}</span>
                        <span class="model-capabilities">
                          <el-tag
                            v-for="cap in (model.capabilities || []).slice(0, 2)"
                            :key="cap"
                            size="small"
                            effect="plain"
                            type="info"
                          >{{ cap }}</el-tag>
                        </span>
                      </div>
                    </el-scrollbar>
                  </div>
                  <div v-else class="no-models">
                    {{ t('models.noModels') }}
                  </div>
                </div>

                <template #footer>
                  <div class="provider-actions">
                    <el-button
                      size="small"
                      :loading="modelsStore.isTesting(provider.id)"
                      @click="handleTestProvider(provider.id)"
                    >
                      {{ t('models.testConnection') }}
                    </el-button>
                    <el-button size="small" @click="handleManageModels(provider)">
                      {{ t('models.manageModels') }}
                    </el-button>
                    <el-button
                      v-if="!isVolcEngineProvider(provider)"
                      size="small"
                      @click="handleFetchModels(provider.id)"
                    >
                      {{ t('models.fetchModels') }}
                    </el-button>
                    <el-button size="small" @click="handleEditProvider(provider)">
                      {{ t('common.edit') }}
                    </el-button>
                    <el-button
                      size="small"
                      type="danger"
                      text
                      @click="handleDeleteProvider(provider.id, provider.name)"
                    >
                      {{ t('common.delete') }}
                    </el-button>
                  </div>
                </template>
              </el-card>
            </div>
          </div>
        </div>

        <div
          v-show="activeTab === 'mcp'"
          id="settings-panel-mcp"
          class="settings-panel"
          role="tabpanel"
          aria-labelledby="settings-tab-mcp"
        >
          <div class="tab-content">
            <div class="section-header">
              <span class="mcp-count">{{ mcpServers.length }} 个已配置</span>
              <el-button type="primary" @click="openAddDialog">
                <el-icon><Plus /></el-icon>
                添加 MCP Server
              </el-button>
            </div>

            <el-empty v-if="mcpServers.length === 0" description="暂无 MCP Server 配置">
              <el-button type="primary" @click="openAddDialog">添加 MCP Server</el-button>
            </el-empty>

            <div v-else class="mcp-grid">
              <McpServerCard
                v-for="server in mcpServers"
                :key="server.name"
                :server="server"
                @edit="openEditDialog(server)"
                @delete="handleDeleteServer(server.name)"
                @test="handleTestServer(server.name)"
              />
            </div>
          </div>
        </div>

        <div
          v-show="activeTab === 'memory'"
          id="settings-panel-memory"
          class="settings-panel"
          role="tabpanel"
          aria-labelledby="settings-tab-memory"
        >
          <div class="tab-content">
            <el-card class="settings-card">
              <el-form label-width="120px">
                <el-form-item :label="t('settings.coreMemory')">
                  <el-input
                    v-model="hermesMemoryStore.editingCoreMemory"
                    type="textarea"
                    :rows="6"
                    :placeholder="t('settings.coreMemoryPlaceholder')"
                    @input="handleCoreMemoryChange"
                  />
                </el-form-item>
                <el-form-item>
                  <el-button type="primary" size="small" @click="saveCoreMemory">
                    {{ t('settings.saveCoreMemory') }}
                  </el-button>
                  <el-button size="small" type="danger" @click="clearAllMemories">
                    {{ t('settings.clearAllMemory') }}
                  </el-button>
                </el-form-item>
              </el-form>
            </el-card>

            <!--
              【M3-A】嵌入后端配置 —— 知识库真向量的入口。
              此前 EmbeddingService 的三个真后端代码都在,但**没有任何配置入口**,
              provider 默认 stub-deterministic → 召回用 SHA-256 伪向量 = 噪声。
              本面板让用户能选后端、测连通、并看到「语义是否真的成立」。
            -->
            <el-card class="settings-card">
              <div class="settings-h">
                <h3>{{ t('settings.embeddingBackend') }}</h3>
              </div>
              <p class="settings-hint">{{ t('settings.embeddingBackendTip') }}</p>

              <el-alert
                :type="embeddingRealVectors ? 'success' : 'warning'"
                :closable="false"
                show-icon
                style="margin-bottom: var(--space-md);"
                :title="embeddingRealVectors ? t('settings.embeddingRealOn') : t('settings.embeddingRealOff')"
              />

              <el-form label-width="120px">
                <el-form-item :label="t('settings.embeddingProvider')">
                  <el-select v-model="embeddingForm.provider" style="width: 260px;">
                    <el-option value="stub" :label="t('settings.embeddingProviderStub')" />
                    <el-option value="ollama" :label="t('settings.embeddingProviderOllama')" />
                    <el-option value="openai" :label="t('settings.embeddingProviderOpenai')" />
                    <el-option value="zhipu" :label="t('settings.embeddingProviderZhipu')" />
                  </el-select>
                </el-form-item>

                <el-form-item v-if="embeddingForm.provider === 'ollama'" :label="t('settings.embeddingBaseUrl')">
                  <el-input v-model="embeddingForm.baseUrl" style="width: 260px;" placeholder="http://localhost:11434" />
                  <el-button size="small" style="margin-left: var(--space-sm);" @click="detectLocalEmbeddingModels">
                    {{ t('settings.embeddingDetect') }}
                  </el-button>
                </el-form-item>

                <el-form-item
                  v-if="embeddingForm.provider === 'openai' || embeddingForm.provider === 'zhipu'"
                  :label="t('settings.embeddingApiKey')"
                >
                  <el-input v-model="embeddingForm.apiKey" type="password" show-password style="width: 260px;" />
                </el-form-item>

                <el-form-item v-if="embeddingForm.provider !== 'stub'" :label="t('settings.embeddingModel')">
                  <el-select
                    v-if="embeddingForm.provider === 'ollama' && localEmbeddingModels.length > 0"
                    v-model="embeddingForm.model"
                    style="width: 260px;"
                    :placeholder="t('settings.embeddingModelPlaceholder')"
                    clearable
                  >
                    <el-option v-for="m in localEmbeddingModels" :key="m" :label="m" :value="m" />
                  </el-select>
                  <el-input
                    v-else
                    v-model="embeddingForm.model"
                    style="width: 260px;"
                    :placeholder="t('settings.embeddingModelPlaceholder')"
                  />
                </el-form-item>

                <el-form-item>
                  <el-button type="primary" size="small" @click="saveEmbeddingConfig">
                    {{ t('settings.embeddingSave') }}
                  </el-button>
                  <el-button size="small" @click="testEmbeddingBackend">
                    {{ t('settings.embeddingTest') }}
                  </el-button>
                </el-form-item>

                <el-form-item v-if="embeddingProbe">
                  <el-alert
                    :type="embeddingProbe.ok ? (embeddingProbe.semanticCheck?.meaningful ? 'success' : 'warning') : 'error'"
                    :closable="false"
                    show-icon
                    :title="embeddingProbeTitle"
                    :description="embeddingProbeDetail"
                  />
                </el-form-item>
              </el-form>
            </el-card>
          </div>
        </div>

        <div
          v-show="activeTab === 'about'"
          id="settings-panel-about"
          class="settings-panel"
          role="tabpanel"
          aria-labelledby="settings-tab-about"
        >
          <div class="tab-content">
            <el-card class="settings-card">
              <template #header><span>{{ t('about.appInfo') }}</span></template>
              <el-form label-width="120px">
                <el-form-item :label="t('about.currentVersion')">
                  <span class="version-text">{{ appVersion || t('about.loadingVersion') }}</span>
                </el-form-item>
                <el-form-item :label="t('about.updateStatus')">
                  <el-tag v-if="updateStatus === 'idle'" type="info" effect="plain">{{ t('about.updateIdle') }}</el-tag>
                  <el-tag v-else-if="updateStatus === 'checking'" type="info" effect="plain">{{ t('about.updateChecking') }}</el-tag>
                  <el-tag v-else-if="updateStatus === 'up-to-date'" type="success" effect="plain">{{ t('about.updateUpToDate') }}</el-tag>
                  <el-tag v-else-if="updateStatus === 'available'" type="warning" effect="plain">{{ t('about.updateAvailable', { version: availableVersion }) }}</el-tag>
                  <el-tag v-else-if="updateStatus === 'downloading'" type="warning" effect="plain">{{ t('about.updateDownloading') }}</el-tag>
                  <el-tag v-else-if="updateStatus === 'downloaded'" type="success" effect="plain">{{ t('about.updateDownloaded') }}</el-tag>
                  <el-tag v-else-if="updateStatus === 'error'" type="danger" effect="plain">{{ t('about.updateError') }}</el-tag>
                </el-form-item>
                <el-form-item>
                  <el-button type="primary" :loading="isChecking" @click="handleCheckUpdate">{{ t('about.checkUpdate') }}</el-button>
                  <el-button
                    v-if="updateStatus === 'available'"
                    type="primary"
                    :loading="isDownloading"
                    @click="handleDownloadUpdate"
                  >
{{ t('about.downloadUpdate', { version: availableVersion }) }}
</el-button>
                  <el-button
                    v-if="updateStatus === 'downloaded'"
                    type="success"
                    @click="handleInstallUpdate"
                  >
{{ t('about.installUpdate') }}
</el-button>
                </el-form-item>
                <el-form-item v-if="updateError" label=" ">
                  <div class="error-text">{{ updateError }}</div>
                </el-form-item>
              </el-form>
            </el-card>
          </div>
        </div>

        <!-- 本地备份：无服务器方案下替代账号云同步 -->
        <div
          v-show="activeTab === 'data'"
          id="settings-panel-data"
          class="settings-panel"
          role="tabpanel"
          aria-labelledby="settings-tab-data"
        >
          <div class="tab-content" data-testid="backup-panel">
            <div class="settings-h">
              <h2>{{ t('settings.backupTitle') }}</h2>
              <div class="settings-h__desc">{{ t('settings.backupDesc') }}</div>
            </div>

            <section class="settings-section">
              <div class="setting-row">
                <div>
                  <div class="setting-label">{{ t('settings.backupIncludeKeys') }}</div>
                  <div class="setting-desc">{{ t('settings.backupIncludeKeysDesc') }}</div>
                </div>
                <button
                  class="toggle"
                  :class="{ on: backupIncludeKeys }"
                  :aria-pressed="backupIncludeKeys"
                  :aria-label="t('settings.backupIncludeKeys')"
                  @click="backupIncludeKeys = !backupIncludeKeys"
                />
              </div>

              <div class="backup-actions">
                <el-button type="primary" :loading="backupBusy" @click="handleBackupCreate">
                  {{ backupBusy ? t('settings.backupCreating') : t('settings.backupCreate') }}
                </el-button>
                <el-button :disabled="backupBusy" @click="handleBackupImport">{{ t('settings.backupImport') }}</el-button>
                <el-button @click="handleBackupOpenFolder">{{ t('settings.backupOpenFolder') }}</el-button>
              </div>

              <div class="backup-note">{{ t('settings.backupScopeNote') }}</div>
              <div class="backup-note">{{ t('settings.backupKeyNotice') }}</div>
              <div class="backup-note">{{ t('settings.backupSafetyNote') }}</div>
            </section>

            <section class="settings-section">
              <div class="setting-label">{{ t('settings.backupListTitle') }}</div>
              <div v-if="backupList.length === 0" class="backup-empty" data-testid="backup-empty">
                {{ t('settings.backupEmpty') }}
              </div>
              <div v-else class="backup-list" data-testid="backup-list">
                <div
                  v-for="b in backupList"
                  :key="b.filePath"
                  class="backup-row"
                  :data-testid="`backup-row-${b.fileName}`"
                >
                  <div class="backup-meta">
                    <div class="backup-name">{{ b.fileName }}</div>
                    <div class="backup-sub">
                      {{ formatBackupTime(b.createdAt) }} · {{ t('settings.backupSize') }} {{ formatBackupSize(b.size) }} · {{ b.appVersion }}
                      <span v-if="b.apiKeysIncluded" class="backup-warn"> · {{ t('settings.backupKeysPlaintext') }}</span>
                    </div>
                  </div>
                  <div class="backup-row-actions">
                    <el-button size="small" text :disabled="backupBusy" @click="handleBackupRestore(b.filePath)">
                      {{ t('settings.backupRestore') }}
                    </el-button>
                    <el-button size="small" text @click="handleBackupExport(b.filePath)">
                      {{ t('settings.backupExport') }}
                    </el-button>
                    <el-button size="small" text @click="handleBackupShow(b.filePath)">
                      {{ t('settings.backupOpenFolder') }}
                    </el-button>
                  </div>
                </div>
              </div>
            </section>
          </div>

        </div>
      </div>
    </div>

    <!-- 模型管理对话框 -->
    <el-dialog
      v-model="modelDialogVisible"
      :title="isEditingModel ? t('models.editProvider') : t('models.addProvider')"
      width="600px"
      :close-on-click-modal="false"
    >
      <el-form
        ref="modelFormRef"
        :model="modelFormData"
        :rules="modelFormRules"
        label-width="120px"
      >
        <el-form-item :label="t('models.providerName')" prop="name">
          <el-input v-model="modelFormData.name" :placeholder="t('models.providerNamePlaceholder')" />
        </el-form-item>

        <el-form-item :label="t('models.type')" prop="type">
          <el-select v-model="modelFormData.type" :placeholder="t('models.selectType')" @change="handleTypeChange">
            <el-option
              v-for="template in allProviderOptions"
              :key="template.type"
              :value="template.type"
            >
              <span style="margin-right: var(--space-sm); display: inline-flex; align-items: center;">
                <el-icon :size="14"><component :is="getProviderIcon(template.type)" /></el-icon>
              </span>
              {{ template.name }}
            </el-option>
          </el-select>
        </el-form-item>

        <el-form-item :label="t('models.apiUrl')" prop="baseUrl">
          <el-input v-model="modelFormData.baseUrl" :placeholder="t('models.apiUrlPlaceholder')" />
        </el-form-item>

        <el-form-item :label="t('models.apiKey')" prop="apiKey">
          <el-input
            v-model="modelFormData.apiKey"
            type="password"
            show-password
            :placeholder="t('models.apiKeyPlaceholder')"
          />
          <div v-if="modelFormData.type === 'volc_ark'" class="form-tip">
            {{ t('models.apiKeyVolcTip') }}
          </div>
          <div v-if="modelFormData.type === 'anthropic'" class="form-tip">
            {{ t('models.apiKeyAnthropicTip') }}
          </div>
        </el-form-item>

        <template v-if="modelFormData.type === 'azure'">
          <el-form-item :label="t('models.deploymentName')" prop="deploymentName">
            <el-input v-model="modelFormData.deploymentName" :placeholder="t('models.deploymentPlaceholder')" />
          </el-form-item>
          <el-form-item :label="t('models.apiVersion')" prop="apiVersion">
            <el-input v-model="modelFormData.apiVersion" :placeholder="t('models.apiVersionPlaceholder')" />
          </el-form-item>
        </template>

        <template v-if="modelFormData.type === 'anthropic'">
          <el-form-item :label="t('models.organization')" prop="organization">
            <el-input v-model="modelFormData.organization" :placeholder="t('models.organizationPlaceholder')" />
          </el-form-item>
        </template>

        <el-form-item :label="t('models.timeout')" prop="timeout">
          <el-input-number
            v-model="modelFormData.timeout"
            :min="5000"
            :max="300000"
            :step="5000"
          />
          <span class="form-tip">{{ t('models.timeoutUnit') }}</span>
        </el-form-item>

        <el-form-item :label="t('models.modelId')">
          <el-input v-model="modelFormData.modelId" :placeholder="isVolcEngineForm() ? t('models.modelIdPlaceholder') : t('models.modelIdPlaceholderNormal')" />
          <div v-if="isVolcEngineForm()" class="form-tip">
            {{ t('models.volcCodingPlanHint') }}
          </div>
        </el-form-item>

        <el-form-item :label="t('models.enabled_')">
          <el-switch v-model="modelFormData.enabled" />
        </el-form-item>
      </el-form>

      <template #footer>
        <el-button @click="modelDialogVisible = false">{{ t('common.cancel') }}</el-button>
        <el-button type="primary" :loading="modelSubmitting" @click="handleModelSubmit">
          {{ isEditingModel ? t('common.save') : t('common.add') }}
        </el-button>
      </template>
    </el-dialog>

    <!-- 模型测试结果对话框 -->
    <el-dialog v-model="modelTestDialogVisible" :title="t('models.testResultTitle')" width="400px">
      <div v-if="modelTestResult">
        <el-result
          :icon="modelTestResult.success ? 'success' : 'error'"
          :title="modelTestResult.success ? t('models.connectionSuccess') : t('models.connectionFailed')"
        >
          <template #sub-title>
            <div v-if="modelTestResult.success">
              <p>{{ t('models.latencyMs', { ms: modelTestResult.latency }) }}</p>
            </div>
            <div v-else>
              <p>{{ modelTestResult.error }}</p>
            </div>
          </template>
        </el-result>
      </div>
    </el-dialog>

    <!-- 管理模型对话框 -->
    <el-dialog v-model="manageModelsDialogVisible" :title="t('models.manageModelsTitle')" width="600px">
      <div v-if="currentProvider">
        <div class="model-list">
          <el-empty v-if="editingModels.length === 0" description="暂无模型" />
          <div v-else>
            <div v-for="(model, index) in editingModels" :key="model.id" class="model-item">
              <span class="model-name">{{ model.name }}</span>
              <el-button size="small" type="danger" text @click="removeModel(index)">{{ t('common.delete') }}</el-button>
            </div>
          </div>
        </div>

        <el-divider />

        <div class="add-model">
          <el-input v-model="newModelId" :placeholder="t('models.inputNewModelId')" style="margin-right: var(--space-sm);" />
          <el-button type="primary" @click="addModel">{{ t('models.addModel') }}</el-button>
        </div>
      </div>

      <template #footer>
        <el-button @click="manageModelsDialogVisible = false">{{ t('common.cancel') }}</el-button>
        <el-button type="primary" @click="saveModels">{{ t('common.save') }}</el-button>
      </template>
    </el-dialog>

    <!-- MCP Server 表单对话框 -->
    <McpServerFormDialog
      v-model="mcpDialogVisible"
      :server="editingServer"
      @save="handleSaveMcp"
    />

    <FeedbackModal v-model="showFeedbackModal" />
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted, computed, nextTick, watch, markRaw } from 'vue';
import { ElMessage } from "element-plus/es/components/message/index"
import { ElMessageBox } from "element-plus/es/components/message-box/index";
import { useI18n } from 'vue-i18n';
import ShortcutRecorder from '@/components/settings/ShortcutRecorder.vue';
import FeedbackModal from '@/components/common/FeedbackModal.vue';
import McpServerCard from '@/components/settings/McpServerCard.vue';
import McpServerFormDialog from '@/components/settings/McpServerFormDialog.vue';
import { useAppStore } from '@/stores/app';
import { useHermesMemoryStore } from '@/stores/hermesMemory';
import { useModelsStore, PROVIDER_DEFAULTS, type ProviderConfig, type ProviderFormData } from '@/stores/models';
import { Plus, MagicStick, Memo, Connection, Sunny, Box, Lightning, Setting } from '@element-plus/icons-vue';
import { setLocale, type SupportedLocale } from '@/locales';
import type { BackupInfo } from '@/types/electron-api';
import { SETTINGS_LINKS } from '@/components/layout/nav-config';
import { useRoute, useRouter } from 'vue-router';
// v4.9：配置中心四项内嵌为设置页右侧面板（左侧选栏保留，右侧切换，不再整页跳转）
import ImManagement from '@/views/ImManagement.vue';
import Permissions from '@/views/Permissions.vue';
import RemoteControl from '@/views/RemoteControl.vue';
import ImAccounts from '@/views/ImAccounts.vue';

const { t } = useI18n();
// 防御式取路由：单测/嵌入场景可能没有安装 vue-router（注入为 undefined），
// 这里不能让 route.path 访问直接崩掉整个设置页。
const route = useRoute() as ReturnType<typeof useRoute> | undefined;
const router = useRouter() as ReturnType<typeof useRouter> | undefined;

/**
 * v4.9：路由层把 /im-management 等四条配置路由统一渲染为本组件，并通过该 prop
 * 告知应选中哪个配置项 —— 这样深链与 e2e 直达仍落在设置页内嵌面板里，
 * 不再出现「点配置入口 → 整页跳走」的割裂感。
 */
const props = defineProps<{ initialConfigPath?: string }>();

/** 配置中心路由 → 内嵌组件映射（markRaw 防止被响应式代理） */
const CONFIG_PAGE_COMPONENTS: Record<string, ReturnType<typeof markRaw>> = {
  '/im-management': markRaw(ImManagement),
  '/permissions': markRaw(Permissions),
  '/remote-control': markRaw(RemoteControl),
  '/settings/im-accounts': markRaw(ImAccounts),
};

/** 当前选中的配置中心路径；非配置项时为 null */
const embeddedConfigPath = computed(() =>
  SETTINGS_LINKS.some((l) => l.path === activeTab.value) ? activeTab.value : null,
);
const embeddedConfigComponent = computed(() =>
  embeddedConfigPath.value ? CONFIG_PAGE_COMPONENTS[embeddedConfigPath.value] : null,
);

/**
 * 点击配置中心入口：在设置页内切换（不整页跳转）。
 * 同时把 hash 换成目标路径，保证深链可分享、既有 e2e 的 waitForURL 仍成立。
 */
function selectConfig(path: string): void {
  activeTab.value = path;
  if (route && router && route.path !== path) void router.replace(path);
}

// 路由变化时同步选中态：回到 /settings 显示基础设置；进入配置路由则选中对应项。
// （同一组件实例被复用时 watch 生效，避免「从 /permissions 点侧栏设置仍停在权限页」）
watch(
  () => route?.path,
  (p) => {
    if (p === '/settings') {
      activeTab.value = 'basic';
    } else if (p && SETTINGS_LINKS.some((l) => l.path === p)) {
      activeTab.value = p;
    }
  },
);

const appStore = useAppStore();
const hermesMemoryStore = useHermesMemoryStore();
const modelsStore = useModelsStore();

// 配置中心四条路由直达时，初始选中对应配置项；否则从基础设置开始
const activeTab = ref(
  props.initialConfigPath && SETTINGS_LINKS.some((l) => l.path === props.initialConfigPath)
    ? props.initialConfigPath
    : 'basic',
);
// 本地备份（无账号云同步）
const backupList = ref<BackupInfo[]>([]);
const backupIncludeKeys = ref(false);
const backupBusy = ref(false);
const selectedTheme = ref<'light' | 'dark' | 'system'>(appStore.themeMode);
const showFeedbackModal = ref(false);

// v4.4: setting-row 列表用
const autostartEnabled = ref<boolean>(false);
const showThinkingBlock = ref<boolean>(true);
const defaultModelId = ref<string>('');
const currentLocale = ref<SupportedLocale>(
  (typeof localStorage !== 'undefined' && (localStorage.getItem('nw:locale') as SupportedLocale)) || 'zh-CN'
);

const themeOptions = [
  { value: 'light' as const, label: t('settings.themeLight') },
  { value: 'dark' as const, label: t('settings.themeDark') },
  { value: 'system' as const, label: t('settings.themeSystem') }
];

const languageOptions = [
  { value: 'zh-CN' as const, label: '中文' },
  { value: 'en-US' as const, label: 'English' }
];

// ========== M4.9 执行安全（Codex 式双闸门）==========
type SandboxTier = 'read-only' | 'workspace' | 'full';
const sandboxTier = ref<SandboxTier>('workspace');
const autoReviewEnabled = ref(false);

const sandboxTierOptions: Array<{ value: SandboxTier; label: string }> = [
  { value: 'read-only', label: '只读' },
  { value: 'workspace', label: '工作区' },
  { value: 'full', label: '完全开放' },
];

const sandboxTierDesc = computed(() => {
  switch (sandboxTier.value) {
    case 'read-only':
      return '只允许查询类命令，任何写操作与命令执行都会被拒绝。';
    case 'full':
      return '不受限制。仅建议在受控环境中使用 —— 助手可以执行任意命令。';
    default:
      return '工作区内可读写可执行；访问区外路径或外部网络时需要你确认。';
  }
});

async function loadApprovalConfig(): Promise<void> {
  try {
    const res = await window.electronAPI?.sandbox?.getApprovalConfig?.();
    if (res?.success && res.data) {
      sandboxTier.value = res.data.tier;
      autoReviewEnabled.value = res.data.autoReview;
    }
  } catch {
    /* 读失败用默认值，不打扰用户 */
  }
}

async function handleSandboxTierChange(tier: SandboxTier): Promise<void> {
  const prev = sandboxTier.value;
  sandboxTier.value = tier;
  try {
    const res = await window.electronAPI?.sandbox?.setApprovalConfig?.({ tier });
    if (!res?.success) sandboxTier.value = prev;
  } catch {
    sandboxTier.value = prev;
  }
}

async function handleAutoReviewChange(enabled: boolean): Promise<void> {
  const prev = autoReviewEnabled.value;
  autoReviewEnabled.value = enabled;
  try {
    const res = await window.electronAPI?.sandbox?.setApprovalConfig?.({ autoReview: enabled });
    if (!res?.success) autoReviewEnabled.value = prev;
  } catch {
    autoReviewEnabled.value = prev;
  }
}

function handleLanguageChange(locale: SupportedLocale): void {
  currentLocale.value = locale;
  setLocale(locale);
}

const navTabs = computed(() => [
  { key: 'basic', label: t('settings.basicTab'), icon: 'Setting' },
  {
    key: 'models',
    label: t('settings.modelsTab'),
    icon: 'MagicStick',
    count: modelsStore.providers.length > 0
      ? `${modelsStore.enabledCount}/${modelsStore.totalCount}`
      : ''
  },
  {
    key: 'mcp',
    label: t('settings.mcpTab'),
    icon: 'Connection',
    count: mcpServers.value.length > 0 ? String(mcpServers.value.length) : ''
  },
  { key: 'memory', label: t('settings.memoryTab'), icon: 'Memo' },
  { key: 'data', label: t('settings.dataTab'), icon: 'Box' },
  { key: 'about', label: t('settings.aboutTab'), icon: 'InfoFilled' }
]);

// ========== 本地备份 ==========
function formatBackupTime(ts: number): string {
  try { return new Date(ts).toLocaleString() } catch { return String(ts) }
}

function formatBackupSize(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function backupErrText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

async function refreshBackupList(): Promise<void> {
  try {
    const r = await window.electronAPI.backup.list();
    backupList.value = r?.success && Array.isArray(r.data) ? r.data : [];
  } catch {
    backupList.value = [];
  }
}

async function handleBackupCreate(): Promise<void> {
  backupBusy.value = true;
  try {
    const r = await window.electronAPI.backup.create({ includeApiKeys: backupIncludeKeys.value });
    if (!r?.success) throw new Error(r?.error || 'create failed');
    await refreshBackupList();
    ElMessage.success(t('settings.backupCreateOk'));
  } catch (e) {
    ElMessage.error(t('settings.backupCreateFail', { error: backupErrText(e) }));
  } finally {
    backupBusy.value = false;
  }
}

async function doRestore(filePath: string): Promise<void> {
  try {
    await ElMessageBox.confirm(t('settings.backupRestoreConfirm'), t('settings.backupRestore'), { type: 'warning' });
  } catch {
    return; // 用户取消
  }
  backupBusy.value = true;
  try {
    const r = await window.electronAPI.backup.restore(filePath);
    if (!r?.success) throw new Error(r?.error || 'restore failed');
    await refreshBackupList();
    ElMessage.success(t('settings.backupRestoreOk'));
  } catch (e) {
    ElMessage.error(t('settings.backupRestoreFail', { error: backupErrText(e) }));
  } finally {
    backupBusy.value = false;
  }
}

function handleBackupRestore(filePath: string): Promise<void> {
  return doRestore(filePath);
}

async function handleBackupImport(): Promise<void> {
  try {
    const picked = await window.electronAPI.dialog.openFile({
      title: t('settings.backupImportSelect'),
      properties: ['openFile'],
      filters: [{ name: '本地备份', extensions: ['zip'] }],
    }) as { filePaths?: string[]; path?: string } | undefined;
    const filePath = picked?.filePaths?.[0] ?? picked?.path;
    if (filePath) await doRestore(filePath);
  } catch {
    // 用户取消选文件
  }
}

async function handleBackupExport(filePath: string): Promise<void> {
  try {
    const saved = await window.electronAPI.dialog.saveFile({
      title: t('settings.backupExport'),
      defaultPath: filePath.split(/[\\/]/).pop(),
      filters: [{ name: '本地备份', extensions: ['zip'] }],
    });
    if (saved?.canceled || !saved.filePath) return;
    const r = await window.electronAPI.backup.copy(filePath, saved.filePath);
    if (!r?.success) throw new Error(r?.error || 'copy failed');
    ElMessage.success(saved.filePath);
  } catch (e) {
    ElMessage.error(backupErrText(e));
  }
}

async function handleBackupShow(filePath: string): Promise<void> {
  try {
    const r = await window.electronAPI.file.showInFolder(filePath);
    if (!r?.success) ElMessage.error(r?.error || 'open folder failed');
  } catch (e) {
    ElMessage.error(backupErrText(e));
  }
}

async function handleBackupOpenFolder(): Promise<void> {
  try {
    const r = await window.electronAPI.backup.openFolder();
    if (!r?.success) ElMessage.error(r?.error || 'open folder failed');
  } catch (e) {
    ElMessage.error(backupErrText(e));
  }
}

function focusSiblingTab(direction: -1 | 1): void {
  const keys = navTabs.value.map(tab => tab.key);
  const idx = keys.indexOf(activeTab.value);
  if (idx < 0) return;
  const nextIdx = (idx + direction + keys.length) % keys.length;
  activeTab.value = keys[nextIdx];
  nextTick(() => {
    const el = document.getElementById(`settings-tab-${keys[nextIdx]}`) as HTMLButtonElement | null;
    el?.focus();
  });
}

const shortcutConfig = ref({ toggle: 'Ctrl+Alt+P' });

// 模型管理相关
const modelDialogVisible = ref(false);
const modelTestDialogVisible = ref(false);
const modelSubmitting = ref(false);
const isEditingModel = ref(false);
const editingModelId = ref('');
const modelFormRef = ref();
const modelTestResult = ref<{ success: boolean; latency?: number; error?: string } | null>(null);
const togglingProviders = ref<Set<string>>(new Set());

const modelFormData = reactive<ProviderFormData & { modelId: string }>({
  name: '',
  type: 'openai',
  enabled: true,
  baseUrl: '',
  apiKey: '',
  organization: '',
  deploymentName: '',
  apiVersion: '',
  timeout: 60000,
  maxRetries: 3,
  modelId: ''
});

// 管理模型对话框相关
const manageModelsDialogVisible = ref(false);
const currentProvider = ref<ProviderConfig | null>(null);
const editingModels = ref<any[]>([]);
const newModelId = ref('');

function isVolcEngineProvider(provider: ProviderConfig): boolean {
  return provider.type === 'volc_ark' || Boolean(provider.baseUrl && provider.baseUrl.includes('coding/v3'));
}

function isVolcEngineForm(): boolean {
  return modelFormData.type === 'volc_ark' || Boolean(modelFormData.baseUrl && modelFormData.baseUrl.includes('coding/v3'));
}

const modelFormRules = computed(() => ({
  name: [{ required: true, message: t('models.pleaseEnterName'), trigger: 'blur' }],
  type: [{ required: true, message: t('models.pleaseSelectType'), trigger: 'change' }],
  baseUrl: [{ required: true, message: t('models.pleaseEnterApiUrl'), trigger: 'blur' }]
}));

const allProviderOptions = computed(() => {
  const templates = [...modelsStore.providerTemplates];
  // 确保自定义选项始终在最后
  if (!templates.find(t => t.type === 'custom')) {
    templates.push({ name: t('models.customOption'), type: 'custom', defaultConfig: {} });
  }
  return templates;
});

// MCP 配置相关
const mcpServers = ref<any[]>([]);
const mcpDialogVisible = ref(false);
const editingServer = ref<any>(null);

// 关于 / 自动更新
const appVersion = ref('');
type UpdateStatus = 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'downloaded' | 'error';
const updateStatus = ref<UpdateStatus>('idle');
const availableVersion = ref('');
const updateError = ref('');
const isChecking = ref(false);
const isDownloading = ref(false);

const handleThemeChange = (themeKey: 'light' | 'dark' | 'system'): void => {
  appStore.setTheme(themeKey);
  ElMessage.success(t('settings.themeChanged'));
};

async function loadShortcutConfig(): Promise<void> {
  try {
    if ((window as any).electronAPI?.shortcut) {
      const result = await (window as any).electronAPI.shortcut.get();
      if (result?.success && result?.data) {
        shortcutConfig.value = {
          toggle: result.data.toggle || 'Ctrl+Alt+P'
        };
      }
    }
  } catch (error) {
    console.error('加载快捷键配置失败:', error);
  }
}

// v4.4: ShortcutRecorder 改用 inline save,自动 watch
watch(
  () => shortcutConfig.value.toggle,
  async (newVal, oldVal) => {
    if (newVal && newVal !== oldVal) {
      try {
        await (window as any).electronAPI?.shortcut?.set('toggle', newVal);
      } catch (e) {
        console.error('快捷键自动保存失败:', e);
      }
    }
  }
);

async function saveShortcutConfig(): Promise<void> {
  try {
    if ((window as any).electronAPI?.shortcut) {
      const result = await (window as any).electronAPI.shortcut.set('toggle', shortcutConfig.value.toggle);
      if (result?.success) {
        ElMessage.success(t('settings.shortcutSaved'));
      } else {
        ElMessage.error(result?.error || t('settings.saveFailed'));
      }
    }
  } catch (error) {
    console.error('保存快捷键配置失败:', error);
    ElMessage.error(t('settings.saveFailed'));
  }
}

function resetShortcutConfig(): void {
  shortcutConfig.value.toggle = 'Ctrl+Alt+P';
  saveShortcutConfig();
}

let memorySaveTimer: any = null;
function handleCoreMemoryChange(value: string): void {
  if (memorySaveTimer) {
    clearTimeout(memorySaveTimer);
  }
  memorySaveTimer = setTimeout(async () => {
    await hermesMemoryStore.updateCoreMemory(value);
  }, 500);
}

async function saveCoreMemory(): Promise<void> {
  await hermesMemoryStore.updateCoreMemory(hermesMemoryStore.editingCoreMemory);
  ElMessage.success(t('settings.coreMemorySaved'));
}

// ══════════ 【M3-A】嵌入后端配置 ══════════
// 此前真后端(ollama/openai/zhipu)代码都在,但没有任何配置入口 →
// provider 恒为 stub-deterministic → 召回用 SHA-256 伪向量 = 噪声。

const embeddingForm = reactive({
  provider: 'stub' as 'stub' | 'ollama' | 'openai' | 'zhipu',
  baseUrl: '',
  apiKey: '',
  model: '',
});
const embeddingRealVectors = ref(false);
const localEmbeddingModels = ref<string[]>([]);
const embeddingProbe = ref<any>(null);

async function loadEmbeddingConfig(): Promise<void> {
  try {
    const res = await (window as any).electronAPI?.hermes?.embedding?.get?.();
    if (res?.success && res.data) {
      const cfg = res.data.config || {};
      embeddingForm.provider = (cfg.provider || 'stub') as any;
      embeddingForm.baseUrl = cfg.baseUrl || '';
      embeddingForm.apiKey = cfg.apiKey || '';
      embeddingForm.model = cfg.model || '';
      embeddingRealVectors.value = !!res.data.realVectors;
    }
  } catch (e) {
    console.error('读取嵌入后端配置失败', e);
  }
}

async function detectLocalEmbeddingModels(): Promise<void> {
  try {
    const res = await (window as any).electronAPI?.hermes?.embedding?.detect?.(embeddingForm.baseUrl || undefined);
    if (res?.success && res.data) {
      localEmbeddingModels.value = res.data.models || [];
      if (localEmbeddingModels.value.length === 0) {
        ElMessage.warning(res.data.available
          ? t('settings.embeddingNoLocalModels')
          : t('settings.embeddingOllamaDown'));
      }
    }
  } catch (e) {
    console.error('检测本地嵌入模型失败', e);
  }
}

async function saveEmbeddingConfig(): Promise<void> {
  try {
    const cfg: any = { provider: embeddingForm.provider };
    if (embeddingForm.provider !== 'stub') {
      if (embeddingForm.baseUrl) cfg.baseUrl = embeddingForm.baseUrl;
      if (embeddingForm.apiKey) cfg.apiKey = embeddingForm.apiKey;
      if (embeddingForm.model) cfg.model = embeddingForm.model;
    }
    const res = await (window as any).electronAPI?.hermes?.embedding?.set?.(cfg);
    if (res?.success) {
      embeddingRealVectors.value = embeddingForm.provider !== 'stub';
      ElMessage.success(t('settings.embeddingSaved'));
    }
  } catch (e) {
    console.error('保存嵌入后端配置失败', e);
  }
}

async function testEmbeddingBackend(): Promise<void> {
  embeddingProbe.value = null;
  try {
    const res = await (window as any).electronAPI?.hermes?.embedding?.test?.({
      provider: embeddingForm.provider,
      baseUrl: embeddingForm.baseUrl || undefined,
      apiKey: embeddingForm.apiKey || undefined,
      modelName: embeddingForm.model || undefined,
    });
    if (res?.success) {
      embeddingProbe.value = res.data;
    } else {
      embeddingProbe.value = { ok: false, error: res?.error };
    }
  } catch (e) {
    embeddingProbe.value = { ok: false, error: String(e) };
  }
}

const embeddingProbeTitle = computed(() => {
  const p = embeddingProbe.value;
  if (!p) return '';
  if (!p.ok) return `${t('settings.embeddingTestFail')}${p.error ? ': ' + p.error : ''}`;
  return t('settings.embeddingTestOk');
});

const embeddingProbeDetail = computed(() => {
  const p = embeddingProbe.value;
  if (!p || !p.ok) return '';
  const parts: string[] = [];
  if (p.dimension) parts.push(`${p.dimension} 维`);
  if (p.latencyMs !== undefined) parts.push(`${p.latencyMs}ms`);
  if (p.semanticCheck) {
    parts.push(p.semanticCheck.meaningful
      ? t('settings.embeddingSemanticOk')
      : t('settings.embeddingSemanticBad'));
    parts.push(`相近 ${p.semanticCheck.similar} / 无关 ${p.semanticCheck.unrelated}`);
  }
  return parts.join(' · ');
});

async function clearAllMemories(): Promise<void> {
  try {
    await ElMessageBox.confirm(t('dialog.confirmClearMemory'), t('dialog.clearMemoryTitle'), {
      confirmButtonText: t('dialog.clearMemoryButton'),
      cancelButtonText: t('dialog.cancelButton'),
      type: t('dialog.warningType') as 'warning'
    });
    hermesMemoryStore.setCoreMemory('');
    hermesMemoryStore.setExperienceMemory('');
    hermesMemoryStore.setMemories([]);
    hermesMemoryStore.editingCoreMemory = '';
    await hermesMemoryStore.saveCoreMemory('');
    ElMessage.success(t('settings.memoriesCleared'));
  } catch {}
}

function getProviderIcon(type: string): string {
  const icons: Record<string, string> = {
    openai: 'MagicStick',
    anthropic: 'Memo',
    deepseek: 'Connection',
    azure: 'Sunny',
    ollama: 'Box',
    openrouter: 'Connection',
    volc_ark: 'Lightning',
    custom: 'Setting'
  };
  return icons[type] || 'Box';
}

function getProviderTypeName(type: string): string {
  const map: Record<string, string> = {
    openai: t('models.typeOpenai'),
    anthropic: t('models.typeAnthropic'),
    deepseek: t('models.typeDeepseek'),
    azure: t('models.typeAzure'),
    ollama: t('models.typeOllama'),
    openrouter: t('models.typeOpenrouter'),
    volc_ark: t('models.typeVolcArk'),
    custom: t('models.typeCustom')
  };
  return map[type] || type;
}

function handleTypeChange(type: string): void {
  const selectedTemplate = modelsStore.providerTemplates.find(t => t.type === type);
  if (selectedTemplate) {
    modelFormData.name = selectedTemplate.defaultConfig.name || '';
    modelFormData.baseUrl = selectedTemplate.defaultConfig.baseUrl || '';
    modelFormData.timeout = selectedTemplate.defaultConfig.timeout || 60000;
    modelFormData.maxRetries = selectedTemplate.defaultConfig.maxRetries || 3;
  } else if (type === 'custom') {
    modelFormData.name = '';
    modelFormData.baseUrl = '';
  } else {
    const defaults = PROVIDER_DEFAULTS[type as keyof typeof PROVIDER_DEFAULTS];
    if (defaults) {
      modelFormData.baseUrl = defaults.baseUrl || '';
      modelFormData.timeout = defaults.timeout || 60000;
      modelFormData.maxRetries = defaults.maxRetries || 3;
      if (defaults.name) {
        modelFormData.name = modelFormData.name || defaults.name;
      }
    }
  }
}

async function handleAddProvider(): Promise<void> {
  isEditingModel.value = false;
  editingModelId.value = '';

  // 确保 providerTemplates 数据已加载
  if (modelsStore.providerTemplates.length === 0) {
    await modelsStore.fetchProviderTemplates();
  }

  Object.assign(modelFormData, {
    name: '',
    type: 'openai',
    enabled: true,
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    organization: '',
    deploymentName: '',
    apiVersion: '',
    timeout: 60000,
    maxRetries: 3,
    modelId: ''
  });
  modelDialogVisible.value = true;
}

function handleEditProvider(provider: ProviderConfig): void {
  isEditingModel.value = true;
  editingModelId.value = provider.id;
  Object.assign(modelFormData, {
    name: provider.name,
    type: provider.type,
    enabled: provider.enabled,
    baseUrl: provider.baseUrl || '',
    apiKey: provider.apiKey || '',
    organization: provider.organization || '',
    deploymentName: provider.deploymentName || '',
    apiVersion: provider.apiVersion || '',
    timeout: provider.timeout || 60000,
    maxRetries: provider.maxRetries || 3,
    modelId: provider.models && provider.models.length > 0 ? provider.models[0].id : ''
  });
  modelDialogVisible.value = true;
}

async function handleModelSubmit(): Promise<void> {
  if (!modelFormRef.value) return;

  await modelFormRef.value.validate(async (valid: boolean) => {
    if (!valid) return;

    modelSubmitting.value = true;
    try {
      // 构建要提交的数据
      const models = modelFormData.modelId ? [{
        id: modelFormData.modelId,
        name: modelFormData.modelId,
        capabilities: ['chat']
      }] : [];

      const submitData = {
        ...modelFormData,
        models
      };

      // 深拷贝表单数据，避免 Vue 响应式对象无法被 Electron IPC 序列化
      const clonedFormData = JSON.parse(JSON.stringify(submitData));

      if (isEditingModel.value) {
        const result = await modelsStore.updateProvider(editingModelId.value, clonedFormData);
        if (result) {
          ElMessage.success(t('models.providerSaved'));
          modelDialogVisible.value = false;
        }
      } else {
        const result = await modelsStore.addProvider(clonedFormData);
        if (result) {
          ElMessage.success(t('models.providerAdded'));
          modelDialogVisible.value = false;
        }
      }
    } finally {
      modelSubmitting.value = false;
    }
  });
}

async function handleToggleProvider(id: string, enabled: boolean): Promise<void> {
  togglingProviders.value.add(id);
  try {
    await modelsStore.toggleProvider(id, enabled);
    ElMessage.success(enabled ? t('models.enabled') : t('models.disabled'));
  } finally {
    togglingProviders.value.delete(id);
  }
}

function isTogglingProvider(id: string): boolean {
  return togglingProviders.value.has(id);
}

async function handleTestProvider(id: string): Promise<void> {
  const result = await modelsStore.testProvider(id);
  modelTestResult.value = result;
  modelTestDialogVisible.value = true;
}

async function handleFetchModels(id: string): Promise<void> {
  const result = await modelsStore.fetchModels(id);
  if (result.success) {
    if (result.models.length > 0) {
      ElMessage.success(t('models.modelsFound', { count: result.models.length }));
    } else if (result.error) {
      ElMessage.warning(result.error);
    }
  } else if (result.error) {
    ElMessage.error(t('models.fetchFailed', { error: result.error }));
  }
}

function handleManageModels(provider: ProviderConfig): void {
  currentProvider.value = provider;
  editingModels.value = JSON.parse(JSON.stringify(provider.models));
  newModelId.value = '';
  manageModelsDialogVisible.value = true;
}

function addModel(): void {
  if (!newModelId.value.trim()) return;

  editingModels.value.push({
    id: newModelId.value.trim(),
    name: newModelId.value.trim(),
    capabilities: ['chat']
  });

  newModelId.value = '';
}

function removeModel(index: number): void {
  editingModels.value.splice(index, 1);
}

async function saveModels(): Promise<void> {
  if (!currentProvider.value) return;

  try {
    await modelsStore.updateProvider(currentProvider.value.id, {
      ...currentProvider.value,
      models: editingModels.value
    });
    ElMessage.success(t('models.providerSaved'));
    manageModelsDialogVisible.value = false;
  } catch (error) {
    ElMessage.error(t('settings.saveFailed'));
  }
}

async function handleDeleteProvider(id: string, name: string): Promise<void> {
  try {
    await ElMessageBox.confirm(
      t('models.deleteConfirmText', { name }),
      t('models.deleteConfirmTitle'),
      {
        confirmButtonText: t('dialog.deleteButton'),
        cancelButtonText: t('dialog.cancelButton'),
        type: t('dialog.warningType') as 'warning'
      }
    );

    const success = await modelsStore.deleteProvider(id);
    if (success) {
      ElMessage.success(t('models.providerDeleted'));
    }
  } catch {}
}

async function loadMcpServers(): Promise<void> {
  try {
    const result = await (window as any).electronAPI?.mcp?.list();
    if (result?.success && result?.data) {
      mcpServers.value = result.data;
    }
  } catch (error) {
    console.error('加载 MCP Server 失败:', error);
  }
}

// ============ 关于 / 自动更新 ============

async function loadAppVersion(): Promise<void> {
  try {
    const result = await (window as any).electronAPI?.autoUpdater?.getVersion?.();
    if (result?.success && typeof result.data === 'string') {
      appVersion.value = result.data;
    } else {
      const v = await (window as any).electronAPI?.app?.getVersion?.();
      if (v?.success && typeof v.data === 'string') {
        appVersion.value = v.data;
      }
    }
  } catch (e) {
    console.error('加载版本号失败:', e);
  }
}

async function handleCheckUpdate(): Promise<void> {
  const api = (window as any).electronAPI?.autoUpdater;
  if (!api?.check) {
    ElMessage.warning(t('about.notSupported'));
    return;
  }
  isChecking.value = true;
  updateError.value = '';
  updateStatus.value = 'checking';
  try {
    const result = await api.check();
    if (!result?.success) {
      updateStatus.value = 'error';
      updateError.value = result?.error || t('about.checkFailed');
      ElMessage.error(updateError.value);
    } else {
      const version = result?.data?.version;
      if (version && version !== appVersion.value) {
        availableVersion.value = version;
        updateStatus.value = 'available';
        ElMessage.success(t('about.newVersionFound', { version }));
      } else {
        updateStatus.value = 'up-to-date';
        ElMessage.success(t('about.alreadyLatest'));
      }
    }
  } catch (e: any) {
    updateStatus.value = 'error';
    updateError.value = String(e?.message || e);
    ElMessage.error(updateError.value);
  } finally {
    isChecking.value = false;
  }
}

async function handleDownloadUpdate(): Promise<void> {
  const api = (window as any).electronAPI?.autoUpdater;
  if (!api?.download) {
    ElMessage.warning(t('about.notSupported'));
    return;
  }
  isDownloading.value = true;
  updateStatus.value = 'downloading';
  try {
    const result = await api.download();
    if (result?.success) {
      ElMessage.success(t('about.downloadStarted'));
    } else {
      updateStatus.value = 'available';
      ElMessage.error(result?.error || t('about.downloadFailed'));
    }
  } catch (e: any) {
    updateStatus.value = 'error';
    updateError.value = String(e?.message || e);
    ElMessage.error(updateError.value);
  } finally {
    isDownloading.value = false;
  }
}

async function handleInstallUpdate(): Promise<void> {
  const api = (window as any).electronAPI?.autoUpdater;
  if (!api?.install) {
    ElMessage.warning(t('about.notSupported'));
    return;
  }
  try {
    await api.install();
  } catch (e: any) {
    ElMessage.error(String(e?.message || e));
  }
}

function bindAutoUpdaterEvents(): void {
  const api = (window as any).electronAPI?.autoUpdater;
  if (!api) return;
  api.onUpdateAvailable?.((data: { version: string }) => {
    availableVersion.value = data.version;
    if (data.version !== appVersion.value) {
      updateStatus.value = 'available';
    }
  });
  api.onUpdateDownloaded?.((data: { version: string }) => {
    availableVersion.value = data.version;
    updateStatus.value = 'downloaded';
    ElMessage.success(t('about.downloadedHint', { version: data.version }));
  });
  api.onError?.((data: { message: string }) => {
    if (updateStatus.value === 'checking' || updateStatus.value === 'downloading') {
      updateStatus.value = 'error';
      updateError.value = data.message;
    }
  });
}

function openAddDialog(): void {
  editingServer.value = null;
  mcpDialogVisible.value = true;
}

function openEditDialog(server: any): void {
  editingServer.value = { ...server };
  mcpDialogVisible.value = true;
}

async function handleSaveMcp(data: any): Promise<void> {
  try {
    let result;
    if (data.isEdit) {
      result = await (window as any).electronAPI?.mcp?.update(data);
    } else {
      result = await (window as any).electronAPI?.mcp?.add(data);
    }

    if (result?.success) {
      ElMessage.success(data.isEdit ? '更新成功' : '添加成功');
      mcpDialogVisible.value = false;
      loadMcpServers();
    } else {
      ElMessage.error(result?.error || '保存失败');
    }
  } catch (error) {
    console.error('保存 MCP Server 失败:', error);
    ElMessage.error('保存失败');
  }
}

async function handleDeleteServer(name: string): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `确定要删除 MCP Server "${name}" 吗？`,
      '删除确认',
      {
        confirmButtonText: '删除',
        cancelButtonText: '取消',
        type: 'warning'
      }
    );

    const result = await (window as any).electronAPI?.mcp?.remove(name);
    if (result?.success) {
      ElMessage.success('删除成功');
      loadMcpServers();
    }
  } catch {}
}

async function handleTestServer(name: string): Promise<void> {
  try {
    const result = await (window as any).electronAPI?.mcp?.test(name);
    if (result?.success) {
      ElMessage.success('连接测试成功');
    } else {
      ElMessage.error('连接测试失败: ' + (result?.error || '未知错误'));
    }
  } catch (error) {
    console.error('测试 MCP Server 连接失败:', error);
    ElMessage.error('连接测试失败');
  }
}

onMounted(async () => {
  loadShortcutConfig();
  hermesMemoryStore.fetchMemories();
  loadEmbeddingConfig();
  void loadApprovalConfig();
  await Promise.all([
    modelsStore.fetchProviders(),
    modelsStore.fetchProviderTemplates()
  ]);
  await loadMcpServers();
  loadAppVersion();
  bindAutoUpdaterEvents();
  void refreshBackupList();
});
</script>

<style lang="scss" scoped>
@use "@/styles/variables.scss" as *;

.settings-page {
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-3);
  background: var(--bg-secondary);
  color: var(--fg-primary);
  box-sizing: border-box;
  overflow: hidden;
}

.page-header {
  flex-shrink: 0;
}

.page-title {
  font-size: var(--font-size-title-1);
  font-weight: var(--font-weight-semibold);
  color: var(--fg-primary);
  margin: 0;
  letter-spacing: -0.01em;
}

/* v4.4 重做: 2 列 grid layout (180px 左侧 nav + 1fr 内容), Linear 风格 */
.settings-layout {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 180px 1fr;
  gap: var(--space-4);
  overflow: hidden;
}

.settings-nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 0;
  align-self: start;
  position: sticky;
  top: 0;

  &__btn {
    appearance: none;
    background: transparent;
    border: 0;
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-md);
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--font-size-callout);
    color: var(--fg-secondary);
    cursor: pointer;
    text-align: left;
    font-family: inherit;
    transition: background var(--duration-fast) var(--ease-standard),
                color var(--duration-fast) var(--ease-standard);
    width: 100%;

    &:hover {
      background: var(--bg-elevated);
      color: var(--fg-primary);
    }

    &:focus-visible {
      outline: 2px solid var(--accent-base);
      outline-offset: 2px;
    }

    &.is-active {
      background: var(--accent-soft);
      color: var(--accent-base);
      font-weight: var(--font-weight-medium);
    }
  }

  &__icon {
    font-size: 14px;
    line-height: 1;
    width: 16px;
    text-align: center;
  }

  &__label { flex: 1; }

  &__count {
    font-size: var(--font-size-caption-1);
    background: var(--bg-elevated);
    border: 1px solid var(--border-base);
    color: var(--fg-tertiary);
    padding: 0 6px;
    border-radius: var(--radius-pill);
    line-height: 16px;
    min-width: 18px;
    text-align: center;
  }

  &__btn.is-active &__count {
    background: var(--accent-base);
    color: white;
    border-color: transparent;
  }
}

.settings-panels {
  min-height: 0;
  overflow-y: auto;
  padding: 0 var(--space-2) var(--space-3) 0;
}

.settings-panel {
  outline: none;
}

.tab-content {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  max-width: 640px;
}

/* v4.4 重做: 头部 h2 + desc 描述区 */
.settings-h {
  margin-bottom: var(--space-3);

  h2 {
    font-size: 16px;
    font-weight: var(--font-weight-semibold);
    letter-spacing: -0.01em;
    color: var(--fg-primary);
    margin: 0 0 4px;
  }

  &__desc {
    font-size: 12px;
    color: var(--fg-tertiary);
  }
}

/* v4.4 重做: setting-row 列表 (label/desc 左, control 右) */
.settings-section {
  background: var(--bg-elevated);
  border: 1px solid var(--border-base);
  border-radius: var(--radius-md);
  padding: 0 var(--space-4);
}

.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-3) 0;
  border-bottom: 1px solid var(--border-subtle);

  &:last-child { border-bottom: 0; }

  .setting-label {
    font-size: var(--font-size-callout);
    font-weight: var(--font-weight-medium);
    color: var(--fg-primary);
  }

  .setting-desc {
    font-size: var(--font-size-caption-1);
    color: var(--fg-tertiary);
    margin-top: 2px;
  }
}

/* v4.4 重做: 自定义 toggle 36×20 */
.toggle {
  width: 36px;
  height: 20px;
  background: var(--border-strong, var(--border-base));
  border-radius: 999px;
  position: relative;
  cursor: pointer;
  transition: background var(--duration-base) var(--ease-standard);
  border: 0;
  padding: 0;
  flex-shrink: 0;

  &::after {
    content: "";
    position: absolute;
    left: 2px;
    top: 2px;
    width: 16px;
    height: 16px;
    background: white;
    border-radius: 50%;
    transition: left var(--duration-base) var(--ease-emphasized);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.15);
  }

  &.on { background: var(--accent-base); }

  &.on::after { left: 18px; }

  &:focus-visible {
    outline: 2px solid var(--accent-base);
    outline-offset: 2px;
  }
}

/* v4.4 重做: 自定义 radio 按钮组 */
.radio-group {
  display: flex;
  gap: var(--space-2);
  flex-shrink: 0;
}

.radio {
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border-base);
  border-radius: var(--radius-sm);
  font-size: var(--font-size-callout);
  background: var(--bg-elevated);
  color: var(--fg-secondary);
  cursor: pointer;
  transition: all var(--duration-fast) var(--ease-standard);
  font-family: inherit;

  &:hover {
    border-color: var(--fg-secondary);
    color: var(--fg-primary);
  }

  &.active {
    background: var(--accent-soft);
    color: var(--accent-base);
    border-color: var(--accent-base);
    font-weight: var(--font-weight-medium);
  }

  &:focus-visible {
    outline: 2px solid var(--accent-base);
    outline-offset: 2px;
  }
}

/* v4.4 重做: 自定义 select-input */
.select-input {
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border-base);
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  color: var(--fg-primary);
  font-size: var(--font-size-callout);
  min-width: 200px;
  cursor: pointer;
  font-family: inherit;
  transition: all var(--duration-fast) var(--ease-standard);

  &:hover { border-color: var(--fg-secondary); }

  &:focus-visible {
    outline: 2px solid var(--accent-base);
    outline-offset: 0;
    border-color: var(--accent-base);
  }
}

/* v4.4 重做: 通用 secondary 按钮 */
.btn-secondary {
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border-base);
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  color: var(--fg-primary);
  font-size: var(--font-size-callout);
  cursor: pointer;
  font-family: inherit;
  transition: all var(--duration-fast) var(--ease-standard);
  flex-shrink: 0;

  &:hover {
    border-color: var(--accent-base);
    color: var(--accent-base);
  }

  &:focus-visible {
    outline: 2px solid var(--accent-base);
    outline-offset: 2px;
  }
}

.settings-card {
  background: var(--bg-elevated);
  border: 1px solid var(--border-base);
  border-radius: var(--radius-md);
  color: var(--fg-primary);
  transition: border-color var(--duration-fast) var(--ease-standard);

  &:hover { border-color: var(--border-strong); }

  :deep(.el-card__header) {
    border-bottom: 1px solid var(--border-subtle);
    padding: var(--space-3) var(--space-4);
  }

  :deep(.el-card__body) {
    padding: var(--space-3) var(--space-4);
  }
}

.settings-card :deep(.el-form-item__label) {
  color: var(--fg-primary);
  font-size: var(--font-size-callout);
  font-weight: var(--font-weight-medium);
}

.settings-card :deep(.el-input__wrapper) {
  background: var(--bg-elevated);
  color: var(--fg-primary);
  border-radius: var(--radius-sm);
  box-shadow: 0 0 0 1px var(--border-base) inset;
}

.settings-card :deep(.el-input__wrapper:hover) {
  box-shadow: 0 0 0 1px var(--border-strong) inset;
}

.settings-card :deep(.el-input__wrapper.is-focus) {
  box-shadow: 0 0 0 2px var(--accent-base) inset;
}

.form-tip {
  font-size: var(--font-size-caption-1);
  color: var(--fg-tertiary);
  margin-left: var(--space-2);
}

.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: var(--space-md);
}

.provider-count, .mcp-count {
  font-size: var(--font-size-body);
  color: var(--text-secondary);
}

.provider-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
  gap: var(--content-padding);
}

.provider-card {
  transition: all var(--duration-base) var(--ease-standard);

  &.disabled {
    opacity: 0.7;
  }
}

.provider-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.provider-info {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
}

.provider-icon {
  font-size: var(--space-xl);
}

.provider-title {
  display: flex;
  flex-direction: column;
  gap: var(--space-xs);
}

.provider-name {
  font-size: var(--font-size-title-2);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
}

.provider-type {
  font-size: var(--font-size-caption-1);
  color: var(--text-secondary);
}

.provider-body {
  padding: var(--space-sm) 0;
}

.connection-status {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  margin-bottom: var(--space-sm);
}

.model-count {
  font-size: var(--font-size-caption-1);
  color: var(--text-secondary);
}

.models-list {
  max-height: 300px;
}

.models-scrollbar {
  max-height: 300px;
}

.model-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--space-sm) var(--space-sm);
  background: var(--border-color);
  border-radius: var(--radius-sm);

  &.default {
    border: 1px solid var(--el-color-primary-light-5);
    background: var(--el-color-primary-light-9);
  }
}

.model-name {
  font-size: var(--font-size-callout);
  font-weight: var(--font-weight-medium);
  color: var(--text-primary);
}

.model-capabilities {
  display: flex;
  gap: var(--space-xs);
}

.no-models {
  font-size: var(--font-size-callout);
  color: var(--text-secondary);
  text-align: center;
  padding: var(--space-lg);
}

.provider-actions {
  display: flex;
  gap: var(--space-sm);
  justify-content: flex-end;
}

.model-list {
  max-height: 300px;
  overflow-y: auto;
}

.model-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--space-sm) var(--space-sm);
  margin-bottom: var(--space-sm);
  background: var(--el-fill-color-light);
  border-radius: var(--radius-sm);
}

.model-name {
  font-size: var(--font-size-body);
}

.add-model {
  display: flex;
  align-items: center;
}

.mcp-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
  gap: var(--content-padding);
}

.version-text {
  font-family: monospace;
  font-size: var(--font-size-body);
  color: var(--text-primary);
}

.error-text {
  color: var(--el-color-danger);
  font-size: var(--font-size-caption-1);
  word-break: break-all;
}

.backup-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin: 12px 0;
}

.backup-note {
  font-size: var(--font-size-caption-1);
  color: var(--text-tertiary, var(--fg-tertiary, #909399));
  line-height: 1.6;
}

.backup-empty {
  padding: 20px;
  border: 1px dashed var(--border-base, #e4e7ed);
  border-radius: 10px;
  color: var(--text-tertiary, var(--fg-tertiary, #909399));
  font-size: var(--font-size-body);
  text-align: center;
}

.backup-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.backup-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--border-base, #e4e7ed);
  border-radius: 10px;
  background: var(--bg-secondary, transparent);
}

.backup-meta {
  flex: 1;
  min-width: 0;
}

.backup-name {
  font-size: var(--font-size-body);
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.backup-sub {
  margin-top: 2px;
  font-size: var(--font-size-caption-1);
  color: var(--text-tertiary, var(--fg-tertiary, #909399));
}

.backup-warn {
  color: var(--el-color-danger);
}

.backup-row-actions {
  flex: none;
  display: flex;
  gap: 4px;
}

/* ===== v4.7 配置容器：设置页里集中所有配置类页面入口 ===== */
.settings-config-nav {
  margin-top: var(--space-3);
  padding-top: var(--space-3);
  border-top: 1px solid var(--border-subtle);
  display: flex;
  flex-direction: column;
  gap: 2px;

  &__title {
    padding: 0 var(--space-3) 2px;
    font-size: 11px;
    font-weight: var(--font-weight-semibold);
    letter-spacing: 0.04em;
    color: var(--fg-tertiary);
  }

  &__desc {
    padding: 0 var(--space-3) var(--space-2);
    font-size: 11px;
    line-height: 1.45;
    color: var(--fg-tertiary);
  }
}

.settings-link {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 6px var(--space-3);
  border-radius: var(--radius-md);
  text-decoration: none;
  color: var(--fg-secondary);
  transition: background var(--duration-fast) var(--ease-standard),
    color var(--duration-fast) var(--ease-standard);

  &:hover {
    background: var(--bg-elevated);
    color: var(--fg-primary);
  }

  /* v4.9：内嵌切换激活态 —— 与上方 navTabs 选中视觉一致 */
  &.is-active {
    background: var(--bg-elevated);
    color: var(--fg-primary);
  }
  &.is-active &__icon {
    color: var(--accent-base);
  }

  &:focus-visible {
    outline: 2px solid var(--accent-base);
    outline-offset: 2px;
  }

  &__icon {
    flex-shrink: 0;
    font-size: 14px;
    line-height: 1;
    width: 16px;
    text-align: center;
    color: var(--fg-tertiary);
  }

  &__body {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  &__title {
    font-size: var(--font-size-callout);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  &__desc {
    font-size: 11px;
    color: var(--fg-tertiary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
}
</style>