/**
 * PiPiClaw - 聊天管理器
 * 
 * 职责：
 * 1. 聊天消息处理（流式/非流式）
 * 2. 对话管理（新建/历史）
 */

import https from 'https';
import http from 'http';
import { URL } from 'url';
import { createHash } from 'node:crypto';
import { BrowserWindow } from 'electron';
import { LogManager } from '../core/LogManager';
import { ChatConfig } from './ChatConfig';
import { ModelManager } from '../models/ModelManager';
import { toLlmProviderConfig } from '../models/ModelProvider';
import { HermesMemory } from '../hermes/HermesMemory';
import { HermesAdapter, RECALL_CHAT_MIN_SCORE } from '../hermes/HermesAdapter';
import { TaskExecutor } from '../task/TaskExecutor';
import { InstructionGenerator } from '../task/InstructionGenerator';
import { HistoryAssembler } from './HistoryAssembler';
import { SelfLearner } from '../learning/SelfLearner';
import { SkillEffectivenessTracker } from '../learning/SkillEffectivenessTracker';
import { classifyFailure } from '../learning/FailureClassifier';
import { normalizeTaskCategory } from '../learning/TaskCategory';
import { runSkillTrial, type TrialExecutor, type TrialResult, type TrialTask } from '../learning/SkillTrial';
import { AcceptanceLog } from '../learning/AcceptanceLog';
import type { GradableRun } from '../learning/TaskGrader';
import { CostTracker } from '../insight/CostTracker';
import { ConfigStore } from '../core/ConfigStore';
import { AgentEventRelayBus, type AgentRunEvent } from '../agent/AgentEventRelay';
import type { Conversation, ChatMessage, ChatSettings, MessageRole, MessageStatus, StreamChunk } from './ChatTypes';
import type { AgentBrain, Disposable } from '../contracts/types';

/** agent 派发结果 —— handled=false 时调用方须回落旧管道 */
export interface AgentDispatchResult {
  handled: boolean
  content?: string
  totalTokens?: number
  iterations?: number
  toolCalls?: Array<{ name: string; ok: boolean; durationMs: number; entity?: { kind: string; id: string } }>
  /**
   * 【M4-D】本次 run 实际应用过的技能 id。
   * 「技能被应用后有没有用」这个问题,前提是能说出哪些技能被应用了 ——
   * 由工具自己声明(LoadSkillTool 返回 appliedEntity),brain 汇总上抛。
   */
  appliedSkills?: string[]
  /** 助手占位消息 id(渲染层据此回填最终内容) */
  messageId?: string
  runId?: string
  reason?: string
}

export class ChatManager {
  private static instance: ChatManager;
  private log = LogManager.getInstance();
  private config!: ChatConfig;
  private modelManager!: ModelManager;
  private abortControllers: Map<string, AbortController> = new Map();
  /** M1-C: agent 运行事件中继(把 brain 事件关联会话后广播到渲染层) */
  private agentEventRelay = AgentEventRelayBus;
  /** 【M1-D】等待用户确认的计划表 planId → resolve(true=确认,false=拒绝) */
  private confirmHandlers: Map<string, (confirmed: boolean) => void> = new Map();

  private constructor() {
    this.log.info('[ChatManager] 初始化');
    try {
      // 初始化核心组件，遇到单个组件失败不影响其他组件
      try {
        this.config = ChatConfig.getInstance();
      } catch (e) {
        this.log.error('[ChatManager] ChatConfig 初始化失败', e);
        // 如果 ChatConfig 失败，无法继续工作
        throw new Error('聊天配置初始化失败');
      }

      // 可选组件，即使失败不影响基本功能
      try {
        this.modelManager = ModelManager.getInstance();
      } catch (e) {
        this.log.warn('[ChatManager] ModelManager 初始化失败，部分功能不可用', e);
        // 创建一个空的 modelManager 占位符
        this.modelManager = {
          getProvider: () => null,
          getAllProviders: () => []
        } as any;
      }

      try {
        HermesMemory.getInstance();
      } catch (e) {
        this.log.warn('[ChatManager] HermesMemory 初始化失败，记忆功能不可用', e);
      }

      try {
        SelfLearner.getInstance();
      } catch (e) {
        this.log.warn('[ChatManager] SelfLearner 初始化失败，学习功能不可用', e);
      }

      this.log.info('[ChatManager] 初始化成功');
    } catch (error) {
      this.log.error('[ChatManager] 初始化失败', error);
      // 即使部分组件失败，也确保 ChatManager 实例可用
      if (!this.config) {
        // 如果 ChatConfig 没有初始化，尝试再次获取或创建一个空的
        try {
          this.config = ChatConfig.getInstance();
        } catch (e) {
          this.log.error('[ChatManager] ChatConfig 再次初始化失败，应用将无法正常工作', e);
        }
      }
    }
  }

  public static getInstance(): ChatManager {
    if (!ChatManager.instance) {
      ChatManager.instance = new ChatManager();
    }
    return ChatManager.instance;
  }

  /** W12.1 测试 helper:重置单例(测试间隔离用,生产代码勿调) */
  public static destroy(): void {
    ChatManager.instance = null as any;
  }

  // ============ 对话管理核心方法 ============

  public getAllConversations(): Conversation[] {
    return this.config.getAllConversations();
  }

  public getActiveConversations(): Conversation[] {
    return this.config.getAllConversations().filter(c => c.status === 'active');
  }

  public getConversation(id: string): Conversation | undefined {
    return this.config.getConversation(id);
  }

  public createConversation(data?: { title?: string; providerId?: string; modelId?: string }): Conversation {
    this.log.info('[ChatManager] 创建新对话');
    return this.config.createConversation(data);
  }

  public updateConversation(id: string, updates: Partial<Conversation>): Conversation | null {
    return this.config.updateConversation(id, updates);
  }

  public deleteConversation(id: string): boolean {
    this.abortControllers.delete(id);
    return this.config.deleteConversation(id);
  }

  public archiveConversation(id: string): Conversation | null {
    return this.config.archiveConversation(id);
  }

  public pinConversation(id: string, pinned: boolean): Conversation | null {
    return this.config.pinConversation(id, pinned);
  }

  public getSettings(): ChatSettings {
    return this.config.getSettings();
  }

  public updateSettings(settings: Partial<ChatSettings>): ChatSettings {
    return this.config.updateSettings(settings);
  }

  public getMessage(conversationId: string, messageId: string): ChatMessage | undefined {
    return this.config.getMessage(conversationId, messageId);
  }

  public addMessage(conversationId: string, message: ChatMessage): ChatMessage | null {
    return this.config.addMessage(conversationId, message);
  }

  public updateMessage(conversationId: string, messageId: string, updates: Partial<ChatMessage>): ChatMessage | null {
    return this.config.updateMessage(conversationId, messageId, updates);
  }

  public stopGeneration(conversationId: string): void {
    const controller = this.abortControllers.get(conversationId);
    if (controller) {
      controller.abort();
      this.abortControllers.delete(conversationId);
    }
  }

  // ============ 核心消息发送方法 ============

