/**
 * NOVA #005-B · M4 语音 · barrel(第①笔)
 * 导出面: types / SpeechStore / VoiceRegistry
 * 注: 不导出 TTSImpl 之外的生产端 default 行为; SpeechStore 由测试侧显式注入 mock TTSImpl。
 */
export {
  type SpeakRequest,
  type SpeechState,
  type TtsErrorCode,
  type VoiceSettings,
  type TTSImpl,
  DEFAULT_VOICE_SETTINGS,
  defaultTTSImpl,
} from './types';
export { SpeechStore } from './SpeechStore';
export { VoiceRegistry } from './VoiceRegistry';