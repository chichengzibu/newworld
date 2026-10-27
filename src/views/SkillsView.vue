<template>
  <div class="skills-page">
    <div class="page-header">
      <div class="header-left">
        <h1 class="page-title">技能管理</h1>
        <p class="page-desc">管理和配置自动化技能模板</p>
      </div>
      <div class="header-actions">
        <el-button type="primary" @click="handleDeduplicate" :loading="loadingDeduplicate">
          <el-icon><MagicStick /></el-icon>
          智能去重
        </el-button>
        <el-button @click="showImportDialog = true">
          <el-icon><Upload /></el-icon>
          导入技能
        </el-button>
      </div>
    </div>
    
    <!-- 技能过多提示 -->
    <el-alert
      v-if="skills.length > 20"
      title="技能较多，建议使用智能去重优化"
      type="warning"
      :closable="true"
      style="margin-bottom: var(--space-md);"
    />
    
    <!-- 技能提案横幅 -->
    <div v-if="pendingProposal" class="proposal-banner" data-testid="proposal-banner">
      <div class="banner-content">
        <el-icon class="banner-icon" :size="22" color="var(--accent-base)"><MagicStick /></el-icon>
        <div class="banner-text">
          <div class="banner-title">发现新的技能模式！</div>
          <div class="banner-desc">我分析了你的操作，自动生成了技能"{{ pendingProposal.name }}"</div>
          <div v-if="pendingProposal.triggerCondition" class="banner-condition">
            触发条件：{{ pendingProposal.triggerCondition }}
          </div>
        </div>
        <div class="banner-actions">
          <el-button type="primary" size="small" @click="handleAcceptProposal">保存技能</el-button>
          <el-button size="small" text @click="handleDismissProposal">忽略</el-button>
          <el-button size="small" text @click="showProposalDetail = true">查看详情</el-button>
        </div>
        <!-- #007 H1: 提案年龄提示 (createdAt 字段已显示, 订单 d④ 诚实文案; 超期由 handleNewProposal 拒绝) -->
        <div class="banner-expiry" data-testid="proposal-expiry">已挂起 {{ proposalAgeText }} (30 分钟未操作自动忽略)</div>
      </div>
    </div>
    
    <!-- 重启提示 -->
    <el-alert
      v-if="showNeedsRestartNotice"
      title="新技能已保存，重启应用后生效"
      type="warning"
      :closable="true"
      @close="showNeedsRestartNotice = false"
      style="margin-bottom: var(--space-lg);"
    />
    
    <div class="skills-content">
      <div v-if="skills.length > 0" class="skills-grid">
        <SkillCard
          v-for="skill in skills"
          :key="skill.id"
          :skill="skill"
          @toggle="handleToggleSkill"
        />
      </div>
      
      <div v-else class="empty-state">
        <el-icon class="empty-icon" :size="40" color="var(--fg-tertiary)"><Box /></el-icon>
        <h3 class="empty-title">暂无技能</h3>
        <p class="empty-desc">
          从 skills/ 目录导入技能，或创建新的技能模板
        </p>
        <el-button type="primary" @click="showImportDialog = true">
          导入技能
        </el-button>
      </div>
    </div>
    
    <div v-if="skills.length > 0" class="page-footer">
      <div class="stats-bar">
        <span class="stat-item">
          已加载 <strong>{{ skills.length }}</strong> 个技能
        </span>
        <span class="stat-item">
          <strong>{{ enabledCount }}</strong> 个已启用
        </span>
      </div>
    </div>

    <!--
      【M4-B】效果判定面板
      此前学习闭环收集的调用成败数据【没有任何读取方】—— 进了 skill-stats.json 就没人再看过。
      本面板是它的第一个读取方:把"这个工具/技能到底好不好用"变成能一眼看到的结论。

      【口径诚实】这里显示的是【绝对成功率】判定,不是边际效用。
      业界实测:真正有害的判据是"带该技能 vs 不带该技能"的差值,而非绝对成功率低。
      所以本面板只做【提示】,不做自动禁用/回滚 —— 自动处置需要对照数据。
    -->
    <el-collapse v-if="effectivenessRows.length > 0" class="effectiveness-panel">
      <el-collapse-item name="effectiveness">
        <template #title>
          <span class="effectiveness-title">
            效果统计
            <el-tag v-if="harmfulCount > 0" type="danger" size="small" style="margin-left: 8px;">
              {{ harmfulCount }} 个表现不佳
            </el-tag>
          </span>
        </template>
        <el-table :data="effectivenessRows" size="small" style="width: 100%">
          <el-table-column prop="skillName" label="名称" min-width="160" />
          <el-table-column label="类型" width="80">
            <template #default="{ row }">
              <el-tag size="small" :type="row.unitType === 'tool' ? 'info' : 'primary'" effect="plain">
                {{ row.unitType === 'tool' ? '工具' : '技能' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="calls" label="调用" width="80" />
          <el-table-column label="成功率" width="100">
            <template #default="{ row }">
              {{ row.successRate === undefined ? '—' : `${Math.round(row.successRate * 100)}%` }}
            </template>
          </el-table-column>
          <el-table-column label="判定" width="130">
            <template #default="{ row }">
              <el-tag size="small" :type="verdictTagType(row.verdict)">
                {{ verdictLabel(row.verdict) }}
              </el-tag>
            </template>
          </el-table-column>
        </el-table>
        <p class="effectiveness-note">
          说明:判定基于绝对成功率,样本少于 3 次不下结论。"表现不佳"仅作提示,不会自动禁用任何技能 ——
          自动处置需要"带/不带该技能"的对照结果。
        </p>
      </el-collapse-item>
    </el-collapse>
    
    <SkillImportDialog
      v-model="showImportDialog"
      @success="handleImportSuccess"
    />
    
    <!-- 技能提案详情对话框 -->
    <el-dialog
      v-model="showProposalDetail"
      title="技能提案详情"
      width="600px"
    >
      <div v-if="pendingProposal" class="proposal-detail">
        <div class="detail-section">
          <div class="detail-label">技能名称</div>
          <div class="detail-value">{{ pendingProposal.name }}</div>
        </div>
        
        <div class="detail-section">
          <div class="detail-label">描述</div>
          <div class="detail-value">{{ pendingProposal.description }}</div>
        </div>
        
        <div class="detail-section">
          <div class="detail-label">触发条件（语义）</div>
          <div class="detail-value">{{ pendingProposal.triggerCondition || '-' }}</div>
        </div>
        
        <div class="detail-section">
          <div class="detail-label">关键词</div>
          <div class="detail-value">
            <el-tag
              v-for="keyword in pendingProposal.keywords"
              :key="keyword"
              size="small"
              style="margin-right: var(--space-sm); margin-bottom: var(--space-sm);"
            >
              {{ keyword }}
            </el-tag>
          </div>
        </div>
        
        <div class="detail-section">
          <div class="detail-label">操作步骤</div>
          <div class="detail-value">
            <div v-for="(step, index) in pendingProposal.operationSteps" :key="index" class="step-item">
              {{ index + 1 }}. {{ step }}
            </div>
            <div v-if="!pendingProposal.operationSteps?.length" class="detail-empty">
              （本次执行没有可归纳的步骤）
            </div>
          </div>
        </div>

        <!--
          【M4-C】证据链 —— 提案凭什么成立。
          业界实测「自生成技能的平均收益接近零甚至为负」,瓶颈在生成与验证。
          所以提案不能只给一个结论,必须把支撑它的真实执行记录摊开给用户看 ——
          人工编辑这一环才是价值真正产生的地方。
        -->
        <div v-if="pendingProposal.evidence" class="detail-section">
          <div class="detail-label">证据链</div>
          <div class="detail-value">
            <div class="evidence-row">
              <el-tag size="small" type="info">观察到 {{ pendingProposal.evidence.supportCount }} 次</el-tag>
              <el-tag size="small" type="success">成功 {{ pendingProposal.evidence.successfulAttempts }} 次</el-tag>
              <el-tag v-if="pendingProposal.evidence.failedAttempts > 0" size="small" type="warning">
                失败 {{ pendingProposal.evidence.failedAttempts }} 次
              </el-tag>
            </div>
            <div v-if="pendingProposal.evidence.toolsUsed?.length" class="evidence-sub">
              用到的工具：{{ pendingProposal.evidence.toolsUsed.join('、') }}
            </div>
            <div class="evidence-sub">
              样例指令：{{ pendingProposal.evidence.sampleInstruction }}
            </div>
            <div class="evidence-note">
              支持度与成功率只是「值得学」的必要条件，不是「这个技能有用」的结论 ——
              真正的效用需要「带 / 不带该技能」的对照结果。
            </div>
          </div>
        </div>

        <div class="detail-section">
          <div class="detail-label">完整技能文档</div>
          <div class="detail-value">
            <el-input
              v-model="pendingProposal.fullInstructions"
              type="textarea"
              :rows="12"
              readonly
            />
          </div>
        </div>
      </div>
      
      <template #footer>
        <el-button @click="showProposalDetail = false">关闭</el-button>
        <el-button type="primary" @click="handleAcceptProposal">保存技能</el-button>
      </template>
    </el-dialog>
    
    <!-- 技能合并候选对话框 -->
    <el-dialog
      v-model="showMergeDialog"
      title="智能去重 - 发现可合并的技能"
      width="700px"
    >
      <div v-if="mergeCandidates.length > 0" class="merge-candidates">
        <div v-for="(candidate, index) in mergeCandidates" :key="index" class="candidate-item">
          <div class="candidate-info">
            <div class="candidate-skill">
              <div class="skill-label">技能1</div>
              <div class="skill-name">{{ candidate.skillName1 }}</div>
            </div>
            <div class="candidate-divider">
              <el-tag type="warning">{{ candidate.similarity }}% 相似</el-tag>
            </div>
            <div class="candidate-skill">
              <div class="skill-label">技能2</div>
              <div class="skill-name">{{ candidate.skillName2 }}</div>
            </div>
          </div>
          <el-button
            type="primary"
            size="small"
            @click="handleMerge(candidate)"
            :loading="mergingIndex === index"
          >
            合并
          </el-button>
        </div>
      </div>
      <div v-else class="no-candidates">
        <el-icon class="no-candidates-icon" :size="36" color="var(--el-color-success)"><SuccessFilled /></el-icon>
        <p>没有发现可合并的技能，所有技能都是唯一的！</p>
      </div>
      
      <template #footer>
        <el-button @click="showMergeDialog = false">关闭</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { Upload, MagicStick, Box, SuccessFilled } from '@element-plus/icons-vue';
import { ElMessage } from "element-plus/es/components/message/index"
// #007 H1: 提案超时阈值 (30 分钟, 订单既定)
const PROPOSAL_TIMEOUT_MS = 30 * 60 * 1000
import { ElMessageBox } from "element-plus/es/components/message-box/index";
import SkillCard from '@/components/skills/SkillCard.vue';
import SkillImportDialog from '@/components/skills/SkillImportDialog.vue';

interface Skill {
  id: string;
  name: string;
  description: string;
  triggerKeywords: string[];
  enabled: boolean;
  usageCount: number;
  successRate: number;
}

interface SkillProposal {
  id: string;
  name: string;
  description: string;
  triggerCondition: string;
  keywords: string[];
  operationSteps: string[];
  fullInstructions: string;
  createdAt: number;
  /** 【M4-C】证据链 —— 提案凭什么成立 */
  evidence?: {
    supportCount: number;
    trajectoryIds: string[];
    successfulAttempts: number;
    failedAttempts: number;
    commonSteps: string[];
    toolsUsed: string[];
    sampleInstruction: string;
  };
}

const skills = ref<Skill[]>([]);
const showImportDialog = ref(false);
const pendingProposal = ref<SkillProposal | null>(null);
const showProposalDetail = ref(false);
const showNeedsRestartNotice = ref(false);
const showMergeDialog = ref(false);
const mergeCandidates = ref<any[]>([]);
const loadingDeduplicate = ref(false);
const mergingIndex = ref<number | null>(null);

const enabledCount = computed(() => {
  return skills.value.filter(s => s.enabled).length;
});

// #007 H1: 提案年龄文案 (30 分钟超时已提示)
const proposalAgeText = computed(() => {
  if (!pendingProposal.value) return '';
  const ageMin = Math.floor((Date.now() - pendingProposal.value.createdAt) / 60000);
  return ageMin < 60 ? `${ageMin} 分钟` : `${Math.floor(ageMin / 60)} 小时 ${ageMin % 60} 分`;
});

const loadSkills = async () => {
  try {
    const result = await (window as any).electronAPI?.skills?.list();
    if (result?.success && result?.data) {
      skills.value = result.data;
    }
  } catch (error) {
    console.error('加载技能失败', error);
  }
  loadEffectiveness();
};

/**
 * 【M4-B】拉取效果判定。
 * 数据源:SkillEffectivenessTracker(主进程)—— M4-B 起才有第一个写入方,
 * 此前收集的调用成败无任何读取方。
 */
const effectivenessRows = ref<any[]>([]);

const loadEffectiveness = async () => {
  try {
    const result = await (window as any).electronAPI?.skills?.getEffectiveness?.();
    if (result?.success && Array.isArray(result.data)) {
      effectivenessRows.value = result.data;
    }
  } catch (error) {
    console.error('加载效果统计失败', error);
  }
};

const harmfulCount = computed(() =>
  effectivenessRows.value.filter((r: any) => r.verdict === 'harmful').length
);

const verdictLabel = (v: string): string => ({
  untested: '未使用',
  insufficient_data: '样本不足',
  healthy: '表现良好',
  degraded: '表现一般',
  harmful: '表现不佳',
}[v] || v);

const verdictTagType = (v: string): any => ({
  untested: 'info',
  insufficient_data: 'info',
  healthy: 'success',
  degraded: 'warning',
  harmful: 'danger',
}[v] || 'info');

const handleToggleSkill = async (skillId: string, enabled: boolean) => {
  const skill = skills.value.find(s => s.id === skillId);
  if (skill) {
    skill.enabled = enabled;
    try {
      await (window as any).electronAPI?.skills?.toggle(skillId, enabled);
    } catch (error) {
      console.error('更新技能状态失败', error);
    }
  }
};

const handleImportSuccess = (data?: any[]) => {
  if (data) {
    skills.value = data;
  } else {
    loadSkills();
  }
};

const handleNewProposal = (proposal: SkillProposal) => {
  // #007 H1 (订单 d④ 诚实文案): 提案超时 30 分钟未操作 → 提示"提案已超期自动忽略" (非静默丢弃)
  // v1 口径: 收到时判定 (createdAt 超期 → 拒绝 + 清 + 提示); 在屏期间无轮询 (H2 v2 备查扩),
  //          与订单"H1 定时器"差异已在设计稿 G4 段 + #007 §分析周期坐实
  if (Date.now() - proposal.createdAt > PROPOSAL_TIMEOUT_MS) {
    pendingProposal.value = null;
    (window as any).electronAPI?.learning?.clearPendingProposal?.();
    ElMessage.warning('提案已超期自动忽略');
    return;
  }
  pendingProposal.value = proposal;
};

const handleAcceptProposal = async () => {
  if (!pendingProposal.value) return;
  
  try {
    const result = await (window as any).electronAPI?.learning?.saveSkillProposal(pendingProposal.value);
    if (result?.success) {
      if (result?.data?.needsRestart) {
        showNeedsRestartNotice.value = true;
      }
      loadSkills();
      pendingProposal.value = null;
      showProposalDetail.value = false;
    }
  } catch (error) {
    console.error('接受技能提案失败', error);
  }
};

const handleDismissProposal = async () => {
  try {
    await (window as any).electronAPI?.learning?.clearPendingProposal();
    pendingProposal.value = null;
    showProposalDetail.value = false;
  } catch (error) {
    pendingProposal.value = null;
    showProposalDetail.value = false;
  }
};

const handleDeduplicate = async () => {
  loadingDeduplicate.value = true;
  try {
    const result = await (window as any).electronAPI?.skills?.mergeCandidates();
    if (result?.success) {
      mergeCandidates.value = result.data || [];
      showMergeDialog.value = true;
      if (mergeCandidates.value.length === 0) {
        ElMessage.success('没有发现可合并的技能');
      }
    } else {
      ElMessage.error(result?.error || '获取合并候选失败');
    }
  } catch (error) {
    ElMessage.error('获取合并候选失败');
  } finally {
    loadingDeduplicate.value = false;
  }
};

const handleMerge = async (candidate: any) => {
  try {
    await ElMessageBox.confirm(
      `确定要合并技能"${candidate.skillName1}"和"${candidate.skillName2}"吗？`,
      '合并确认',
      {
        confirmButtonText: '确定合并',
        cancelButtonText: '取消',
        type: 'warning'
      }
    );
    
    mergingIndex.value = mergeCandidates.value.indexOf(candidate);
    
    const result = await (window as any).electronAPI?.skills?.performMerge(
      candidate.skillId1,
      candidate.skillId2
    );
    
    if (result?.success) {
      ElMessage.success('技能合并成功！');
      mergeCandidates.value = mergeCandidates.value.filter(c => c !== candidate);
      loadSkills();
    } else {
      ElMessage.error(result?.error || '合并失败');
    }
  } catch (error) {
    if (error !== 'cancel') {
      ElMessage.error('合并失败');
    }
  } finally {
    mergingIndex.value = null;
  }
};

/**
 * 【M4-A 修复】订阅新技能提案。
 *
 * 此前用 `window.require('electron').ipcRenderer` 订阅 —— 但渲染窗口是
 * contextIsolation: true + nodeIntegration: false,window.require 是
 * undefined,订阅永远注册不上,提案横幅永远不会出现。
 * 现经 preload 暴露的 learning.onNewProposal 订阅,并在卸载时正确退订
 * (旧代码用 removeAllListeners,会误杀其他模块对同通道的监听)。
 */
let unsubscribeProposal: (() => void) | null = null;

onMounted(() => {
  loadSkills();

  const api = (window as any).electronAPI;
  if (api?.learning?.onNewProposal) {
    unsubscribeProposal = api.learning.onNewProposal((proposal: SkillProposal) => {
      handleNewProposal(proposal);
    });
  }

  // 【M4-A】补上"应用启动时已有待处理提案"的场景 ——
  // 提案可能在用户打开本页之前就生成了,只靠实时订阅会漏。
  api?.learning?.getPendingProposal?.().then((resp: any) => {
    if (resp?.success && resp.data) {
      handleNewProposal(resp.data as SkillProposal);
    }
  }).catch(() => { /* 无待处理提案是正常情况 */ });
});

onUnmounted(() => {
  unsubscribeProposal?.();
  unsubscribeProposal = null;
});
</script>

<style lang="scss" scoped>
.skills-page {
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-3);
  box-sizing: border-box;
  overflow: hidden;
  background: var(--bg-secondary);
  color: var(--fg-primary);
}

.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-shrink: 0;
}