  public async sendMessage(
    conversationId: string,
    content: string,
    providerId?: string,
    modelId?: string,
    settings?: Partial<ChatSettings>
  ): Promise<ChatMessage> {
    const traceId = `msg_${Date.now()}`;
    this.log.info(`[ChatManager] [${traceId}] 收到消息发送请求`);
    this.log.info(`[ChatManager] 用户选择: provider=${providerId || '未指定'}, model=${modelId || '未指定'}`);

    // 1. 检查是否是用户确认技能保存
    if (content.trim() === '是' || content.trim() === '确认' || content.trim() === 'yes') {
      const selfLearner = SelfLearner.getInstance();
      const pendingProposal = selfLearner.getPendingProposal();
      
      if (pendingProposal) {
        // 用户确认保存技能
        this.log.info('[ChatManager] 用户确认保存技能', { name: pendingProposal.name });
        
        // 添加用户消息
        const userMessage: ChatMessage = {
          id: `user_${Date.now()}`,
          role: 'user',
          content,
          timestamp: Date.now(),
          status: 'sent',
          providerId,
          modelId
        };
        this.config.addMessage(conversationId, userMessage);
        this.broadcastMessage(conversationId, userMessage);
        
        // 保存技能
        const saved = selfLearner.saveSkillFromProposal(pendingProposal);
        
        // 回复用户
        const replyMessage: ChatMessage = {
          id: `assistant_${Date.now()}`,
          role: 'assistant',
          content: saved 
            ? `✅ 太棒了！我已经把这个操作保存为技能"${pendingProposal.name}"了。以后你可以直接用关键词触发它。`
            : '❌ 保存技能失败，请稍后重试。',
          timestamp: Date.now(),
          status: 'sent',
          providerId,
          modelId
        };
        
        this.config.addMessage(conversationId, replyMessage);
        this.broadcastMessage(conversationId, replyMessage);
        this.broadcastConversationUpdate(conversationId);
        
        // 通知前端有新技能提案
        const windows = BrowserWindow.getAllWindows();
        windows.forEach(w => {
          if (!w.isDestroyed()) {
            w.webContents.send('skills:new-proposal', pendingProposal);
          }
        });
        
        return replyMessage;
      }
    }

    // 2. 【M4-Q 修】把传入的 provider/model **落到会话上**。
    // 此前 sendMessage 收了 providerId 却只写进"用户消息"里,**从不写会话**;
    // 而 agent 路径(dispatchToAgent)读的是**会话上的** providerId
    // → 经 IPC 发消息(IM 通道 / 定时任务 / 语音 / 任何外部调用方)时
    //   agent 永远拿不到 provider → 每条消息都报
    //   「[LlmAgentBrain error] no LLM provider configured」→ 回落旧管道
    //   → **学习闭环(M4-B/M4-F)记到的全是这种失败**。
    // UI 路径没暴露这个问题,是因为模型选择器自己调了 store.setCurrentModel
    // (它会 updateConversation)—— 两条路径不一致。
    if (providerId || modelId) {
      const conv = this.config.getConversation(conversationId);
      if (conv && (conv.providerId !== providerId || conv.modelId !== modelId)) {
        this.config.updateConversation(conversationId, { providerId, modelId });
      }
    }

    // 3. 添加用户消息
    const userMessage: ChatMessage = {
      id: `user_${Date.now()}`,
      role: 'user',
      content,
      timestamp: Date.now(),
      status: 'sent',
      providerId,
      modelId
    };
    this.config.addMessage(conversationId, userMessage);
    this.broadcastMessage(conversationId, userMessage);

    // 2.5 【W5 接线 · M1-B】agent tool loop 优先
    //   真 tool-call 循环此前零生产调用方(死代码),现接入主链路。
    //   回落保证:未注册 agent / LLM 未配置 / 抛错 → handled:false,继续走下方旧管道,
    //   可用性不回退。执行模式为 'safe' 时跳过 agent(纯对话)。
    if (this.shouldUseAgentLoop()) {
      try {
        const agentResult = await this.dispatchToAgent(conversationId, content, 'ui');
        if (agentResult.handled) {
          /**
           * 【M4-B】agent loop 路径的观察 + 结果反馈。
           *
           * 依据业界调研的四组件模型(缺一环则闭环不成立):
           *   ① 轨迹捕获 ← agent 事件(已有)
           *   ② 结果追踪 ← 本行:把成败与失败模式写进 tracker
           *   ③ 诊断反馈 ← failure 分类(工具错/权限/超时/限流…)
           *   ④ 持久存储 ← skill-stats.json + observations.json(已有)
           *
           * 此前 agent loop 路径【完全不产生学习数据】—— 只有旧的
           * TaskExecutor 管道有观察端。这是最重要的能力路径,却是盲区。
           */
          this.recordAgentOutcome(conversationId, content, agentResult);

          /**
           * 【M4-F】登记这次运行,等用户给出接受度信号。
           *
           * 用户信号是**事后**才有的(看到答复才可能点「重新生成」或纠正),
           * 所以必须先登记运行,信号来了才对得上号。
           */
          try {
            if (agentResult.messageId) {
              AcceptanceLog.getInstance().registerRun({
                conversationId,
                messageId: agentResult.messageId,
                skills: agentResult.appliedSkills ?? [],
                category: this.normalizeTaskCategory(content),
                ts: Date.now(),
              });
            }
          } catch (e) {
            this.log.warn('[ChatManager] 接受度登记失败(不阻塞)', e);
          }

          this.broadcastConversationUpdate(conversationId);
          const done = agentResult.messageId
            ? this.config.getMessage(conversationId, agentResult.messageId)
            : null;
          return (done ?? userMessage) as ChatMessage;
        }
        this.log.info(`[ChatManager] [${traceId}] agent loop 未接管(${agentResult.reason}),回落旧管道`);
      } catch (e) {
        this.log.warn(`[ChatManager] [${traceId}] agent loop 异常,回落旧管道`, e);
      }
    }

    // 3. 尝试用大模型生成操作步骤并执行
    try {
      const instructionGenerator = InstructionGenerator.getInstance();
      const taskExecutor = TaskExecutor.getInstance();

      // DEV-020 修冷启动: 从真源 (main 侧 ChatConfig.conversations[id].messages) 拉前 N-1 轮历史
      //   userMessage 已在 L235 addMessage 落真源 → 用 userMessage.id 排除, 防当前轮被重复拼
      //   HistoryAssembler: 窗口 10 轮 + 16000 字符, system 恒首位/当前 user 恒末位 (生成器侧拼装)
      const _conv = this.config.getConversation(conversationId);
      const _history = HistoryAssembler.buildHistory(_conv?.messages ?? [], userMessage.id);

      const steps = await instructionGenerator.generateTaskSteps(content, providerId, modelId, _history);
      
      if (steps && steps.length > 0) {
        this.log.info(`[ChatManager] [${traceId}] 大模型生成了 ${steps.length} 个步骤，准备执行`);

        // 创建助手占位消息
        const placeholderId = `assistant_${Date.now()}`;
        const placeholder: ChatMessage = {
          id: placeholderId,
          role: 'assistant',
          content: '🔧 正在执行操作...',
          timestamp: Date.now(),
          status: 'streaming',
          providerId,
          modelId
        };
        this.config.addMessage(conversationId, placeholder);
        this.broadcastMessage(conversationId, placeholder);

        // 执行任务
        const task = {
          id: `task_${Date.now()}`,
          conversationId,
          messageId: placeholderId,
          instruction: content,
          steps: steps.map((step, i) => ({
            id: `step_${i}`,
            order: i + 1,
            type: step.action,
            description: step.description || `执行 ${step.action}`,
            params: step.params,
            requiredPermission: 'filesystem',
            requiredAction: 'write',
            status: 'pending'
          })),
          status: 'pending',
          createdAt: Date.now()
        };

        /**
         * 【M1-D】执行确认闸门。
         *
         * 修复前: 渲染层 Chat.vue 的"确认执行任务"弹窗是死代码
         * (showTaskConfirmDialog 从未被置 true),LLM 生成步骤后【立即执行】,
         * 用户全程黑盒。
         *
         * 现在: 除 'safe'(纯对话)外,plan 与 craft 两种执行模式都要先 emit
         * 计划事件 → 等用户确认 → 才执行。用户已明确选择"所有任务都确认"。
         * 无渲染窗口(定时任务/IM)或 60s 超时 → fail-safe 拒绝。
         */
        if (this.getExecutionMode() !== 'safe') {
          const confirmed = await this.requestPlanConfirmation(
            conversationId,
            content,
            steps.map((s, i) => ({
              order: i + 1,
              description: s.description || `执行 ${s.action}`,
              status: 'pending' as const,
              params: s.params ?? {},
            })),
          );
          if (!confirmed) {
            this.log.info(`[ChatManager] [${traceId}] 用户未确认执行,已取消`);
            this.config.updateMessage(conversationId, placeholderId, {
              content: '已取消执行。如果你不想这个计划,可以直接说明要调整的地方。',
              status: 'sent',
            });
            this.broadcastMessage(conversationId, {
              ...placeholder,
              content: '已取消执行。如果你不想这个计划,可以直接说明要调整的地方。',
              status: 'sent',
            });
            this.broadcastConversationUpdate(conversationId);
            return this.config.getMessage(conversationId, placeholderId) as ChatMessage;
          }
        }

        const result = await taskExecutor.executeTask(task as any, 'ui');

        // 更新助手消息 - 详细的任务结果格式
        // 构建详细步骤列表
        let resultContent = result.success ? '✅ 任务执行成功\n\n' : '❌ 任务执行失败\n\n';
        const taskResultSteps = result.result?.steps || [];

        // 构建步骤详情（用于存储和渲染）
        const taskSteps = taskResultSteps.map((step: any, index: number) => {
            const originalStep = steps[index];
            const stepInfo = {
                order: index + 1,
                description: step.description || originalStep?.description || `步骤 ${index + 1}`,
                status: step.status || 'success',
                duration: step.endTime && step.startTime ? step.endTime - step.startTime : 0,
                error: step.error || null,
                params: originalStep?.params || null
            };
            return stepInfo;
        });

        if (result.result?.steps) {
            for (let i = 0; i < result.result.steps.length; i++) {
                const stepResult = result.result.steps[i];
                const originalStep = steps[i];
                const statusIcon = stepResult.status === 'success' ? '✅' : '❌';
                resultContent += `${statusIcon} **步骤 ${i + 1}**：${originalStep.description || originalStep.action}\n`;

                // 如果有更详细的描述，追加显示
                if ((stepResult as any).description && (stepResult as any).description !== originalStep.description) {
                    resultContent += `   > ${(stepResult as any).description}\n`;
                }

                // 如果是文件操作，显示核心参数
                if (originalStep.params) {
                    if (originalStep.params.filePath || originalStep.params.path) {
                        resultContent += `   📁 路径：\`${originalStep.params.filePath || originalStep.params.path}\`\n`;
                    }
                    if (originalStep.params.content) {
                        const preview = originalStep.params.content.length > 100
                            ? originalStep.params.content.substring(0, 100) + '...'
                            : originalStep.params.content;
                        resultContent += `   📝 内容预览：\`${preview}\`\n`;
                    }
                }

                if (stepResult.result) {
                    resultContent += `   ⏱️ 耗时：${stepResult.result.duration || 'N/A'}ms\n`;
                }
                if (stepResult.error) {
                    resultContent += `   ❌ 错误：${stepResult.error}\n`;
                }
                resultContent += '\n';
            }
        }

        if (result.error) {
            resultContent += `\n❌ 任务错误：${result.error}`;
        }

        resultContent += `\n⏱️ 总耗时：${result.duration}ms`;

        const finalMsg: ChatMessage = {
          id: placeholderId,
          role: 'assistant',
          content: resultContent,
          timestamp: Date.now(),
          status: 'sent',
          providerId,
          modelId,
          taskResult: {
            success: result.success,
            status: result.success ? 'completed' : 'failed',
            steps: taskSteps,
            summary: result.summary,
            error: result.error,
            duration: result.duration
          }
        } as any;

        this.config.updateMessage(conversationId, placeholderId, finalMsg);
        this.broadcastMessage(conversationId, finalMsg);
        this.broadcastConversationUpdate(conversationId);
        
        // ============ Hermes 自我学习 ============
        /**
         * 【M4-B 修正】此前【只观察成功的执行】(if (result.success))——
         * 失败样本全被丢弃。而调研明确:「保留失败 —— 把事故转成评测用例,
         * 而不是让它们消失」。失败样本恰恰是最有学习价值的。
         *
         * 现在成功与失败都观察,并附带失败诊断。
         *
         * 【容错红线 — 整块包 try/catch】
         * 学习是【旁路】,不是主链路的一部分。前一版把 observeExecution 裸调,
         * 一旦它抛错(哪怕是被单测 mock 掉一个静态方法),整个任务流就抛 →
         * 被上层 catch → 回退普通对话流 → 用户看到的是"LLM 连不上"这种
         * 无关错误,而真正的失败原因(任务被拒/命令失败)被吞掉了。
         * 这违反 #006.5 W1 立的"catch→log, 不阻塞 chat 主流"红线。
         * 现在:整块兜住,任何异常只记日志,主流程结果一字不改。
         */
        try {
          const selfLearner = SelfLearner.getInstance();
          const resultSteps = (result.result?.steps ?? []) as Array<Record<string, any>>;
          const failedStep = resultSteps.find(
            (s) => s?.status === 'failed' || s?.error,
          );
          selfLearner.observeExecution(
            content,
            steps,
            result,
            {
              source: 'task_executor',
              toolsUsed: steps.map((s: any) => s?.action).filter(Boolean),
              ...(failedStep
                ? {
                    failure: {
                      stepIndex: resultSteps.indexOf(failedStep),
                      ...classifyFailure(failedStep?.error, failedStep?.description),
                    },
                  }
                : {}),
            },
          );

          // 效果反馈:每个步骤一条 —— 让 tracker 有数据可统计
          const tracker = SkillEffectivenessTracker.getInstance();
          for (const s of resultSteps) {
            tracker.record({
              skillName: s?.type ?? s?.description ?? 'unknown',
              unitType: 'tool',
              ts: Date.now(),
              durationMs: Math.max(0, (s?.endTime ?? 0) - (s?.startTime ?? 0)),
              success: s?.status !== 'failed' && !s?.error,
              conversationId,
            });
          }
        } catch (e) {
          this.log.warn('[ChatManager] M4-B 学习记录失败(不阻塞 chat 流)', e);
        }

        return finalMsg;
      }
    } catch (taskError) {
      this.log.error(`[ChatManager] [${traceId}] 任务执行失败，回退普通对话:`, taskError);
    }

    // 3. 普通对话流（当任务执行失败或没有生成步骤时）
    return this.handleNormalChat(conversationId, content, providerId, modelId, settings, traceId);
  }

