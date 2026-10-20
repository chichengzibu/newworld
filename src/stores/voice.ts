/**
 * NOVA #005-B \u00b7 M4 \u8bed\u97f3 \u00b7 renderer \u7aef voice store (Pinia)
 *
 * \u8bbe\u8ba1\u7a3f\u7c7b\u6bd4: NOVA #002 \u00b7 Orb store (src/stores/orb.ts)
 *   - state: 'idle' | 'speaking' | 'error'
 *   - append action (\u8bbe\u8ba1\u7a3f F6.2 \u201c\u4e0d\u7834\u574f M1 \u56db\u6001\u201d)
 *   - \u900f\u8fc7 window.electronAPI.nova.voice.{getSettings,setSettings} \u4e0e\u4e3b\u8fdb\u7a0b\u4ea4\u4e92
 *
 * M4 \u7c89\u9636\u5f0f\u62c6\u5206:
 *   - SpeechStore (\u4e3b\u8fdb\u7a0b electron/core/voice/SpeechStore.ts): \u63a5\u7ebf\u5c42, \u5b58\u5728\u4e8e\u4e3b\u8fdb\u7a0b\u4ee5\u4f9b IPC handler \u8c03\u7528;
 *     \u672c\u7b14 renderer \u7aef store \u4e0d\u5bfc\u5165\u5b83\uff08\u8de8\u8fdb\u7a0b\u8fb9\u754c\u3001tsc \u62a5 modulenotfound\uff09\u3002
 *   - voice (renderer \u7aef\u672c store): \u4ee5 IPC \u4e3a\u4ec5\u4e00\u8c03\u7528\u9762, \u96c6\u6210 settings IPC + TTS \u72b6\u6001\u673a
 *
 * \u4e0e Orb store \u7684\u5b9e\u9645\u534f\u540c (F6.3 \u4f18\u5148\u7ea7):
 *   - thinking > speaking \u9ad8\u4f18\u5148\u7ea7 \u4e0d\u53d8 (M1 \u9501\u9762);
 *   - \u672c store \u4e0d\u76f4\u63a5\u8c03\u7528 orbStore.setSpeaking, \u7531\u6d88\u8d39\u8005 (Voice.vue) \u51b3\u5b9a\u8c03\u7528\u987a\u5e8f \u2192 M4 留 W5
 */
import { defineStore } from 'pinia';
import { ref } from 'vue';

export type VoiceState = 'idle' | 'speaking' | 'error';

export interface VoiceSettings {
  enabled: boolean;
  autoRead: boolean;
  rate: number;
  pitch: number;
  volume: number;
}

const DEFAULT_VOICE_SETTINGS: VoiceSettings = Object.freeze({
  enabled: false,
  autoRead: false,
  rate: 1.0,
  pitch: 1.0,
  volume: 1.0,
}) as VoiceSettings;

interface IpcVoiceApi {
  getSettings?: () => Promise<{ success: boolean; data?: VoiceSettings; error?: string }>;
  setSettings?: (patch: Partial<VoiceSettings>) => Promise<{ success: boolean; data?: VoiceSettings; error?: string }>;
}

function ipcVoice(): IpcVoiceApi | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { electronAPI?: { nova?: { voice?: IpcVoiceApi } } };
  return w.electronAPI?.nova?.voice ?? null;
}

export const useVoiceStore = defineStore('nova-voice', () => {
  const settings = ref<VoiceSettings>({ ...DEFAULT_VOICE_SETTINGS });
  const state = ref<VoiceState>('idle');
  const errorText = ref<string>('');

  function setState(next: VoiceState, errText?: string): void {
    state.value = next;
    if (errText !== undefined) errorText.value = errText;
  }

  async function loadSettings(): Promise<void> {
    const api = ipcVoice();
    if (!api?.getSettings) return;
    try {
      const r = await api.getSettings();
      if (r.success && r.data) settings.value = r.data;
    } catch {
      /* keep default settings */
    }
  }

  async function persistSettings(patch: Partial<VoiceSettings>): Promise<void> {
    settings.value = { ...settings.value, ...patch };
    const api = ipcVoice();
    if (!api?.setSettings) return;
    try {
      const r = await api.setSettings(patch);
      if (r.success && r.data) settings.value = r.data;
    } catch {
      /* 渲染层真值已设, 不重复 */
    }
  }

  return {
    settings,
    state,
    errorText,
    setState,
    loadSettings,
    persistSettings,
  };
});