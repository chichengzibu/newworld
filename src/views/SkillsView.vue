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
      【M3-D】技能目录 —— 用户自己的技能目录也能被扫到。
      此前只有 userData/skills 一个目录(导入的 / 自学习生成的),
      用户项目里的技能目录完全看不到。
    -->
    <el-card class="skills-dir-card">
      <div class="dir-header">
        <h3>{{ '技能目录' }}</h3>
        <el-button size="small" @click="addSkillDirectory">
          <el-icon><Plus /></el-icon>
          {{ '添加技能目录' }}
        </el-button>
      </div>

      <div class="dir-primary">
        <span class="dir-label">{{ '主目录' }}</span>
        <code class="dir-path">{{ storageInfo?.primaryDir || '—' }}</code>
        <el-tag size="small" type="info">{{ storageInfo?.primaryCount ?? 0 }}</el-tag>
      </div>

      <div v-if="(storageInfo?.extraDirs?.length ?? 0) > 0" class="dir-extras">
        <div v-for="d in storageInfo.extraDirs" :key="d.dir" class="dir-extra">
          <code class="dir-path">{{ d.dir }}</code>
          <el-tag size="small" :type="d.exists ? 'info' : 'danger'">
            {{ d.exists ? d.count : '目录不存在' }}
          </el-tag>
          <el-button size="small" text type="danger" @click="removeSkillDirectory(d.dir)">
            {{ '移除' }}
          </el-button>
        </div>
      </div>
      <p v-else class="dir-empty">{{ '尚未添加额外目录。添加后，这些目录里的技能也会被加载。' }}</p>

      <!-- 添加前的预览:先让用户看见这个目录里有什么技能 -->
      <div v-if="dirPreview" class="dir-preview">
        <div class="dir-preview-head">
          <code class="dir-path">{{ dirPreview.path }}</code>
          <el-tag size="small" type="success">{{ dirPreview.skills.length }}</el-tag>
        </div>
        <div v-if="dirPreview.skills.length === 0" class="dir-preview-empty">
          {{ '该目录下没有找到技能（每个技能需是一个含 SKILL.md 的子目录）' }}
        </div>
        <div v-else class="dir-preview-list">
          <el-tag v-for="s in dirPreview.skills" :key="s.id" size="small" style="margin: 2px;">
            {{ s.name || s.id }}
          </el-tag>
        </div>
        <div class="dir-preview-actions">
          <el-button size="small" type="primary" @click="confirmAddSkillDirectory">
            {{ '确认添加' }}
          </el-button>
          <el-button size="small" @click="dirPreview = null">{{ '取消' }}</el-button>
        </div>
      </div>
    </el-card>

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
    
    <!--
      【M4-D】边际效用 —— 「这个技能到底有没有用」
      效果统计面板给的是【绝对成功率】,而绝对成功率说明不了效用:
      用户可能专挑难活儿时才启用技能,那时绝对成功率低是任务难,不是技能没用。
      真正的判据是【同类别任务下】带它 vs 不带它的成功率差。

      【口径】这是【观察性对比】,不是受控实验 —— 「不带技能」的运行是自然发生的,
      存在混杂。因此只作提示,不做自动禁用/回滚。
    -->
    <el-collapse v-if="utilityRows.length > 0" class="effectiveness-panel">
      <el-collapse-item name="utility">
        <template #title>
          <span class="effectiveness-title">
            边际效用
            <el-tag v-if="negativeUtilityCount > 0" type="danger" size="small" style="margin-left: 8px;">
              {{ negativeUtilityCount }} 个负贡献
            </el-tag>
          </span>
        </template>
        <el-table :data="utilityRows" size="small" style="width: 100%">
          <el-table-column prop="skillName" label="技能" min-width="160" />
          <el-table-column label="带该技能" width="150">
            <template #default="{ row }">
              {{ row.withSkill.runs }} 次 ·
              {{ row.withSkill.rate === undefined ? '—' : `${Math.round(row.withSkill.rate * 100)}%` }}
            </template>
          </el-table-column>
          <el-table-column label="同类别不带" width="150">
            <template #default="{ row }">
              {{ row.withoutSkill.runs }} 次 ·
              {{ row.withoutSkill.rate === undefined ? '—' : `${Math.round(row.withoutSkill.rate * 100)}%` }}
            </template>
          </el-table-column>
          <el-table-column label="差值" width="110">
            <template #default="{ row }">
              <el-tag v-if="row.delta === undefined" size="small" type="info">样本不足</el-tag>
              <el-tag v-else size="small" :type="row.delta < 0 ? 'danger' : row.delta > 0 ? 'success' : 'info'">
                {{ row.delta > 0 ? '+' : '' }}{{ Math.round(row.delta * 100) }}%
              </el-tag>
            </template>
          </el-table-column>
        </el-table>
        <p class="effectiveness-note">
          说明:「同类别不带」= 同类任务下、但没有应用该技能的运行。
          这是<span class="note-strong">观察性对比而非受控实验</span> —— 用户可能在任务变难时才想起用技能,
          所以差值可能低估技能的贡献。样本不足时不给结论,也不会自动禁用任何技能。
        </p>
      </el-collapse-item>
    </el-collapse>

    <!--
      【M4-E】技能验证 —— 受控对照实验。
      边际效用面板给的是【观察性对比】(有混杂);这里做的是**配对对照**:
      同一个任务跑两遍,一遍允许用该技能、一遍禁止用(load_skill 会真的拒绝)。
      两遍的差别只剩「有没有这个技能」—— 这才是干净的因果对比。

      【成本必须先告知】每个任务跑两遍 → token 翻倍。跑之前弹确认说清楚。
    -->
    <el-card class="skills-trial-card">
      <div class="dir-header">
        <h3>技能验证（对照实验）</h3>
      </div>
      <p class="dir-empty">
        选一个技能，给出要验证的任务。每个任务会<b>跑两遍</b>（一遍带技能、一遍禁技能），
        据此判断这个技能到底有没有用。<b>token 成本翻倍。</b>
      </p>

      <el-form label-width="100px">
        <el-form-item label="技能">
          <el-select v-model="trialSkillId" filterable style="width: 320px;" placeholder="选择要验证的技能">
            <el-option v-for="s in skills" :key="s.id" :label="s.name" :value="s.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="任务">
          <el-input
            v-model="trialTasksText"
            type="textarea"
            :rows="4"
            placeholder="每行一个任务，例如：&#10;把桌面上的 PDF 归档到 D:/Documents/PDF&#10;整理下载文件夹里的压缩包"
          />
          <div class="dir-empty">建议至少 5 个任务 —— 少于 5 个配对任务时，差值不可靠，系统会明确说「样本不足」而不是给结论。</div>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :loading="trialRunning" @click="runTrial">开始验证</el-button>
        </el-form-item>
      </el-form>

      <div v-if="trialResult" class="trial-result">
        <el-alert
          :type="trialVerdictType"
          :closable="false"
          show-icon
          :title="trialResult.summary.note"
        />
        <el-table :data="trialResult.pairs" size="small" style="width: 100%; margin-top: var(--space-sm);">
          <el-table-column label="任务" min-width="220">
            <template #default="{ row }">{{ row.task.instruction }}</template>
          </el-table-column>
          <el-table-column label="带技能" width="100">
            <template #default="{ row }">
              <el-tag size="small" :type="row.withSkill.grade.passed ? 'success' : 'danger'">
                {{ row.withSkill.grade.passed ? '成功' : '失败' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="不带技能" width="110">
            <template #default="{ row }">
              <el-tag size="small" :type="row.withoutSkill.grade.passed ? 'success' : 'danger'">
                {{ row.withoutSkill.grade.passed ? '成功' : '失败' }}
              </el-tag>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </el-card>

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
import { Upload, MagicStick, Box, SuccessFilled, Plus } from '@element-plus/icons-vue';
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
  /** 【M4-D】null = 暂无使用记录(此前恒为 100,是编造的) */
  successRate: number | null;
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
  loadUtility();
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

/**
 * 【M4-D】边际效用 —— 同类别任务下,带该技能 vs 不带该技能的成功率差。
 * 这是"这个技能到底有没有用"目前能给出的最强信号。
 */
// ══════════ 【M3-D】技能目录 ══════════
// 用户自己的技能目录也能被扫到。此前只有 userData/skills 一个目录。

const storageInfo = ref<any>(null);
const dirPreview = ref<any>(null);

const loadStorageInfo = async (): Promise<void> => {
  try {
    const res = await (window as any).electronAPI?.skills?.getStorageInfo?.();
    if (res?.success && res.data) storageInfo.value = res.data;
  } catch (e) {
    console.error('读取技能存储信息失败', e);
  }
};

/** 选目录 → 预览 → 确认添加(两步:先让用户看见里面有什么) */
const addSkillDirectory = async (): Promise<void> => {
  try {
    const picked = await (window as any).electronAPI?.dialog?.openFile?.({
      properties: ['openDirectory', 'createDirectory'],
      title: '选择技能目录',
    });
    if (!picked || picked.canceled || !picked.filePaths?.length) return;
    const dir = picked.filePaths[0];
    const res = await (window as any).electronAPI?.skills?.getDirectoryPreview?.(dir);
    if (res?.success) {
      dirPreview.value = res.data;
    } else {
      ElMessage.error(res?.error || '读取目录失败');
    }
  } catch (e) {
    console.error('选择技能目录失败', e);
  }
};

const confirmAddSkillDirectory = async (): Promise<void> => {
  if (!dirPreview.value) return;
  const res = await (window as any).electronAPI?.skills?.addCustomDir?.(dirPreview.value.path);
  if (res?.success) {
    ElMessage.success('技能目录已添加');
    dirPreview.value = null;
    await loadStorageInfo();
    await loadSkills();
  } else {
    ElMessage.error(res?.error || '添加失败');
  }
};

const removeSkillDirectory = async (dir: string): Promise<void> => {
  const res = await (window as any).electronAPI?.skills?.removeCustomDir?.(dir);
  if (res?.success) {
    ElMessage.success('技能目录已移除');
    await loadStorageInfo();
    await loadSkills();
  }
};

const utilityRows = ref<any[]>([]);

// ══════════ 【M4-E】技能验证(受控对照) ══════════
const trialSkillId = ref('');
const trialTasksText = ref('');
const trialRunning = ref(false);
const trialResult = ref<any>(null);

const trialVerdictType = computed(() => {
  const v = trialResult.value?.summary?.verdict;
  if (v === 'positive') return 'success';
  if (v === 'negative') return 'danger';
  if (v === 'insufficient_data') return 'warning';
  return 'info';
});

const runTrial = async (): Promise<void> => {
  if (!trialSkillId.value) {
    ElMessage.warning('先选一个要验证的技能');
    return;
  }
  const tasks = trialTasksText.value
    .split('\n')
    .map(t => t.trim())
    .filter(Boolean)
    .map((t, i) => ({ id: `t${i}`, instruction: t }));

  if (tasks.length === 0) {
    ElMessage.warning('至少给一个任务');
    return;
  }

  // 成本提示 —— 每个任务跑两遍,token 翻倍
  try {
    await ElMessageBox.confirm(
      `将跑 ${tasks.length} 个任务，每个任务两遍（带技能 / 禁技能），共 ${tasks.length * 2} 次模型调用。\n\ntoken 成本大约翻倍。`,
      '开始技能验证？',
      { confirmButtonText: '开始', cancelButtonText: '取消', type: 'warning' },
    );
  } catch {
    return;
  }

  trialRunning.value = true;
  trialResult.value = null;
  try {
    const res = await (window as any).electronAPI?.skills?.runUtilityTrial?.({
      skillId: trialSkillId.value,
      tasks,
    });
    if (res?.success) {
      trialResult.value = res.data;
    } else {
      ElMessage.error(res?.error || '验证失败');
    }
  } catch (e) {
    console.error('runTrial failed', e);
    ElMessage.error('验证失败');
  } finally {
    trialRunning.value = false;
  }
};

const loadUtility = async () => {
  try {
    const result = await (window as any).electronAPI?.skills?.getUtility?.();
    if (result?.success && Array.isArray(result.data)) {
      utilityRows.value = result.data;
    }
  } catch (error) {
    console.error('加载边际效用失败', error);
  }
};

const negativeUtilityCount = computed(() =>
  utilityRows.value.filter((r: any) => typeof r.delta === 'number' && r.delta < 0).length
);

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
  loadStorageInfo();

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

.note-strong {
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
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

/* 【M3-D】技能目录 */
.skills-dir-card {
  margin-top: var(--space-md);
}

.skills-trial-card {
  margin-top: var(--space-md);
}

.trial-result {
  margin-top: var(--space-sm);
}

.dir-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--space-sm);
}

.dir-primary,
.dir-extra {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  padding: 4px 0;
}

.dir-label {
  font-size: var(--font-size-body);
  color: var(--text-secondary);
  min-width: 48px;
}

.dir-path {
  font-size: var(--font-size-caption);
  color: var(--text-primary);
  background: var(--bg-secondary);
  padding: 2px 6px;
  border-radius: 4px;
  word-break: break-all;
}

.dir-empty {
  margin: var(--space-xs) 0 0;
  font-size: var(--font-size-caption);
  color: var(--text-secondary);
}

.dir-preview {
  margin-top: var(--space-sm);
  padding: var(--space-sm);
  border: 1px dashed var(--border-color);
  border-radius: 8px;
}

.dir-preview-head {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  margin-bottom: var(--space-xs);
}

.dir-preview-empty {
  font-size: var(--font-size-caption);
  color: var(--text-secondary);
}

.dir-preview-list {
  margin-bottom: var(--space-xs);
}

.dir-preview-actions {
  display: flex;
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