  // ============ 普通对话流 ============

  private async handleNormalChat(
    conversationId: string,
    content: string,
    providerId?: string,
    modelId?: string,
    settings?: Partial<ChatSettings>,
    _traceId?: string
  ): Promise<ChatMessage> {
    const conversation = this.config.getConversation(conversationId);
    if (!conversation) throw new Error('会话不存在');

    const effectiveProviderId = providerId || conversation.providerId;
    const effectiveModelId = modelId || conversation.modelId;

    if (!effectiveProviderId || !effectiveModelId) {
      throw new Error('请先选择模型');
    }

    const provider = this.modelManager.getProvider(effectiveProviderId);
    if (!provider) throw new Error('模型提供商不存在');

    this.log.info(`[ChatManager] 实际调用: provider=${provider.name}, type=${provider.type}, model=${effectiveModelId}, url=${provider.baseUrl || 'N/A'}`);

    // 创建助手消息占位
    const assistantMessageId = `assistant_${Date.now()}`;
    const assistantPlaceholder: ChatMessage = {
      id: assistantMessageId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      status: 'streaming',
      providerId: effectiveProviderId,
      modelId: effectiveModelId
    };
    this.config.createStreamingMessage(conversationId, assistantPlaceholder);
    this.broadcastMessage(conversationId, assistantPlaceholder);

    try {
      const mergedSettings = { ...this.getSettings(), ...settings };
      const chatHistory = conversation.messages
        .filter(m => m.id !== assistantMessageId && m.role !== 'system')
        .map(m => ({ role: m.role, content: m.content }));

      const hermes = HermesMemory.getInstance();
      // #006.5 R-2 口径声明 (buildMemoryPrompt 内容清单 = HermesMemory.ts:182-201, 仅 2 段):
      //   段1 "## 用户核心记忆" — getCoreMemory() 读 USER.md 全文 (HermesMemory.ts:183/188-190)
      //   段2 "## 相关历史记忆" — retrieveRelevantMemories() 按 importance-时间 排序 (HermesMemory.ts:184/192-198)
      // R-2 降级声明: 第 3 段 "## 相关记忆 (管线召回)" 为 #006.5 叠加, stub embedding 管线验收口径
      //   (stub 伪向量余弦, 非真实语义排序; 真 embedding 接 DEV-027 同批后阈值语义重审);
      //   前 2 段【本体内容零动】 + 【其他消费者零动】 (S2 实查: 生产调用方仅本处 ChatManager.ts:437)
      const memoryPromptBase = hermes.buildMemoryPrompt(content);
      let memoryPrompt = memoryPromptBase;
      try {
        const adapter = HermesAdapter.getInstance();
        const recalled = await adapter.recall(content, { topK: 3, minScore: RECALL_CHAT_MIN_SCORE, useVector: true, useKeyword: false });
        if (recalled.length > 0) {
          const vecMem = recalled.map(m => `- ${m.content}`).join('\n');
          memoryPrompt = `${memoryPrompt}\n## 相关记忆 (管线召回, stub 口径)\n${vecMem}\n`.trim();
        }
      } catch (e) {
        // R-2 容错: recall 失败不阻塞活跃链 chat 流 — 降级为仅前 2 段 (memoryPromptBase)
        this.log.warn('[ChatManager] #006.5 R-2 recall 降级: 管线召回段失败, 核心记忆+历史记忆段仍生效', e);
      }

      let systemPrompt = '你是PiPiClaw智能助手，一个专业的AI自动化助手，内置OpenClaw本地执行引擎。';
      if (memoryPrompt.trim()) {
        systemPrompt += `\n\n用户记忆:\n${memoryPrompt}`;
      }

      const fullMessages = [
        { role: 'system' as MessageRole, content: systemPrompt },
        ...chatHistory,
        { role: 'user' as MessageRole, content }
      ];

      await this.streamModelResponse(
        conversationId,
        assistantMessageId,
        effectiveProviderId,
        effectiveModelId,
        fullMessages,
        mergedSettings
      );

      this.config.setLastProvider(effectiveProviderId);
      this.config.setLastModel(effectiveModelId);

      const finalMsg = this.config.getMessage(conversationId, assistantMessageId);
      if (finalMsg?.content) {
        const shouldPrecipitate = /(文件|文件夹|目录|创建|写入|修改|删除|整理|习惯|偏好|喜欢)/.test(content)
          || /(文件|文件夹|目录|创建|写入|修改|删除|整理)/.test(finalMsg.content);

        if (shouldPrecipitate) {
          hermes.addConversationMemory(conversationId,
            `用户请求: ${content}\nAI回复: ${finalMsg.content.substring(0, 500)}${finalMsg.content.length > 500 ? '...' : ''}`,
            50
          );
          // #006.5 W1: 向量层同步沉淀 — 幂等 (同 conversationId+content → 同 id → Map 覆盖; 禁 Date.now() id,
          //   否则二次 store 同内容产生两条向量, 违反 #006 V3 upsert 同-id 覆盖的幂等口径)
          //   容错: catch→log, 不阻塞 chat 主流 (订单开工令)
          try {
            const adapter = HermesAdapter.getInstance();
            const content05 = `用户请求: ${content}\nAI回复: ${finalMsg.content.substring(0, 500)}${finalMsg.content.length > 500 ? '...' : ''}`;
            const idHash = createHash('sha256').update(`${conversationId}|${content05}`).digest('hex').slice(0, 16);
            await adapter.store({
              id: `chat-${idHash}`,
              content: content05,
              score: 50,
              createdAt: Date.now(),
            });
          } catch (e) {
            this.log.warn('[ChatManager] #006.5 W1 向量层沉淀失败 (不阻塞 chat 流)', e);
          }

          /**
           * 【M4-B 修正】普通对话流【不再产生技能学习样本】。
           *
           * 此前:被中文正则 /(文件|整理|创建|...)/ 门控后,把整轮对话
           * 推成一条观察(steps 恒为空数组)。后果:
           *   - 门控是文本猜测,与真实执行无关 —— 用户说"整理一下思路"
           *     也会被记录,但没有任何执行发生
           *   - steps 恒为 [] → 分析器拿不到任何可学的操作序列
           *   - 这样的样本进池,污染了真正有执行轨迹的样本
           *
           * 依据调研:「轨迹捕获」要的是【结构化轨迹】,不是聊天文本。
           * 真正的执行轨迹由两处产生(本批已接):
           *   - agent tool loop 路径 → recordAgentOutcome
           *   - TaskExecutor 任务流 → 上方 observeExecution(result, ...)
           * 普通对话没有执行,没有可学的东西,故不产生观察。
           *
           * 对话记忆(hermes.addConversationMemory + 向量沉淀)仍保留 ——
           * 那是"记住聊过什么",与"学技能"是两件事,不该一起砍。
           */
        }
      }

      return finalMsg || assistantPlaceholder;
    } catch (error: any) {
      this.config.finalizeStreamingMessage(conversationId, assistantMessageId, 'error', error.message);
      const errorMsg = this.config.getMessage(conversationId, assistantMessageId);
      this.broadcastMessage(conversationId, errorMsg || {
        ...assistantPlaceholder, status: 'error', error: error.message
      });
      this.broadcastConversationUpdate(conversationId);
      throw error;
    }
  }