.header-actions {
  display: flex;
  gap: var(--space-2);
}

.header-left {
  display: flex;
  flex-direction: column;
  gap: var(--space-xs);
}

.page-title {
  font-size: var(--font-size-display);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary) !important;
  margin: 0;
}

.page-desc {
  font-size: var(--font-size-body);
  color: var(--text-secondary);
  margin: 0;
}

.proposal-banner {
  background: linear-gradient(135deg, var(--el-color-primary-light-9) 0%, var(--el-color-primary-light-8) 100%);
  border: 1px solid var(--el-color-primary-light-5);
  border-radius: var(--radius-lg);
  padding: var(--space-md) var(--space-lg);
  flex-shrink: 0;
}

.banner-content {
  display: flex;
  align-items: flex-start;
  gap: var(--space-md);
}

.banner-icon {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: 10px;
  background: var(--accent-soft);
}

.banner-text {
  flex: 1;
  min-width: 0;
}

.banner-title {
  font-size: var(--font-size-title-2);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
  margin-bottom: var(--space-xs);
}

.banner-desc {
  font-size: var(--font-size-body);
  color: var(--text-secondary);
  margin-bottom: var(--space-sm);
}

.banner-condition {
  font-size: var(--font-size-callout);
  color: var(--el-color-primary);
  background: var(--el-color-primary-light-9);
  padding: var(--space-xs) var(--space-sm);
  border-radius: var(--radius-sm);
  display: inline-block;
}

