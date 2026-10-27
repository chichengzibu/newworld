
/**
 * PiPiClaw - Hermes 自我学习引擎（重构版）
 * 
 * 职责：
 * 1. 观察用户的操作并收集到观察列表
 * 2. 达到阈值时调用大模型分析行为模式
 * 3. 生成泛化的技能提案（语义理解→抽象模式→创建技能）
 * 4. 实现语义匹配的技能触发机制
 *
 * ── #006 X1 反向注释 (与 MemoryVectorStore 正反向一致) ─────────
 * 本类 = 执行行为层 (observations.json, "用户做了什么")。
 * 与 electron/hermes/ 的文本记忆层 (hermes.memories + vector-cache.json,
 * "用户要什么语义") 语义正交 — 两套体系不合并, 各自独立持久化。
 * 详见: electron/hermes/MemoryVectorStore.ts 顶部 X1 正向注释
 *       docs/#006-memory-persistence-design.md § B.5
 * 若未来需要跨层桥接 (如"从执行观察提炼语义偏好"), 应显式通过
 * HermesMemory.addExperienceMemory 入口, 而非本类直接写向量层。
 */

import * as fs from 'fs';
import { getHost } from '../platform/runtime'
import * as path from 'path';
import https from 'https';
import http from 'http';
import { URL } from 'url';
import {BrowserWindow} from 'electron';
import { LogManager } from '../core/LogManager';
import { ConfigStore } from '../core/ConfigStore';
import { SkillLoader } from '../skill/SkillLoader';
import { SkillManager } from '../skill/SkillManager';
import { ModelManager } from '../models/ModelManager';

/**
 * 观察记录
 */
/**
 * 【M4-B】观察条目 —— 升级为「轨迹」型。
 *
 * 【依据:业界调研】
 * - 「按【整条轨迹】评分,而不是只看最终答案」——
 *   "a correct answer reached through a broken tool call is a latent
 *   production incident"(经由损坏的工具调用得到的正确答案,是潜伏的生产事故)
 * - 「捕获轨迹级状态」:trajectory_id / policy_version / final_reward /
 *   steps / failure:{step,type} / checkpoint_rewards
 * - 「保留失败」——把事故转成评测用例,而不是让它们消失
 *
 * 原实现只有 {instruction, steps, timestamp},且 steps 是未类型化的裸数组,
 * 成败信息(_result)传进来就被丢弃(参数名带下划线 = 故意不用)。
 * 后果:分析器拿不到"这次成功了没有、哪一步失败",只能从文本猜。
 */
interface Observation {
  id: string;
  instruction: string;
  steps: any[];
  timestamp: number;

  /** 【M4-B】轨迹 id —— 同一次执行的多次观察可归并 */
  trajectoryId?: string;
  /**
   * 【M4-B】最终结果 —— 'ok' | 'fail' | 'partial'。
   * 此前 _result 参数被丢弃,成败信息完全丢失。
   */
  outcome?: 'ok' | 'fail' | 'partial';
  /**
   * 【M4-B】同一条指令被观察到的次数。
   *
   * 【关键语义修正】原实现检测到重复指令就【丢弃】—— 但"重复"恰恰是
   * 最该学的信号(用户反复做同一件事 = 一个值得固化的技能)。
   * 调研结论:「重复的操作模式」正是学习的目标;
   * 丢重复 = 把要学的东西扔了。现改为计数。
   */
  occurrences?: number;
  /**
   * 【M4-B】失败诊断 —— {stepIndex, type, message}
   * 调研:「失败模式分类 + 触发条件」是诊断反馈的必需项。
   */
  failure?: { stepIndex?: number; type: string; message?: string };
  /** 【M4-B】本次执行用到的工具(用于"哪类任务用哪类工具"的分析) */
  toolsUsed?: string[];
  /** 【M4-B】是否走的是 agent tool loop(与旧 TaskExecutor 管道区分) */
  source?: 'agent_loop' | 'task_executor' | 'chat';
}

/**
 * 技能提案（包含语义触发条件）
 */
export interface SkillProposal {
  id: string;
  name: string;
  description: string;
  triggerCondition: string; // 语义描述的触发条件
  keywords: string[];
  operationSteps: string[];
  fullInstructions: string;
  createdAt: number;
}

/**
 * 模型返回的技能分析结果
 */
interface SkillAnalysisResult {
  name: string;
  description: string;
  triggerCondition: string;
  keywords: string[];
}

