/**
 * NOVA #005-B · M4 语音 · VoiceRegistry(单例家族对标, 第①笔)
 *
 * 设计稿: docs/NOVA-#005-M4-voice-design.md §F11 (F1 §1)
 * 对标 electron 域 getInstance 单例家族(G4 实证 100+ 处, e.g. ConfigStore:40 / GlobalShortcut:33 /
 *   IpcServer:76 / LlmClient:33 / SearchRegistry:getInstance)。
 *
 * 设计意图: TTSImpl 实例的统一拿取点(避免每个 store 各自 defaultTTSImpl(), 便于未来注入测试替身)。
 * 零 electron import / 零新依赖。
 */
import type { TTSImpl } from './types';
import { defaultTTSImpl } from './types';

export class VoiceRegistry {
  private static instance: VoiceRegistry;

  private ttsImpl: TTSImpl | null;
  /** set 时是否实际取 defaultTTSImpl()(区分"显式置 null(无 TTS)" vs "未 set"); F12.2 沿用 searchRegistry 风格 */
  private hasImpl: boolean;

  private constructor() {
    this.ttsImpl = defaultTTSImpl();
    this.hasImpl = true;
  }

  static getInstance(): VoiceRegistry {
    if (!VoiceRegistry.instance) VoiceRegistry.instance = new VoiceRegistry();
    return VoiceRegistry.instance;
  }

  /** 拿 TTSImpl; 未注入过 → 取 defaultTTSImpl()(生产端); 注入过 → 取注入值 */
  getTTSImpl(): TTSImpl | null {
    return this.ttsImpl;
  }

  /** 测试/维护 seam: 显式注入(可置 null = 模拟 speechSynthesis 缺失态) */
  setTTSImpl(impl: TTSImpl | null): void {
    this.ttsImpl = impl;
    this.hasImpl = true;
  }

  /** 是否曾经被注入过(用于测试判定: 区分"未注入" vs "显式置 null") */
  hasInjected(): boolean {
    return this.hasImpl;
  }

  /** 测试隔离 seam: 单测池 isolate=true 天然按文件隔离, 此为文件内多例复用 seam */
  static resetForTest(): void {
    VoiceRegistry.instance = new VoiceRegistry();
  }
}