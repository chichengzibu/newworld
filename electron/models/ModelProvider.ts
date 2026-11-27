/**
 * New World - 模型提供商类型定义
 */

export type ProviderType = 'openai' | 'anthropic' | 'deepseek' | 'azure' | 'ollama' | 'custom' | 'openrouter' | 'volc_ark';

export type ModelCapability = 'chat' | 'completion' | 'embedding' | 'vision' | 'function';

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  capabilities: ModelCapability[];
  maxTokens?: number;
  contextWindow?: number;
  inputCost?: number;
  outputCost?: number;
  description?: string;
  disabled?: boolean;
}

export interface ProviderConfig {
  id: string;
  name: string;
  type: ProviderType;
  enabled: boolean;
  baseUrl?: string;
  apiKey?: string;
  organization?: string;
  deploymentName?: string;
  apiVersion?: string;
  models: ModelInfo[];
  defaultModel?: string;
  timeout?: number;
  maxRetries?: number;
  createdAt: number;
  updatedAt: number;
}

export interface ModelTestResult {
  success: boolean;
  latency?: number;
  response?: string;
  error?: string;
}

export interface ProviderFormData {
  name: string;
  type: ProviderType;
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  organization: string;
  deploymentName: string;
  apiVersion: string;
  timeout: number;
  maxRetries: number;
  models: Omit<ModelInfo, 'provider'>[];
}

export const PROVIDER_DEFAULTS: Record<ProviderType, Partial<ProviderConfig>> = {
  openai: {
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    timeout: 60000,
    maxRetries: 3
  },
  anthropic: {
    name: 'Anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    timeout: 60000,
    maxRetries: 3
  },
  deepseek: {
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    timeout: 60000,
    maxRetries: 3
  },
  azure: {
    name: 'Azure OpenAI',
    baseUrl: 'https://{resource}.openai.azure.com',
    timeout: 60000,
    maxRetries: 3
  },
  ollama: {
    name: 'Ollama',
    baseUrl: 'http://localhost:11434',
    timeout: 30000,
    maxRetries: 2
  },
  custom: {
    name: 'Custom Provider',
    baseUrl: '',
    timeout: 60000,
    maxRetries: 3
  },
  openrouter: {
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    timeout: 60000,
    maxRetries: 3
  },
  volc_ark: {
    name: '火山引擎',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    timeout: 60000,
    maxRetries: 3
  }
};

export const PROVIDER_ICONS: Record<ProviderType, string> = {
  openai: '🤖',
  anthropic: '🧠',
  deepseek: '🔮',
  azure: '☁️',
  ollama: '🦙',
  custom: '⚙️',
  openrouter: '🌐',
  volc_ark: '🌋'
};

/**
 * ModelManager provider → LlmClient 的 provider 配置(【M4-L】)
 * ═══════════════════════════════════════════════════════════════════════
 * 【为什么需要这个映射】
 * 本项目有**两套 provider 注册表**(路线图开篇写的「LLM 精神分裂」):
 *   · ModelManager    —— 用户在「设置 → 模型管理」里配的 provider(聊天选型器读它)
 *   · LlmConfigStore  —— LlmClient 唯一认的表(按 provider **类型**索引)
 * 两边**没有同步**,而且设置页**没有** LlmConfigStore 的入口
 * (`/settings/llm-config` 是孤岛路由,导航里没有它)。
 *
 * 后果:agent 路径(自 M4-B 起是聊天的默认路径)用 LlmClient → 找不到配置 →
 * 每条消息先报一次 "no LLM provider configured" 再回落旧管道。
 *
 * 【本函数的定位】
 * 按**会话**把用户选中的那个 provider 翻译成 LlmClient 能用的配置,
 * 随请求带下去(inline config)。不写全局表 —— 全局表按类型索引,
 * 同类型的多个用户 provider 会互相覆盖。
 */

import type { InlineLlmConfig, LlmProvider } from '../llm/types';

/** ModelManager 的 provider 类型 → LlmClient 的 provider 类型 */
export function toLlmProviderType(type: ProviderType): LlmProvider {
  switch (type) {
    case 'openai':
      return 'openai';
    case 'anthropic':
      return 'anthropic';
    case 'ollama':
      // ollama 走 OpenAI 兼容协议
      return 'openai-compatible';
    case 'openrouter':
    case 'deepseek':
    case 'azure':
    case 'volc_ark':
    case 'custom':
    default:
      return 'openai-compatible';
  }
}

/**
 * ModelManager provider → LlmClient 内联配置。
 *
 * 【baseUrl 归一】LlmClient 的适配器都按 OpenAI 协议拼 `<base>/chat/completions`,
 * 而 ModelManager 里:
 *   · ollama 的 baseUrl 常写成 `http://localhost:11434`(不带 /v1)→ 补上
 *   · 其它类型用户通常自己带 /v1 → 原样用
 */
export function toLlmProviderConfig(provider: ProviderConfig): InlineLlmConfig {
  const raw = (provider.baseUrl || '').trim().replace(/\/+$/, '');
  let apiBaseUrl = raw;
  if (provider.type === 'ollama') {
    apiBaseUrl = raw || 'http://localhost:11434';
    if (!/\/v\d+$/.test(apiBaseUrl)) apiBaseUrl = `${apiBaseUrl}/v1`;
  }
  return {
    provider: toLlmProviderType(provider.type),
    apiKey: provider.apiKey ?? '',
    apiBaseUrl: apiBaseUrl || undefined,
  };
}