export class SelfLearner {
  private static instance: SelfLearner;
  private log = LogManager.getInstance();
  private configStore = ConfigStore.getInstance();
  private skillLoader = SkillLoader.getInstance();
  private modelManager = ModelManager.getInstance();
  private learningDir: string;
  private observations: Observation[] = [];
  private pendingProposal: SkillProposal | null = null;
  private analysisInProgress = false;

  /**
   * #007 W2: 分析阈值 (订单既定 3→10, 可配置类常量, 实例可覆盖)
   * — 非模块态 let, 红线: 模块态零新增
   * 联动 G1: analyzeAndGenerateSkill 内 slice(-ANALYSIS_THRESHOLD) 与本阈值同参
   */
  public ANALYSIS_THRESHOLD: number = 10;

  /**
   * #007 W1: 观察窗口 (订单既定 10→100, 观察数据是 LLM 分析输入池, 不主动清 — H1 观察保留钉)
   */
  private OBSERVATION_WINDOW: number = 100;

  private constructor() {
    // 初始化学习数据目录
    this.learningDir = path.join(getHost().getPath('userData'), 'hermes-learning');
    this.ensureLearningDir();
    this.loadObservations();
  }

  public static getInstance(): SelfLearner {
    if (!SelfLearner.instance) {
      SelfLearner.instance = new SelfLearner();
    }
    return SelfLearner.instance;
  }

  private ensureLearningDir(): void {
    if (!fs.existsSync(this.learningDir)) {
      fs.mkdirSync(this.learningDir, { recursive: true });
      this.log.info('[SelfLearner] 创建学习数据目录', { path: this.learningDir });
    }
  }

  private loadObservations(): void {
    try {
      const observationsPath = path.join(this.learningDir, 'observations.json');
      if (fs.existsSync(observationsPath)) {
        const data = JSON.parse(fs.readFileSync(observationsPath, 'utf-8'));
        this.observations = data;
        this.log.info('[SelfLearner] 加载观察记录成功', { count: this.observations.length });
      }
    } catch (error) {
      this.log.error('[SelfLearner] 加载观察记录失败', error);
    }
  }

  private saveObservations(): void {
    try {
      const observationsPath = path.join(this.learningDir, 'observations.json');
      fs.writeFileSync(observationsPath, JSON.stringify(this.observations, null, 2), 'utf-8');
    } catch (error) {
      this.log.error('[SelfLearner] 保存观察记录失败', error);
    }
  }