.banner-actions {
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
  align-items: flex-end;
}

.skills-content {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}

.skills-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(420px, 1fr));
  gap: var(--space-lg);
}

.empty-state {
  text-align: center;
  padding: var(--space-3xl) var(--space-lg);
}

.empty-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 80px;
  height: 80px;
  border-radius: 20px;
  background: var(--bg-elevated);
  margin-bottom: var(--space-md);
}

.empty-title {
  font-size: var(--font-size-title-1);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
  margin: 0 0 var(--space-sm) 0;
}

.empty-desc {
  font-size: var(--font-size-body);
  color: var(--text-secondary);
  margin: 0 0 var(--space-lg) 0;
}

.page-footer {
  flex-shrink: 0;
  padding-top: var(--space-md);
  border-top: 1px solid var(--border-color);
}

.stats-bar {
  display: flex;
  gap: var(--space-lg);
}

.stat-item {
  font-size: var(--font-size-body);
  color: var(--text-secondary);
}

.stat-item strong {
  color: var(--text-primary);
  font-weight: var(--font-weight-semibold);
}

/* 【M4-B】效果判定面板 */
.effectiveness-panel {
  flex-shrink: 0;
  margin-top: var(--space-md);
}

.effectiveness-title {
  font-size: var(--font-size-body);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
}

