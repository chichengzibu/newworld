/**
 * New World - 聊天类型定义
 */

import type { ProducedArtifact } from '../agent/tools/Tool';

export type MessageRole = 'user' | 'assistant' | 'system';
/**
 * 【M4-H】新增 'stub' —— 来自兜底占位实现的回复。
 *
 * 渲染层对 'streaming'/'sending'/'error' 有专门样式,'stub' 会落到普通文本分支;
 * 但它带 ⚠️ 前缀 + 正文写明「未接入真实模型」,一眼可辨。
 * 加这个状态值是为了让消息**带上结构化的性质**,而不只是正文里的一句话 ——
 * 将来要统计「有多少次是兜底答复」时,不用去猜正文。
 */
export type MessageStatus = 'sending' | 'streaming' | 'sent' | 'error' | 'stub';
export type ConversationStatus = 'active' | 'archived';

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  thinking?: string;
  /** 【P2】provider 真实回传的思考 token 数；缺失时不落字段，UI 不展示 */
  thinkingTokens?: number;
  /** 本轮 agent 真实落盘的成品；落消息而非只发事件，刷新后仍可打开 */
  artifacts?: ProducedArtifact[];
  timestamp: number;
  status: MessageStatus;
  modelId?: string;
  providerId?: string;
  error?: string;
  metadata?: Record<string, any>;
}

export interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  modelId?: string;
  providerId?: string;
  permissionSetId?: string;
  createdAt: number;
  updatedAt: number;
  status: ConversationStatus;
  pinned: boolean;
}

export interface ChatRequest {
  providerId: string;
  modelId: string;
  messages: Array<{ role: MessageRole; content: string }>;
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
}

export interface ChatResponse {
  id: string;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: MessageRole;
      content: string;
    };
    finishReason: string;
  }>;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface LLMStreamChunk {
  id: string;
  choices: Array<{
    delta: {
      content?: string;
      role?: MessageRole;
    };
    finishReason?: string;
  }>;
}

/**
 * 流式 chunk(W4.6 新增,用于 ChatManager.subscribeStream)
 */
export interface StreamChunk {
  seq: number;
  messageId: string;
  conversationId: string;
  textDelta?: string;
  thinkingDelta?: string;
  toolCallDelta?: {
    name: string;
    args: string;
  };
  done: boolean;
  timestamp: number;
}

export interface ChatSettings {
  temperature: number;
  maxTokens: number;
  topP: number;
  frequencyPenalty: number;
  presencePenalty: number;
}

export const DEFAULT_CHAT_SETTINGS: ChatSettings = {
  temperature: 0.7,
  maxTokens: 4096,
  topP: 1.0,
  frequencyPenalty: 0.0,
  presencePenalty: 0.0
};

export interface ChatSession {
  id: string;
  providerId: string;
  modelId: string;
  settings: ChatSettings;
  createdAt: number;
}