  /**
   * 【M4-B】观察一次执行 —— 轨迹型。
   *
   * 【两处语义修正】
   * 1. **重复不再被丢弃,改为计数。**
   *    原实现:检测到重复指令就 return,一条指令重复 20 次 = 1 条观察。
   *    但"重复"恰恰是最该学的信号 —— 用户反复做同一件事,说明它值得
   *    固化成技能。丢掉重复 = 把要学的东西扔了。现改为 occurrences 计数,
   *    并在分析时把高频指令作为模式候选。
   * 2. **结果不再被丢弃。**
   *    原实现的第三个参数 `_result`(下划线前缀 = 故意不用)导致成败信息
   *    完全丢失,分析器只能从文本猜。现在 outcome / failure 被记录。
   *
   * @param instruction 用户指令原文
   * @param steps       执行步骤(工具调用序列)
   * @param result      执行结果 —— 'ok' | 'fail' | 'partial' 或步骤数组
   * @param meta        轨迹元信息(trajectoryId / toolsUsed / source / failure)
   */
  public observeExecution(
    instruction: string,
    steps: any[],
    result?: any,
    meta?: {
      trajectoryId?: string
      toolsUsed?: string[]
      source?: 'agent_loop' | 'task_executor' | 'chat'
      outcome?: 'ok' | 'fail' | 'partial'
      failure?: { stepIndex?: number; type: string; message?: string }
    },
  ): void {
    try {
      // 归一化后匹配同一条指令
      const normalizedInstruction = this.normalizeInstruction(instruction);
      const existing = this.observations.find(obs =>
        this.normalizeInstruction(obs.instruction) === normalizedInstruction,
      );

      // 【M4-B 修正 1】重复 → 计数 + 刷新结果,而不是丢弃
      if (existing) {
        existing.occurrences = (existing.occurrences ?? 1) + 1;
        existing.timestamp = Date.now();
        // 【M4-B 修正 2】刷新结果时【result 也要参与判定】——
        // 否则首次是 fail、二次是 ok 时,outcome 仍停在 fail,
        // 语义变成"第一次的结果说了算",与"最新一次执行说了算"矛盾。
        const latestOutcome = meta?.outcome ?? this.normalizeOutcome(result);
        if (latestOutcome) existing.outcome = latestOutcome;
        if (meta?.failure) existing.failure = meta.failure;
        if (meta?.toolsUsed) existing.toolsUsed = Array.from(new Set([...(existing.toolsUsed ?? []), ...meta.toolsUsed]));
        this.saveObservations();
        this.log.info('[SelfLearner] 重复指令 → 计数', {
          instruction,
          occurrences: existing.occurrences,
        });
        return;
      }

      // 结果归一:可能是字符串、布尔、或带 success 字段的对象
      const outcome = this.normalizeOutcome(result);

      const observation: Observation = {
        id: `obs_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        instruction,
        steps,
        timestamp: Date.now(),
        occurrences: 1,
        outcome: meta?.outcome ?? outcome,
        ...(meta?.trajectoryId ? { trajectoryId: meta.trajectoryId } : {}),
        ...(meta?.toolsUsed ? { toolsUsed: meta.toolsUsed } : {}),
        ...(meta?.source ? { source: meta.source } : {}),
        ...(meta?.failure ? { failure: meta.failure } : {}),
      };

      // #007 W1: 窗口 10→100 (订单既定; 观察数据 = LLM 分析输入池, H1 保留钉 — 不主动清)
      this.observations.push(observation);
      if (this.observations.length > this.OBSERVATION_WINDOW) {
        this.observations.shift();
      }

      this.saveObservations();

      this.log.info('[SelfLearner] 观察到执行', {
        instruction,
        observationCount: this.observations.length,
        outcome,
        tools: meta?.toolsUsed?.length ?? 0,
      });

      // #007 W2: 阈值 3→10 (类常量, 实例可覆盖; G1 联动 = slice(-ANALYSIS_THRESHOLD) 同参)
      if (this.observations.length >= this.ANALYSIS_THRESHOLD && !this.analysisInProgress) {
        this.analyzeAndGenerateSkill();
      }

    } catch (error) {
      this.log.error('[SelfLearner] 观察执行失败', error);
    }
  }

  /** 把各种形态的执行结果归一成 'ok' | 'fail' | 'partial' */
  private normalizeOutcome(result: any): 'ok' | 'fail' | 'partial' | undefined {
    if (result === undefined || result === null) return undefined;
    if (typeof result === 'string') {
      const s = result.toLowerCase();
      if (s === 'ok' || s === 'success' || s === 'true') return 'ok';
      if (s === 'fail' || s === 'failed' || s === 'error' || s === 'false') return 'fail';
      return 'partial';
    }
    if (typeof result === 'boolean') return result ? 'ok' : 'fail';
    if (typeof result === 'object') {
      if (typeof result.success === 'boolean') return result.success ? 'ok' : 'fail';
      if (typeof result.ok === 'boolean') return result.ok ? 'ok' : 'fail';
      if (Array.isArray(result.steps)) {
        const steps = result.steps as Array<{ status?: string; ok?: boolean }>;
        const failed = steps.filter(s => s.status === 'failed' || s.ok === false).length;
        if (failed === 0) return 'ok';
        if (failed < steps.length) return 'partial';
        return 'fail';
      }
    }
    return undefined;
  }

  /**
   * 标准化指令（忽略大小写和标点符号，保留语义差异）
   */
  private normalizeInstruction(instruction: string): string {
    // 去除标点符号，但保留一些语义相关的
    return instruction.toLowerCase()
      // 去除句号、感叹号、问号、逗号等
      .replace(/[.!,?;:'"()]/g, '')
      // 统一空白字符
      .replace(/\s+/g, ' ')
      // 去除首尾空格
      .trim();
  }

  /**
   * 分析观察数据并生成技能（大模型驱动）
   */
  private async analyzeAndGenerateSkill(): Promise<void> {
    if (this.analysisInProgress) {
      return;
    }

    this.analysisInProgress = true;

    try {
      this.log.info('[SelfLearner] 开始分析用户行为模式');

      // #007 G1: 分析输入 = 最近 ANALYSIS_THRESHOLD 条 (联动 W2 阈值, 非硬编码 3)
      const recentObservations = this.observations.slice(-this.ANALYSIS_THRESHOLD);

      // 构造提示词
      const prompt = this.buildAnalysisPrompt(recentObservations);

      // 调用大模型分析
      const analysisResult = await this.callModelForAnalysis(prompt);

      if (analysisResult) {
        // 生成技能提案
        const proposal = this.generateSkillProposalFromAnalysis(
          analysisResult, 
          recentObservations[recentObservations.length - 1]
        );

        if (proposal) {
          // 步骤1：检查是否与现有技能重复
          const isDuplicate = await this.checkDuplicateSkill(proposal);
          if (isDuplicate) {
            this.log.info('[SelfLearner] 检测到重复技能，放弃提案', { name: proposal.name });
            return;
          }

          this.pendingProposal = proposal;
          this.log.info('[SelfLearner] 技能提案生成成功', { 
            name: proposal.name,
            triggerCondition: proposal.triggerCondition
          });

          // 通过IPC事件推送到前端
          this.notifyFrontend(proposal);
        }
      }

    } catch (error) {
      this.log.error('[SelfLearner] 分析失败', error);
    } finally {
      this.analysisInProgress = false;
    }
  }

  /**
   * 构建分析提示词
   */
  private buildAnalysisPrompt(observations: Observation[]): string {
    let prompt = '你是专业的AI行为分析师。以下用户连续执行了3个操作：\n\n';

    observations.forEach((obs, index) => {
      prompt += `${index + 1}. ${obs.instruction}\n`;
    });

    prompt += '\n请分析：这些操作的共同模式是什么？背后的用户意图是什么？\n';
    prompt += '提炼出一个通用的技能，以JSON格式返回，字段：\n';
    prompt += '- name: 技能名称（简洁描述）\n';
    prompt += '- description: 详细描述\n';
    prompt += '- triggerCondition: 语义描述的触发条件（什么情况下用户会想使用这个技能）\n';
    prompt += '- keywords: 关键词数组（3-5个）\n';
    prompt += '\n只返回JSON，不要包含markdown代码块标记。';

    return prompt;
  }

  /**
   * 调用大模型进行分析
   */
  private async callModelForAnalysis(prompt: string): Promise<SkillAnalysisResult | null> {
    try {
      // 获取当前激活的模型提供商
      const enabledProviders = this.modelManager.getEnabledProviders();
      if (enabledProviders.length === 0) {
        this.log.warn('[SelfLearner] 没有启用的模型提供商');
        return null;
      }

      // 使用第一个启用的提供商
      const provider = enabledProviders[0];
      const modelId = provider.defaultModel || provider.models[0]?.id;

      if (!modelId) {
        this.log.warn('[SelfLearner] 没有可用的模型');
        return null;
      }

      this.log.info('[SelfLearner] 调用大模型分析行为模式', {
        provider: provider.name,
        model: modelId
      });

      // 调用大模型
      const response = await this.makeChatCompletionRequest(provider, modelId, prompt);

      if (response) {
        // 解析返回的JSON
        const analysisResult = this.parseModelResponse(response);
        return analysisResult;
      }

    } catch (error) {
      this.log.error('[SelfLearner] 调用大模型失败', error);
    }

    return null;
  }

  /**
   * 发起聊天补全请求
   */
  private async makeChatCompletionRequest(
    provider: any,
    modelId: string,
    prompt: string
  ): Promise<string | null> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Request timeout'));
      }, provider.timeout || 60000);

      let req: http.ClientRequest;

      try {
        switch (provider.type) {
          case 'openai':
          case 'deepseek':
          case 'custom': {
            // OpenAI兼容格式
            const url = new URL('/v1/chat/completions', provider.baseUrl);
            const protocol = url.protocol === 'https:' ? https : http;
            
            const headers: Record<string, string> = {
              'Content-Type': 'application/json'
            };
            if (provider.apiKey) {
              headers['Authorization'] = `Bearer ${provider.apiKey}`;
            }

            const body = JSON.stringify({
              model: modelId,
              messages: [{ role: 'user', content: prompt }],
              temperature: 0.3,
              max_tokens: 500
            });

            req = protocol.request(url, { method: 'POST', headers }, (res) => {
              let data = '';
              res.on('data', (chunk) => { data += chunk; });
              res.on('end', () => {
                clearTimeout(timeout);
                try {
                  const parsed = JSON.parse(data);
                  if (parsed.choices?.[0]?.message?.content) {
                    resolve(parsed.choices[0].message.content);
                  } else {
                    resolve(null);
                  }
                } catch {
                  resolve(null);
                }
              });
            });
            req.write(body);
            break;
          }

          case 'anthropic': {
            const url = new URL('/v1/messages', provider.baseUrl);
            const protocol = url.protocol === 'https:' ? https : http;
            
            const headers: Record<string, string> = {
              'Content-Type': 'application/json',
              'x-api-key': provider.apiKey || '',
              'anthropic-version': '2023-06-01',
              'anthropic-dangerous-direct-browser-access': 'true'
            };

            const body = JSON.stringify({
              model: modelId,
              max_tokens: 500,
              messages: [{ role: 'user', content: prompt }],
              temperature: 0.3
            });

            req = protocol.request(url, { method: 'POST', headers }, (res) => {
              let data = '';
              res.on('data', (chunk) => { data += chunk; });
              res.on('end', () => {
                clearTimeout(timeout);
                try {
                  const parsed = JSON.parse(data);
                  if (parsed.content?.[0]?.text) {
                    resolve(parsed.content[0].text);
                  } else {
                    resolve(null);
                  }
                } catch {
                  resolve(null);
                }
              });
            });
            req.write(body);
            break;
          }

          case 'azure': {
            const deploymentName = provider.deploymentName || modelId;
            const url = new URL(
              `/openai/deployments/${deploymentName}/chat/completions?api-version=${provider.apiVersion || '2024-02-01'}`,
              provider.baseUrl
            );
            const protocol = url.protocol === 'https:' ? https : http;
            
            const headers: Record<string, string> = {
              'Content-Type': 'application/json',
              'api-key': provider.apiKey || ''
            };

            const body = JSON.stringify({
              messages: [{ role: 'user', content: prompt }],
              temperature: 0.3,
              max_tokens: 500
            });

            req = protocol.request(url, { method: 'POST', headers }, (res) => {
              let data = '';
              res.on('data', (chunk) => { data += chunk; });
              res.on('end', () => {
                clearTimeout(timeout);
                try {
                  const parsed = JSON.parse(data);
                  if (parsed.choices?.[0]?.message?.content) {
                    resolve(parsed.choices[0].message.content);
                  } else {
                    resolve(null);
                  }
                } catch {
                  resolve(null);
                }
              });
            });
            req.write(body);
            break;
          }

          case 'ollama': {
            const url = new URL('/api/chat', provider.baseUrl);
            const protocol = url.protocol === 'https:' ? https : http;
            
            const headers: Record<string, string> = {
              'Content-Type': 'application/json'
            };

            const body = JSON.stringify({
              model: modelId,
              messages: [{ role: 'user', content: prompt }],
              stream: false,
              options: { temperature: 0.3, num_predict: 500 }
            });

            req = protocol.request(url, { method: 'POST', headers }, (res) => {
              let data = '';
              res.on('data', (chunk) => { data += chunk; });
              res.on('end', () => {
                clearTimeout(timeout);
                try {
                  const parsed = JSON.parse(data);
                  if (parsed.message?.content) {
                    resolve(parsed.message.content);
                  } else {
                    resolve(null);
                  }
                } catch {
                  resolve(null);
                }
              });
            });
            req.write(body);
            break;
          }

          default:
            clearTimeout(timeout);
            resolve(null);
            return;
        }

        req.on('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });

        req.end();

      } catch (error) {
        clearTimeout(timeout);
        reject(error);
      }
    });
  }

  /**
   * 解析模型返回的响应
   */
  private parseModelResponse(response: string): SkillAnalysisResult | null {
    try {
      // 尝试直接解析JSON
      let jsonStr = response.trim();
      
      // 如果有```包裹，提取里面的内容
      if (jsonStr.startsWith('```json') || jsonStr.startsWith('```')) {
        const startIdx = jsonStr.indexOf('{');
        const endIdx = jsonStr.lastIndexOf('}');
        if (startIdx !== -1 && endIdx !== -1) {
          jsonStr = jsonStr.substring(startIdx, endIdx + 1);
        }
      }

      const parsed = JSON.parse(jsonStr);
      
      return {
        name: parsed.name || '自动学习技能',
        description: parsed.description || '',
        triggerCondition: parsed.triggerCondition || '',
        keywords: Array.isArray(parsed.keywords) ? parsed.keywords : []
      };

    } catch (error) {
      this.log.error('[SelfLearner] 解析模型响应失败', error);
      return null;
    }
  }

  /**
   * 从分析结果生成技能提案
   */
  private generateSkillProposalFromAnalysis(
    analysisResult: SkillAnalysisResult,
    lastObservation: Observation
  ): SkillProposal | null {
    try {
      const skillId = `auto_${Date.now()}`;
      
      // 从最后一次观察中提取操作步骤
      const operationSteps = this.extractOperationSteps(lastObservation.steps);
      
      // 生成完整的技能文档
      const fullInstructions = this.generateFullSkillInstructions(
        analysisResult,
        lastObservation.instruction,
        operationSteps
      );

      const proposal: SkillProposal = {
        id: skillId,
        name: analysisResult.name,
        description: analysisResult.description,
        triggerCondition: analysisResult.triggerCondition,
        keywords: analysisResult.keywords,
        operationSteps,
        fullInstructions,
        createdAt: Date.now()
      };

      return proposal;

    } catch (error) {
      this.log.error('[SelfLearner] 生成技能提案失败', error);
      return null;
    }
  }

  /**
   * 从执行步骤中提取描述
   */
  private extractOperationSteps(steps: any[]): string[] {
    return steps.map(step => step.description || `执行 ${step.type}`);
  }

  /**
   * 生成完整的技能文档
   */
  /**
   * 生成 skill.md 全文。
   *
   * 【M4-A 修正 —— 格式对齐 Anthropic Agent Skills 规范】
   * 原实现用纯中文小节(`# 名称` / `## 描述` / `## 触发条件` / `## 关键词` /
   * `## 操作步骤` / `## 示例`)。而本项目自己的解析器 parseSkillMd 有三个误判:
   *   1. `## 触发条件` 与 `## 触发关键词` 落进同一分支 → 整句触发条件被当成一个"关键词"
   *   2. `## 示例` 不匹配任何分支 → 示例指令被当成一条操作步骤
   *   3. `## 关键词` 侥幸落在 keywords,但语义已错位
   * 这意味着"生成 → 加载"链路从未被端到端跑通过 —— 生成器与解析器互不兼容。
   *
   * 现改为 frontmatter 格式(Anthropic 规范 + 本项目解析器都认):
   *   frontmatter: name / description / when_to_use
   *   body: 关键词、操作步骤、示例、陷阱
   * 这样生成器与解析器用同一套语义,链路真正闭合。
   */
  private generateFullSkillInstructions(
    analysisResult: SkillAnalysisResult,
    example: string,
    steps: string[]
  ): string {
    const escape = (v: string): string => String(v ?? '').replace(/\r?\n/g, ' ').trim();
    let instructions = '---\n';
    instructions += `name: ${escape(analysisResult.name)}\n`;
    instructions += `description: ${escape(analysisResult.description)}\n`;
    // when_to_use 是规范里的路由信号 —— 模型的匹配依据
    instructions += `when_to_use: ${escape(analysisResult.triggerCondition)}\n`;
    instructions += '---\n\n';
    instructions += `## 关键词\n`;
    analysisResult.keywords.forEach(keyword => {
      instructions += `- ${keyword}\n`;
    });
    instructions += '\n## 操作步骤\n';
    steps.forEach((step, index) => {
      instructions += `${index + 1}. ${step}\n`;
    });
    instructions += `\n## 示例\n${example}\n`;

    return instructions;
  }

  /**
   * 通知前端有新的技能提案
   */
  private notifyFrontend(proposal: SkillProposal): void {
    try {
      // 获取所有窗口并发送事件
      const windows = BrowserWindow.getAllWindows();
      windows.forEach(window => {
        if (!window.isDestroyed()) {
          window.webContents.send('skills:new-proposal', proposal);
        }
      });
      this.log.info('[SelfLearner] 已通知前端技能提案');
    } catch (error) {
      this.log.error('[SelfLearner] 通知前端失败', error);
    }
  }

  /**
   * 语义匹配检查（判断新指令是否触发已保存技能）
   */
  public async checkSkillMatch(
    userInstruction: string,
    skillName: string,
    triggerCondition: string
  ): Promise<boolean> {
    try {
      // 获取激活的模型
      const enabledProviders = this.modelManager.getEnabledProviders();
      if (enabledProviders.length === 0) {
        return false;
      }

      const provider = enabledProviders[0];
      const modelId = provider.defaultModel || provider.models[0]?.id;

      if (!modelId) {
        return false;
      }

      // 构建判断提示词
      const prompt = `当前用户指令：${userInstruction}\n\n已保存技能"${skillName}"的触发条件：${triggerCondition}\n\n请问：当前用户指令是否符合该技能的触发条件？只回答"是"或"否"。`;

      // 调用大模型判断
      const response = await this.makeChatCompletionRequest(provider, modelId, prompt);

      if (response) {
        const normalized = response.toLowerCase().trim();
        return normalized.includes('是') || normalized.includes('yes');
      }

    } catch (error) {
      this.log.error('[SelfLearner] 语义匹配失败', error);
    }

    return false;
  }

  /**
   * 【M4-A】批量技能排序 —— 单次 LLM 调用返回相关技能 id 列表。
   *
   * 【为什么加这个】
   * 旧的 checkSkillMatch 是"一个技能一次 LLM 调用"。N 个技能 = N 次往返,
   * 技能一多(比如 20 个)每次规划都要等 20 个网络往返,而结果只是拿到
   * 一堆 true/false。批量一次调用把成本降到 1/N,且能得到【排序】而非
   * 二元判断 —— 旧实现取前 3 个时,顺序其实是遍历顺序,不是相关度顺序。
   *
   * 依据 Anthropic Agent Skills 的渐进披露:匹配决策本就该交给模型
   * (它比关键词更懂用户意图),我们只需给它一张技能清单和用户输入。
   *
   * @param userInstruction 用户当前输入
   * @param skillList 形如 "- id: 描述 (适用:...)" 的清单行
   * @returns 按相关度降序的技能 id 数组(解析失败返回空数组)
   */
  public async rankSkillsByRelevance(
    userInstruction: string,
    skillList: string,
  ): Promise<string[]> {
    try {
      const enabledProviders = this.modelManager.getEnabledProviders();
      if (enabledProviders.length === 0) return [];

      const provider = enabledProviders[0];
      const modelId = provider.defaultModel || provider.models[0]?.id;
      if (!modelId) return [];

      const prompt = `用户当前指令：${userInstruction}

可用技能清单：
${skillList}

请判断哪些技能与该指令相关,并按相关度从高到低排列。
只输出技能 id,每行一个,最多 5 个,不要输出任何其他文字。
若都不相关,输出 NONE。`;

      const response = await this.makeChatCompletionRequest(provider, modelId, prompt);
      if (!response) return [];

      return response
        .split('\n')
        .map(l => l.trim().replace(/^[-*\d.\s]+/, '').replace(/^['"]|['"]$/g, '').trim())
        .filter(l => l && l.toUpperCase() !== 'NONE')
        .slice(0, 5)
    } catch (error) {
      this.log.warn('[SelfLearner] 批量技能排序失败', error);
      return []
    }
  }

  /**
   * 检查新提案是否与现有技能重复
   */
  private async checkDuplicateSkill(proposal: SkillProposal): Promise<boolean> {
    try {
      const enabledProviders = this.modelManager.getEnabledProviders();
      if (enabledProviders.length === 0) {
        this.log.warn('[SelfLearner] 没有启用的模型，无法进行去重检查');
        return false;
      }

      const provider = enabledProviders[0];
      const modelId = provider.defaultModel || provider.models[0]?.id;
      if (!modelId) {
        return false;
      }

      const skills = this.skillLoader.getAllSkills();
      
      for (const existingSkill of skills) {
        const prompt = `当前提案的技能触发条件：${proposal.triggerCondition}\n\n已安装技能"${existingSkill.name}"的触发条件：${(existingSkill as any).triggerCondition || '无'}。\n\n请判断：这两个触发条件描述的是否是同一种用户意图？只回答"是"或"否"。`;
        
        const response = await this.makeChatCompletionRequest(provider, modelId, prompt);
        
        if (response) {
          const normalized = response.toLowerCase().trim();
          if (normalized.includes('是') || normalized.includes('yes')) {
            this.log.info('[SelfLearner] 发现重复技能', { 
              existingSkillName: existingSkill.name,
              proposalName: proposal.name
            });
            return true;
          }
        }
      }

      return false;
    } catch (error) {
      this.log.error('[SelfLearner] 去重检查失败', error);
      return false;
    }
  }

  /**
   * 从提案保存技能
   * @returns { success: boolean; needsRestart: boolean }
   */
  public saveSkillFromProposal(proposal: SkillProposal): { success: boolean; needsRestart: boolean } {
    let needsRestart = false;
    
    try {
      /**
       * 【M4-A 修复 —— 读写目录不一致】
       * 此前写 `getHost().getAppPath() + '/../skills'`(app 安装目录的兄弟目录,
       * Windows 打包后通常在 Program Files → 只读),而 SkillLoader 读
       * `userData/skills`。两个完全不同的路径 —— 保存的技能【永远扫不到】,
       * 且大概率直接 EACCES 抛错。
       *
       * 现统一走 SkillManager.getSkillsDir() —— 该方法注释里本就写明
       * "路径单点 — 其它模块应使用这个而非自己 join(userData,'skills')"。
       * 自学习保存的技能因此能被 SkillLoader 正常加载(热加载也才真正生效)。
       */
      const skillsDir = SkillManager.getSkillsDir();
      let skillDir = path.join(skillsDir, proposal.id);
      
      // 检查目录是否已存在，如果存在则添加时间戳后缀
      let dirCounter = 0;
      while (fs.existsSync(skillDir)) {
        dirCounter++;
        const suffix = dirCounter === 1 ? Date.now().toString() : `${Date.now()}_${dirCounter}`;
        skillDir = path.join(skillsDir, `${proposal.id}_${suffix}`);
        this.log.info('[SelfLearner] 技能目录已存在，使用新目录', { skillDir });
      }

      // 确保目录存在（递归创建）
      fs.mkdirSync(skillDir, { recursive: true });
      
      // 写入 SKILL.md(Anthropic 规范的文件名;SkillLoader 两者都认,优先大写)
      const skillMdPath = path.join(skillDir, 'SKILL.md');
      fs.writeFileSync(skillMdPath, proposal.fullInstructions, 'utf-8');
      
      // 调用 SkillLoader 重新加载技能（热加载）
      try {
        const skillLoader = SkillLoader.getInstance();
        skillLoader.reloadSkills();
        this.log.info('[SelfLearner] 技能热加载成功');
      } catch (error) {
        this.log.warn('[SelfLearner] 技能热加载失败，需要重启', error);
        needsRestart = true;
      }
      
      this.log.info('[SelfLearner] 技能保存成功', { skillId: proposal.id, skillDir, name: proposal.name, needsRestart });
      
      // 清除待处理提案
      this.pendingProposal = null;
      
      return { success: true, needsRestart };
      
    } catch (error) {
      this.log.error('[SelfLearner] 保存技能失败', error);
      return { success: false, needsRestart: false };
    }
  }

  /**
   * 获取待处理的提案
   */
  public getPendingProposal(): SkillProposal | null {
    return this.pendingProposal;
  }

  /**
   * 清除待处理提案
   */
  public clearPendingProposal(): void {
    this.pendingProposal = null;
  }

  /**
   * #007 H1: 提案超时判定 (订单既定 30 分钟; 诚实文案"提案已超期自动忽略"由 UI 侧消费)
   * v1 口径: 主进程侧守卫 — 收到时刻或前端拉取时刻判定, 超期 → {expired:true, reason};
   *          未超期 → {expired:false, reason:null}. 纯判定不 clear, clear 由调用方 (UI 或 IPC) 显式执行,
   *          保持单飞语义 (主进程侧不做任何定时器 — 订单 H1 "IPC 定时器" 由前端 v2 扩展, 见 H2 备查)
   */
  public isProposalExpired(now: Date, timeoutMs: number = 30 * 60 * 1000): { expired: boolean; reason: string | null } {
    const p = this.pendingProposal;
    if (!p) return { expired: false, reason: null };
    const elapsed = now.getTime() - p.createdAt;
    if (elapsed > timeoutMs) {
      const min = Math.floor(elapsed / 60000);
      return { expired: true, reason: `提案已存在 ${min} 分钟, 超过 30 分钟有效期` };
    }
    return { expired: false, reason: null };
  }

  /**
   * 比较两个技能的相似度（公共方法）
   */
  public async checkSkillSimilarity(
    name1: string,
    description1: string,
    name2: string,
    description2: string
  ): Promise<number> {
    try {
      const enabledProviders = this.modelManager.getEnabledProviders();
      if (enabledProviders.length === 0) {
        this.log.warn('[SelfLearner] 没有启用的模型，无法进行相似度检查');
        return 0;
      }

      const provider = enabledProviders[0];
      const modelId = provider.defaultModel || provider.models[0]?.id;
      if (!modelId) {
        return 0;
      }

      const prompt = `请判断以下两个技能是否描述了相同或非常相似的用户意图？
请只回答0-100之间的数字表示相似度，100表示完全相同，0表示完全不同。

技能1名称：${name1}
技能1描述：${description1}

技能2名称：${name2}
技能2描述：${description2}
`;

      const response = await this.makeChatCompletionRequest(provider, modelId, prompt);

      if (response) {
        const match = response.match(/\d+/);
        return match ? parseInt(match[0], 10) : 0;
      }

      return 0;
    } catch (error) {
      this.log.error('[SelfLearner] 相似度检查失败', error);
      return 0;
    }
  }

  /**
   * 获取学习统计
   */
  public getStats(): Record<string, number> {
    return {
      observationCount: this.observations.length,
      analysisInProgress: this.analysisInProgress ? 1 : 0
    };
  }

  /**
   * 重置学习统计
   */
  public resetStats(): void {
    this.observations = [];
    this.pendingProposal = null;
    this.saveObservations();
    this.log.info('[SelfLearner] 学习统计已重置');
  }

  /**
   * [兼容] 保持原来的checkPatternThreshold接口（始终返回false）
   */
  public checkPatternThreshold(_fingerprint: string): boolean {
    return false;
  }

  /**
   * [兼容] 保持原来的generateSkillProposal接口
   */
  public generateSkillProposal(_fingerprint: string): SkillProposal | null {
    return this.pendingProposal;
  }
}