  // ============ 流式响应处理 ============

  private async streamModelResponse(
    conversationId: string,
    messageId: string,
    providerId: string,
    modelId: string,
    messages: Array<{ role: MessageRole; content: string }>,
    settings: ChatSettings
  ): Promise<void> {
    const provider = this.modelManager.getProvider(providerId);
    if (!provider) throw new Error('模型提供商不存在');

    this.log.info(`[ChatManager] streamModelResponse: type=${provider.type}, baseUrl=${provider.baseUrl}, model=${modelId}`);

    if (provider.type === 'ollama') {
      return this.streamOllama(conversationId, messageId, provider, modelId, messages, settings);
    } else if (provider.type === 'anthropic') {
      return this.streamAnthropic(conversationId, messageId, provider, modelId, messages, settings);
    } else {
      return this.streamCloudProvider(conversationId, messageId, provider, modelId, messages, settings);
    }
  }

  private async streamAnthropic(
    conversationId: string, messageId: string, provider: any, modelId: string,
    messages: any[], settings: ChatSettings
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let baseUrl = provider.baseUrl;
      if (!baseUrl) { reject(new Error('缺少baseUrl')); return; }
      baseUrl = baseUrl.replace(/\/$/, '');
      const url = new URL(`${baseUrl}/v1/messages`);

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'x-api-key': provider.apiKey || '',
        'anthropic-version': '2023-06-01'
      };

      // 分离 system 消息和其他消息
      let systemMessage = '';
      const filteredMessages = messages.filter(m => {
        if (m.role === 'system') {
          systemMessage = m.content;
          return false;
        }
        return true;
      }).map(m => ({ role: m.role, content: m.content }));

      const body: any = {
        model: modelId,
        messages: filteredMessages,
        stream: true,
        max_tokens: settings.maxTokens || 4096
      };
      if (systemMessage) {
        body.system = systemMessage;
      }

      const controller = new AbortController();
      this.abortControllers.set(conversationId, controller);
      const timeout = setTimeout(() => controller.abort(), 60000);
      const protocol = url.protocol === 'https:' ? https : http;

      const req = protocol.request(
        {
          hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: url.pathname,
          method: 'POST',
          headers,
          signal: controller.signal
        },
        (res) => {
          let buffer = '';
          let accumulatedContent = '';

          // 处理错误响应
          if (res.statusCode && res.statusCode >= 400) {
            let errorData = '';
            res.on('data', chunk => { errorData += chunk.toString(); });
            res.on('end', () => {
              clearTimeout(timeout);
              this.abortControllers.delete(conversationId);
              
              let errorMessage = `请求失败: HTTP ${res.statusCode}`;
              try {
                const errorJson = JSON.parse(errorData);
                errorMessage = errorJson.error?.message || errorJson.message || errorMessage;
              } catch { /* ignore parse error */ }
              
              if (res.statusCode === 401) {
                errorMessage = 'API Key无效，请检查您的Anthropic API Key';
              } else if (res.statusCode === 429) {
                errorMessage = '请求过于频繁，请稍后再试';
              }
              
              this.handleStreamError(conversationId, messageId, errorMessage);
              reject(new Error(errorMessage));
            });
            return;
          }

          res.on('data', chunk => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              if (!line.trim() || !line.startsWith('data: ')) continue;
              const dataStr = line.slice(6).trim();
              if (dataStr === '[DONE]') continue;

              try {
                const data = JSON.parse(dataStr);
                if (data.type === 'content_block_delta') {
                  const delta = data.delta;
                  if (delta.type === 'text_delta' && delta.text) {
                    accumulatedContent += delta.text;
                    this.config.appendStreamingContent(conversationId, messageId, accumulatedContent, '');
                    // Phase 3 Task 1: 逐 token 推送
                    this.broadcastStreamChunk(conversationId, messageId, delta.text, 'content');
                    const updated = this.config.getMessage(conversationId, messageId);
                    if (updated) this.broadcastMessage(conversationId, updated);
                  }
                } else if (data.type === 'message_stop') {
                  // 流结束，完成处理
                }
              } catch (e) { /* ignore parse errors */ }
            }
          });