.effectiveness-note {
  margin: var(--space-sm) 0 0;
  font-size: var(--font-size-caption);
  color: var(--text-secondary);
  line-height: 1.6;
}

.proposal-detail {
  display: flex;
  flex-direction: column;
  gap: var(--space-lg);
}

.detail-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
}

/* 【M4-C】证据链 */
.evidence-row {
  display: flex;
  gap: var(--space-sm);
  flex-wrap: wrap;
  margin-bottom: var(--space-xs);
}

.evidence-sub {
  font-size: var(--font-size-caption);
  color: var(--text-secondary);
  margin-bottom: var(--space-xs);
}

.evidence-note {
  font-size: var(--font-size-caption);
  color: var(--text-tertiary, var(--text-secondary));
  line-height: 1.6;
  margin-top: var(--space-xs);
}

.detail-empty {
  font-size: var(--font-size-caption);
  color: var(--text-secondary);
}

.detail-label {
  font-size: var(--font-size-body);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
}

.detail-value {
  font-size: var(--font-size-body);
  color: var(--text-secondary);
  line-height: var(--line-height-relaxed);
}

.step-item {
  padding: var(--space-sm) var(--space-sm);
  background: var(--el-fill-color-light);
  border-radius: var(--radius-sm);
  margin-bottom: var(--space-sm);
}

.merge-candidates {
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
}

.candidate-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-md);
  background: var(--el-fill-color-lighter);
  border-radius: var(--radius-lg);
  border: 1px solid var(--el-border-color);
}

.candidate-info {
  display: flex;
  align-items: center;
  gap: var(--space-lg);
  flex: 1;
}

.candidate-skill {
  display: flex;
  flex-direction: column;
  gap: var(--space-xs);
}

.skill-label {
  font-size: var(--font-size-caption-1);
  color: var(--text-secondary);
}

.skill-name {
  font-size: var(--font-size-body);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
}

.candidate-divider {
  display: flex;
  align-items: center;
  justify-content: center;
}

.no-candidates {
  text-align: center;
  padding: var(--space-2xl) var(--space-lg);
}

.no-candidates-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 72px;
  height: 72px;
  border-radius: 18px;
  background: rgba(16, 185, 129, 0.10);
  margin-bottom: var(--space-md);
}
</style>