          res.on('end', () => {
            clearTimeout(timeout);
            this.abortControllers.delete(conversationId);
            this.config.appendStreamingContent(conversationId, messageId, accumulatedContent, '');
            this.config.finalizeStreamingMessage(conversationId, messageId, 'sent');
            this.broadcastConversationUpdate(conversationId);
            resolve();
          });
        }
      );

      req.on('error', (error) => {
        clearTimeout(timeout);
        this.abortControllers.delete(conversationId);
        
        // 火山引擎错误日志
        if (provider.type === 'volc_ark') {
          this.log.error('[火山引擎] 聊天请求失败', { error: error.message });
        }
        
        if (error.name === 'AbortError') {
          this.handleStreamError(conversationId, messageId, '用户停止了生成或请求超时');
          reject(new Error('用户停止了生成或请求超时'));
        } else {
          this.handleStreamError(conversationId, messageId, error.message);
          reject(error);
        }
      });

      req.write(JSON.stringify(body));
      req.end();
    });
  }

  private isThinkingSupportedModel(modelId: string): boolean {
    const lower = modelId.toLowerCase();
    return lower.includes('qwen') || lower.includes('deepseek');
  }

  private async streamOllama(
    conversationId: string, messageId: string, provider: any, modelId: string,
    messages: any[], _settings: ChatSettings
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let baseUrl = provider.baseUrl || 'http://localhost:11434';
      baseUrl = baseUrl.replace(/\/$/, '');
      const url = new URL(`${baseUrl}/api/chat`);

      const ollamaMessages = messages.map(m => ({ role: m.role, content: m.content }));
      const body: any = { model: modelId, messages: ollamaMessages, stream: true };

      if (this.isThinkingSupportedModel(modelId)) {
        body.options = { think: true };
      }

      const controller = new AbortController();
      this.abortControllers.set(conversationId, controller);
      const timeout = setTimeout(() => controller.abort(), 120000);

      const protocol = url.protocol === 'https:' ? https : http;

      const req = protocol.request(
        {
          hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 11434),
          path: url.pathname, method: 'POST', headers: { 'Content-Type': 'application/json' },
          signal: controller.signal
        },
        (res) => {
          let buffer = '';
          let accumulatedContent = '';
          let accumulatedThinking = '';
          const lastContentUpdate = 0;
          let lastThinkingUpdate = 0;

          res.on('data', chunk => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              if (!line.trim()) continue;
              try {
                const data = JSON.parse(line);
                if (this.isThinkingSupportedModel(modelId) && data.message?.think) {
                  const thinkChunk = data.message.think;
                  accumulatedThinking += thinkChunk;
                  // Phase 3 Task 1: 逐 token 推送 thinking
                  this.broadcastStreamChunk(conversationId, messageId, thinkChunk, 'thinking');
                  const now = Date.now();
                  if (now - lastThinkingUpdate > 100) {
                    lastThinkingUpdate = now;
                    this.config.appendStreamingContent(conversationId, messageId, accumulatedContent, accumulatedThinking);
                    const updated = this.config.getMessage(conversationId, messageId);
                    if (updated) this.broadcastMessage(conversationId, updated);
                  }
                }
                if (data.message?.content) {
                  const contentChunk = data.message.content;
                  accumulatedContent += contentChunk;
                  // Phase 3 Task 1: 逐 token 推送 content
                  this.broadcastStreamChunk(conversationId, messageId, contentChunk, 'content');
                  const now = Date.now();
                  if (now - lastContentUpdate > 50) {
                    lastThinkingUpdate = now;
                    this.config.appendStreamingContent(conversationId, messageId, accumulatedContent, accumulatedThinking);
                    const updated = this.config.getMessage(conversationId, messageId);
                    if (updated) this.broadcastMessage(conversationId, updated);
                  }
                }
              } catch (e) { /* ignore parse errors */ }
            }
          });

          res.on('end', () => {
            clearTimeout(timeout);
            this.abortControllers.delete(conversationId);
            
            // 火山引擎响应日志
            if (provider.type === 'volc_ark') {
              if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                this.log.info('[火山引擎] 聊天请求成功');
              } else {
                this.log.error('[火山引擎] 聊天请求失败', { statusCode: res.statusCode });
              }
            }
            
            this.config.appendStreamingContent(conversationId, messageId, accumulatedContent, accumulatedThinking);
            this.config.finalizeStreamingMessage(conversationId, messageId, 'sent');
            this.broadcastConversationUpdate(conversationId);
            resolve();
          });
        }
      );

      req.on('error', (error) => {
        clearTimeout(timeout);
        this.abortControllers.delete(conversationId);
        if (error.name === 'AbortError') {
          this.handleStreamError(conversationId, messageId, '用户停止了生成或请求超时');
          reject(new Error('用户停止了生成或请求超时'));
        } else {
          this.handleStreamError(conversationId, messageId, error.message);
          reject(error);
        }
      });

      req.write(JSON.stringify(body));
      req.end();
    });
  }

  private buildUrl(baseUrl: string, path: string): URL {
    let cleanBaseUrl = baseUrl;
    if (cleanBaseUrl.endsWith('/')) {
      cleanBaseUrl = cleanBaseUrl.slice(0, -1);
    }
    let cleanPath = path;
    if (cleanPath.startsWith('/')) {
      cleanPath = cleanPath.slice(1);
    }
    return new URL(`${cleanBaseUrl}/${cleanPath}`);
  }

  private async streamCloudProvider(
    conversationId: string, messageId: string, provider: any, modelId: string,
    messages: any[], settings: ChatSettings
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const baseUrl = provider.baseUrl;
      if (!baseUrl) { reject(new Error('缺少baseUrl')); return; }

      let url: URL;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };

      if (provider.type === 'openai' || provider.type === 'deepseek' || provider.type === 'custom' || provider.type === 'volc_ark') {
        url = this.buildUrl(baseUrl, '/chat/completions');
        headers['Authorization'] = `Bearer ${provider.apiKey || ''}`;
        
        // 火山引擎诊断日志
        if (provider.type === 'volc_ark') {
          this.log.info('[火山引擎] 发起聊天请求', {
            url: url.toString(),
            apiKeyPrefix: provider.apiKey ? (provider.apiKey.substring(0, 6) + '...') : 'empty',
            modelId: modelId
          });
        }
      } else if (provider.type === 'azure') {
        const deploymentName = provider.deploymentName || modelId;
        url = this.buildUrl(baseUrl, `/openai/deployments/${deploymentName}/chat/completions?api-version=${provider.apiVersion || '2024-02-01'}`);
        headers['api-key'] = provider.apiKey || '';
      } else {
        reject(new Error(`不支持的提供商类型: ${provider.type}`)); return;
      }

      const body: any = { model: modelId, messages, stream: true, temperature: settings.temperature, max_tokens: settings.maxTokens };
      if (settings.topP) body.top_p = settings.topP;

      const controller = new AbortController();
      this.abortControllers.set(conversationId, controller);
      const timeout = setTimeout(() => controller.abort(), 60000);
      const protocol = url.protocol === 'https:' ? https : http;

      const req = protocol.request(
        { hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80), path: url.pathname + url.search, method: 'POST', headers, signal: controller.signal },
        (res) => {
          let buffer = '';
          let accumulatedContent = '';
          let accumulatedThinking = '';

          res.on('data', chunk => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              if (!line.trim() || !line.startsWith('data: ')) continue;
              const dataStr = line.slice(6).trim();
              if (dataStr === '[DONE]') continue;

              try {
                const data = JSON.parse(dataStr);
                const delta = data.choices?.[0]?.delta || {};

                if (provider.type === 'deepseek' && delta.thinking) {
                  accumulatedThinking += delta.thinking;
                  // Phase 3 Task 1: 逐 token 推送 deepseek thinking
                  this.broadcastStreamChunk(conversationId, messageId, delta.thinking, 'thinking');
                }

                if (delta.content) {
                  accumulatedContent += delta.content;
                  // Phase 3 Task 1: 逐 token 推送 content
                  this.broadcastStreamChunk(conversationId, messageId, delta.content, 'content');
                  this.config.appendStreamingContent(conversationId, messageId, accumulatedContent, accumulatedThinking);
                  const updated = this.config.getMessage(conversationId, messageId);
                  if (updated) this.broadcastMessage(conversationId, updated);
                }
              } catch (e) { /* ignore parse errors */ }
            }
          });

          res.on('end', () => {
            clearTimeout(timeout);
            this.abortControllers.delete(conversationId);
            this.config.appendStreamingContent(conversationId, messageId, accumulatedContent, accumulatedThinking);
            this.config.finalizeStreamingMessage(conversationId, messageId, 'sent');
            this.broadcastConversationUpdate(conversationId);
            resolve();
          });
        }
      );

      req.on('error', (error) => {
        clearTimeout(timeout);
        this.abortControllers.delete(conversationId);
        if (error.name === 'AbortError') {
          this.handleStreamError(conversationId, messageId, '用户停止了生成或请求超时');
          reject(new Error('用户停止了生成或请求超时'));
        } else {
          this.handleStreamError(conversationId, messageId, error.message);
          reject(error);
        }
      });

      req.write(JSON.stringify(body));
      req.end();
    });
  }

  private handleStreamError(conversationId: string, messageId: string, error: string): void {
    this.config.finalizeStreamingMessage(conversationId, messageId, 'error', error);
    const errMsg = this.config.getMessage(conversationId, messageId);
    this.broadcastMessage(conversationId, errMsg || { id: messageId, role: 'assistant', content: '', status: 'error', error, timestamp: Date.now() });
    this.broadcastConversationUpdate(conversationId);
  }

  public async continueGeneration(conversationId: string): Promise<void> {
    const conv = this.config.getConversation(conversationId);
    if (!conv) throw new Error('会话不存在');
    await this.sendMessage(conversationId, '请继续', conv.providerId, conv.modelId);
  }

  // ============ 事件广播方法 ============

  private broadcastMessage(conversationId: string, message: ChatMessage): void {
    const windows = BrowserWindow.getAllWindows();
    windows.forEach(w => {
      if (!w.isDestroyed()) {
        w.webContents.send('chat:onMessage', { conversationId, message });
      }
    });
  }

  /**
   * Phase 3 Task 1: 真 LLM SSE 增量推送
   * 每收到一个 SSE data 行就立即广播一个增量 chunk 到 chat:streamUpdate,
   * 渲染进程 store 通过订阅 onStreamUpdate 把 delta 累积到消息 content,
   * 实现逐 token 平滑滚动而非节流整条消息重发。
   */
  private broadcastStreamChunk(
    conversationId: string,
    messageId: string,
    delta: string,
    type: 'content' | 'thinking' = 'content'
  ): void {
    const windows = BrowserWindow.getAllWindows();
    windows.forEach(w => {
      if (!w.isDestroyed()) {
        w.webContents.send('chat:streamUpdate', { conversationId, messageId, delta, type });
      }
    });
  }

  private broadcastConversationUpdate(conversationId: string): void {
    const conversation = this.config.getConversation(conversationId);
    const windows = BrowserWindow.getAllWindows();
    windows.forEach(w => {
      if (!w.isDestroyed() && conversation) {
        w.webContents.send('chat:onConversationUpdate', { conversation });
      }
    });
  }

  public destroy(): void {
    this.abortControllers.forEach(c => c.abort());
    this.abortControllers.clear();
    ChatManager.instance = null as any;
  }

  // ============ W4.6 新增:Agent 接入点(additive,不改既有方法) ============

  private registeredAgent: AgentBrain | null = null;
  private streamHandlers: Set<(chunk: StreamChunk) => void> = new Set();
  private streamSeq = 0;

  /**
   * 注册 Agent brain(由 Agent 域在启动时调用,ChatManager 后续可通过 dispatchToAgent 把消息转给 agent)
   * 只保留最后注册的 agent;重复注册会覆盖。
   */
  public registerAgent(brain: AgentBrain): void {
    this.log.info('[ChatManager] 注册 AgentBrain');
    this.registeredAgent = brain;
  }

  /**
   * 派发消息给已注册的 agent(由 sendMessage / IpcServer / TaskExecutor 调用)
   *
   * 【W5 接线 · M1-B】此方法此前只 log decision 即丢弃(零调用方),现改为真正执行:
   *   1. 组装 history(HistoryAssembler 拉会话真源,排除当前 user 消息)
   *   2. 拉取 Hermes 记忆上下文(管线召回,缺省空串)
   *   3. 经 think() 进入 tool loop,拿到 decision + token + toolCalls
   *   4. token 记入 CostTracker(此前 run() 吐出的 token 被丢弃)
   *   5. 以流式占位消息 + onAgentEvent 广播把执行过程送到渲染层
   *
   * 失败一律返回 handled:false(不抛错),调用方据此回落旧管道,保证可用性不回退。
   *
   * contextKind 参数 (v3 #4 + 5 裁决 #4):
   *   - 'ui'        : 来自渲染进程 chat IPC
   *   - 'scheduler' : 来自 TaskExecutor 定时任务
   *   - 'im_inbound': 来自 IM 入站 (W4 预留)
   *   - 未提供     : 按 'headless' 兜底 (fail-safe, 拒绝 confirm 级命令)
   * 绝不从 LLM 自报, 由入口硬编码。
   */
  public async dispatchToAgent(
    conversationId: string,
    content: string,
    contextKind: 'ui' | 'headless' | 'im_inbound' | 'scheduler' = 'ui',
    /** 【M4-E】本次运行禁用的技能 id(配对对照的「不带技能」变体) */
    suppressedSkills: string[] = [],
  ): Promise<AgentDispatchResult> {
    if (!this.registeredAgent) {
      this.log.debug('[ChatManager] dispatchToAgent: 未注册 agent,跳过');
      return { handled: false, reason: 'no-agent' };
    }

    const conv = this.config.getConversation(conversationId);
    const history = HistoryAssembler.buildHistory(conv?.messages ?? [], '');

    /**
     * 【M4-L】把会话选中的 provider 解析成 agent 可用的配置。
     *
     * 背景:用户自建的 provider 存在 **ModelManager**(设置 → 模型管理),
     * 而 agent 路径走 **LlmClient** —— 它只认 **LlmConfigStore**,
     * 且设置页**没有**后者的入口(`/settings/llm-config` 是孤岛路由)。
     * 两张表不同步 → agent 每次都拿不到 provider →
     * "no LLM provider configured" → 回落旧管道(每条消息先失败一次)。
     *
     * 这里按**会话**把用户选中的那个 provider 翻译成内联配置带下去,
     * 不写全局表(全局表按类型索引,同类型的多个用户 provider 会互相覆盖)。
     */
    const providerId = conv?.providerId ?? undefined;
    const modelId = conv?.modelId ?? undefined;
    const mp = providerId ? this.modelManager.getProvider(providerId) : undefined;
    const inlineProvider = mp ? toLlmProviderConfig(mp) : undefined;

    // 记忆上下文:管线召回(无 embedding 配置时 HermesAdapter 返空数组,此处不阻塞主链路)
    let memoryContext = '';
    try {
      const recalled = await HermesAdapter.getInstance().recall(content, { minScore: RECALL_CHAT_MIN_SCORE });
      if (Array.isArray(recalled) && recalled.length > 0) {
        memoryContext = recalled
          .slice(0, 5)
          .map(m => `- ${typeof m?.content === 'string' ? m.content : JSON.stringify(m)}`)
          .join('\n');
      }
    } catch (e) {
      this.log.warn('[ChatManager] dispatchToAgent: 记忆召回失败,降级为空上下文');
    }

    // 执行过程占位消息 + 事件订阅(tool_call / tool_result 实时广播)
    const placeholderId = `assistant_agent_${Date.now()}`;
    const placeholder: ChatMessage = {
      id: placeholderId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      status: 'streaming',
    };
    this.config.addMessage(conversationId, placeholder);
    this.broadcastMessage(conversationId, placeholder);

    const traceId = `agent_${Date.now()}`;
    // 预先声明 runId 并绑定会话归属 —— brain 无状态(不持有 conversationId),
    // 事件归属由会话层在中继表登记,这是让 tool_call 可被渲染层消费的前提。
    const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.agentEventRelay.bindRun(runId, conversationId);
    const unsubscribe = this.agentEventRelay.subscribe((ev) => {
      if (ev.conversationId !== conversationId) return;
      this.broadcastAgentEvent(conversationId, ev);
    });

    try {
      const decision = await this.registeredAgent.think({
        runId,
        conversationId,
        content,
        contextKind,
        history: history.map(m => ({ role: m.role, content: m.content })),
        ...(memoryContext ? { memoryContext } : {}),
        // 【M4-L】把会话选中的 provider / model 带进 agent
        ...(inlineProvider ? { provider: inlineProvider.provider, config: inlineProvider } : {}),
        ...(modelId ? { model: modelId } : {}),
        // 【M4-E】配对对照:禁用的技能随 ctx 下传,由 load_skill 工具层拒绝
        ...(suppressedSkills.length > 0 ? { suppressedSkills } : {}),
      } as never);

      const payload = (decision?.payload ?? {}) as {
        text?: string
        totalTokens?: number
        iterations?: number
        runId?: string
        toolCalls?: Array<{ name: string; ok: boolean; durationMs: number; entity?: { kind: string; id: string } }>
        /** 【M4-D】本次 run 实际应用过的技能 id */
        appliedSkills?: string[]
        /** 【M3-E】真实使用的 LLM 模型名(成本按它归集) */
        llmModel?: string
        /** 【M3-E】分项 token —— 此前只取 total,输入/输出混在一栏 */
        promptTokens?: number
        completionTokens?: number
        /** 【M4-H】来自兜底占位实现(未接入真实模型) */
        stub?: boolean
      };
      const text = payload.text ?? '';
      const totalTokens = payload.totalTokens ?? 0;
      const toolCalls = payload.toolCalls ?? [];

      /**
       * token 记账 —— run() 已吐出,此前在此处断链丢失。
       *
       * 【M3-E 修正两处记账失真】
       * ① model 此前恒为字面量 `'agent-loop'` —— 成本按**一个假模型名**归集,
       *    于是"哪个模型花了多少钱"根本查不出来(全部混在一栏)。
       *    现用载荷里的**真实模型名**(`llmModel`),取不到才回落。
       * ② inputTokens 此前塞的是 **totalTokens**,outputTokens 恒为 0 ——
       *    输入输出混在一栏,无法区分"提示词长"还是"回答长"。
       *    适配器本来就回传 promptTokens/completionTokens,此前被 brain 丢掉了,
       *    现已一路带上来。
       */
      if (totalTokens > 0) {
        try {
          const promptTokens = payload.promptTokens ?? 0;
          const completionTokens = payload.completionTokens ?? 0;
          // 分项缺失时(老 provider 不回传)按 total 兜底,不记成 0
          const inputTokens = promptTokens > 0 ? promptTokens : totalTokens;
          const outputTokens = completionTokens;
          CostTracker.getInstance().recordUsage({
            model: payload.llmModel || 'agent-loop',
            inputTokens,
            outputTokens,
            conversationId,
          });
        } catch (e) {
          this.log.warn('[ChatManager] dispatchToAgent: token 记账失败', e);
        }
      }

      /**
       * 【M4-H】占位回复要**在消息上留痕**,不能只靠正文里的一句话。
       *
       * 兜底实现的正文已经写明「未接入真实模型」,但如果它混在正常答复里,
       * 用户扫一眼很容易当成正常答复划过去。消息状态标成 'stub',
       * 让「这条是占位答复」成为**结构化事实**而不只是一段文字。
       */
      const msgStatus: MessageStatus = payload.stub === true ? 'stub' : 'sent';
      this.config.updateMessage(conversationId, placeholderId, { content: text, status: msgStatus });
      this.broadcastMessage(conversationId, { ...placeholder, content: text, status: msgStatus });

      this.log.info(
        `[ChatManager] [${traceId}] agent loop 完成: ${payload.iterations ?? 0} 轮, ` +
        `${toolCalls.length} 次工具调用, ${totalTokens} tokens`,
      );

      return {
        handled: true,
        content: text,
        messageId: placeholderId,
        runId: payload.runId,
        totalTokens,
        iterations: payload.iterations ?? 0,
        toolCalls,
        appliedSkills: payload.appliedSkills ?? [],
      };
    } catch (e) {
      this.log.error('[ChatManager] dispatchToAgent 失败,交由调用方回落', e);
      try {
        this.config.updateMessage(conversationId, placeholderId, {
          content: `agent 执行失败:${(e as Error).message}`,
          status: 'error',
        });
      } catch { /* 回落消息失败不二次抛 */ }
      return { handled: false, reason: (e as Error).message };
    } finally {
      unsubscribe();
      this.agentEventRelay.releaseRun(runId);
    }
  }

  /** 把 agent 运行事件广播到渲染层(供工具调用可视化消费) */
  private broadcastAgentEvent(conversationId: string, event: AgentRunEvent): void {
    const windows = BrowserWindow.getAllWindows();
    windows.forEach(w => {
      if (!w.isDestroyed()) {
        w.webContents.send('agent:onEvent', { conversationId, event });
      }
    });
  }

  /**
   * 【M4-E】跑一次技能效用对照实验的**单个变体**。
   *
   * 【为什么在主进程做】
   * 对照实验要真跑 agent(带/不带技能各一遍),而 agent 只在主进程里。
   * 渲染层只负责发起与展示。
   *
   * 【变体如何生效】
   * `suppressedSkills` 随 AgentContext 下传到工具层,`load_skill` 会拒绝该技能 ——
   * 这是「不带技能」变体唯一靠得住的做法:光把技能从提示词里摘掉不够,
   * 模型仍可能凭记忆用同样的做法。
   */
  private async runTrialVariant(
    conversationId: string,
    instruction: string,
    suppressedSkills: string[],
  ): Promise<GradableRun> {
    const content = instruction;
    this.config.addMessage(conversationId, {
      id: `user_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      role: 'user',
      content,
      timestamp: Date.now(),
      status: 'sent',
    });

    const result = await this.dispatchToAgent(conversationId, content, 'ui', suppressedSkills);
    const toolCalls = result.toolCalls ?? [];
    return {
      instruction,
      answer: result.content,
      toolsUsed: toolCalls.map(c => c.name),
      hadToolFailure: toolCalls.some(c => !c.ok),
      hadError: !result.handled,
      producedAnswer: !!result.content && result.content.length > 0,
    };
  }

  /**
   * 【M4-E】跑一次技能效用对照实验。
   *
   * 【成本提示】每个任务跑两遍 → token 翻倍。界面必须先告知用户。
   */
  public async runSkillUtilityTrial(
    skillId: string,
    tasks: TrialTask[],
  ): Promise<TrialResult> {
    const conversationId = this.config.createConversation({ title: `技能验证:${skillId}` }).id;
    const executor: TrialExecutor = async (task, opts) =>
      this.runTrialVariant(conversationId, task.instruction, opts.suppressedSkills);
    return await runSkillTrial(skillId, tasks, executor);
  }

  /**
   * 【M4-B】记录 agent loop 的一次执行:轨迹观察 + 效果反馈。
   *
   * 调研依据:「按整条轨迹评分,而非只看最终答案」——
   * 经由失败的工具调用得到的正确答案,是潜伏的生产事故。
   * 因此这里同时记录:
   *   - 轨迹(工具调用序列 + 每步成败)
   *   - 最终结果
   *   - 失败诊断(首个失败步骤 + 分类)
   * 并把每次工具调用写进 SkillEffectivenessTracker —— 它此前零调用方,
   * 意味着"技能被调用后效果如何"这个闭环信号从未被采集。
   */
  /**
   * 【M4-D】任务类别归一 —— 与 SelfLearner 共用同一实现(TaskCategory.ts)。
   * 两边规则必须一致,否则对比组会漏记录。
   */
  private normalizeTaskCategory(instruction: string): string {
    return normalizeTaskCategory(instruction);
  }

  private recordAgentOutcome(
    conversationId: string,
    instruction: string,
    result: AgentDispatchResult,
  ): void {
    const toolCalls = result.toolCalls ?? [];
    const failed = toolCalls.find(c => !c.ok);
    const outcome: 'ok' | 'fail' | 'partial' = failed
      ? (toolCalls.some(c => c.ok) ? 'partial' : 'fail')
      : 'ok';

    try {
      // ① 轨迹观察
      const failure = failed
        ? {
            stepIndex: toolCalls.indexOf(failed),
            ...classifyFailure(failed.name),
          }
        : undefined;

      SelfLearner.getInstance().observeExecution(
        instruction,
        toolCalls.map(c => ({ name: c.name, ok: c.ok, durationMs: c.durationMs })),
        outcome,
        {
          trajectoryId: result.runId,
          toolsUsed: toolCalls.map(c => c.name),
          source: 'agent_loop',
          ...(failure ? { failure } : {}),
        },
      );

      // ② 效果反馈:每个工具调用一条记录 → tracker 才有数据可统计
      //    unitType='tool' —— 这是【工具级】信号,不是技能级效用。
      const tracker = SkillEffectivenessTracker.getInstance();
      for (const c of toolCalls) {
        tracker.record({
          skillName: c.name,
          unitType: 'tool',
          ts: Date.now(),
          durationMs: c.durationMs,
          success: c.ok,
          conversationId,
        });
      }

      /**
       * 【M4-D】③ 技能级效用信号 —— 「技能 S 被应用了,这次运行成功没」。
       *
       * 这是"这个技能到底有没有用"这个问题能被回答的**前提**:
       * 没有"哪些技能被应用"的记录,就只剩"工具调用的成败",无从谈技能的效用。
       *
       * 【category 是关键】记下归一化后的任务类别,才能做
       * 「同类别任务下:带该技能 vs 不带该技能」的对比 ——
       * 只看绝对成功率会把"任务本身难"误判成"技能没用"。
       */
      const appliedSkills = result.appliedSkills ?? [];
      if (appliedSkills.length > 0) {
        const category = this.normalizeTaskCategory(instruction);
        for (const skillId of appliedSkills) {
          tracker.record({
            skillName: skillId,
            unitType: 'skill',
            ts: Date.now(),
            durationMs: 0,
            success: outcome === 'ok',
            conversationId,
            category,
          });
        }
      }
    } catch (e) {
      // 记录失败不得影响主流程
      this.log.warn('[ChatManager] recordAgentOutcome 失败(不阻塞)', e);
    }
  }

  /** 广播任务单步状态(让执行过程实时可见) */
  private broadcastTaskStep(conversationId: string, payload: { planId: string; order: number; status: string; description?: string; error?: string }): void {
    const windows = BrowserWindow.getAllWindows();
    windows.forEach(w => {
      if (!w.isDestroyed()) {
        w.webContents.send('chat:onTaskStep', { conversationId, ...payload });
      }
    });
  }

  /** 广播执行计划(渲染层据此弹确认框) */
  private broadcastTaskPlan(conversationId: string, plan: unknown): void {
    const windows = BrowserWindow.getAllWindows();
    windows.forEach(w => {
      if (!w.isDestroyed()) {
        w.webContents.send('chat:onTaskPlan', plan);
      }
    });
  }

  /**
   * 请求用户确认执行计划。
   *
   * fail-safe 设计:
   *   - 无任何渲染窗口(定时任务/IM 入口) → 拒绝(不盲执行)
   *   - 用户 60s 未响应 → 拒绝(不是默认同意)
   *   - 执行模式非 plan → 立即放行(调用方已判定)
   *
   * 拒绝默认值必须是 false:安全边界上,"不知道"不等于"可以"。
   */
  private async requestPlanConfirmation(
    conversationId: string,
    instruction: string,
    steps: Array<{ order: number; description: string; status: string; params: Record<string, unknown> }>,
    timeoutMs = 60_000,
  ): Promise<boolean> {
    const windows = BrowserWindow.getAllWindows().filter(w => !w.isDestroyed());
    if (windows.length === 0) {
      this.log.warn('[ChatManager] 无渲染窗口,拒绝执行(plan 模式 fail-safe)');
      return false;
    }

    const planId = `plan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.broadcastTaskPlan(conversationId, {
      conversationId,
      planId,
      instruction,
      steps,
      riskLevel: steps.length > 5 ? 'high' : steps.length > 2 ? 'medium' : 'low',
      createdAt: Date.now(),
    });

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.confirmHandlers.delete(planId);
        resolve(ok);
      };
      const timer = setTimeout(() => {
        this.log.warn(`[ChatManager] 计划 ${planId} 等待确认超时,拒绝执行`);
        finish(false);
      }, timeoutMs);
      this.confirmHandlers.set(planId, finish);
    });
  }

  /**
   * 渲染层确认回调入口(IpcServer 转发 chat:task:confirm)。
   * 未知 planId 一律拒绝 —— 不给"误确认"留口子。
   */
  public resolveTaskConfirmation(planId: string, confirmed: boolean): boolean {
    const handler = this.confirmHandlers.get(planId);
    if (!handler) {
      this.log.warn(`[ChatManager] resolveTaskConfirmation: 未知 planId ${planId},拒绝`);
      return false;
    }
    handler(confirmed);
    return true;
  }

  /**
   * 【M1-E】是否走 agent tool loop。
   * 判定链(任一为否即回落旧管道):
   *   1. 已注册 agent
   *   2. 存在任一已启用且带 apiKey 的 LLM provider(否则 LlmClient 无从调用)
   *   3. 执行模式 ≠ 'safe'(safe = 纯对话,拦截所有执行类指令)
   *
   * 【M1-E 安全修正】原默认值是 'craft'(权限内自动执行),用户在 UI 上完全看不到,
   *   等于"静默执行"。现默认改为 'plan' —— agent 仍会执行,但经确认门;
   *   'safe' 才是纯对话。理由见 docs/deviation-ledger.md。
   */
  private shouldUseAgentLoop(): boolean {
    if (!this.registeredAgent) return false;
    try {
      const mode = this.getExecutionMode();
      if (mode === 'safe') return false;
    } catch (e) {
      this.log.warn('[ChatManager] shouldUseAgentLoop: 执行模式读取失败,按 plan 处理');
    }
    try {
      const providers = this.modelManager.getAllProviders?.() ?? [];
      const hasReady = providers.some((p: { enabled?: boolean; apiKey?: string }) => p.enabled !== false && !!p.apiKey);
      if (!hasReady) {
        this.log.debug('[ChatManager] shouldUseAgentLoop: 无可用 LLM provider,回落旧管道');
        return false;
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  /** 读取执行模式(渲染层 executionMode store 为真源,此处读同一份持久化配置) */
  public getExecutionMode(): 'safe' | 'plan' | 'craft' {
    try {
      const store = ConfigStore.getInstance();
      // 键名与 IpcServer.ts:1100 的 execution:mode:set 保持一致
      const raw = store.get('execution.mode') as string | undefined;
      if (raw === 'safe' || raw === 'plan' || raw === 'craft') return raw;
    } catch { /* 配置不可用则用默认值 */ }
    return 'craft'; // 【M1-E】默认保持 craft;UI 常驻可见,用户知情
  }

  /**
   * 订阅流式 chunk(由渲染进程通过 IPC 订阅)
   * 返回 Disposable 用于取消订阅
   */
  public subscribeStream(handler: (chunk: StreamChunk) => void): Disposable {
    this.streamHandlers.add(handler);
    return {
      dispose: () => {
        this.streamHandlers.delete(handler);
      },
    };
  }

  /** W4.6 内部:产生一个 stream chunk 并通知所有订阅者(供 Chat 流使用) */
  public _emitStreamChunk(chunk: Omit<StreamChunk, 'seq' | 'timestamp'>): void {
    this.streamSeq += 1;
    const fullChunk: StreamChunk = { ...chunk, seq: this.streamSeq, timestamp: Date.now() };
    for (const h of Array.from(this.streamHandlers)) {
      try {
        h(fullChunk);
      } catch (e) {
        this.log.error('[ChatManager] stream handler error', e);
      }
    }
  }
}