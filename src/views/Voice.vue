<!--
  NOVA #005-B \u00b7 M4 \u8bed\u97f3 \u00b7 Voice \u89c6\u56fe (\u7b2c\u2462\u7b14)

  \u7ea2\u7ebf (\u4e0e #004-B Search.vue \u540c\u6784):
    - \u4e0d import Chat.vue / \u4e0d\u8fdb ChatManager (\u89e6\u53d1\u9762 = \u72ec\u7acb\u8def\u7531 /voice)
    - \u4e09\u6001: idle / speaking / error
    - i18n = nova.voice.* (\u9644 zh/en 1:1)
    - \u53d1\u8a00\u8bed\u97f3\u5f15\u64ce = window.speechSynthesis (\u6e32\u67d3\u7aef Web Speech API, F0 \u5b9e\u8bc1 \u5728\u7aef)
    - F0 voices:0 \u5b9e\u8bc1 \u2192 voice picker \u4e0d\u6e32\u67d3 (\u53ea\u5728 voices > 0 \u65f6\u51fa\u73b0)
    - \u671f\u520a\u4e2d\u518d\u70b9 = cancel (speak \u6309\u94ae\u5207\u6362\u4e3a \u505c\u6b62)
-->
<template>
  <div class="voice-page nova-tech-surface">
    <header class="voice-head">
      <h2 class="voice-title">{{ t('nova.voice.tts.title') }}</h2>
      <p v-if="voice.state === 'speaking'" class="voice-speaking" aria-live="polite">
        {{ t('nova.voice.tts.state.speaking') }}
      </p>
    </header>

    <div class="voice-settings">
      <label class="setting-row">
        <span>{{ t('nova.voice.tts.enabled') }}</span>
        <input
          type="checkbox"
          :checked="voice.settings.enabled"
          aria-label="tts-enabled"
          @change="onToggleEnabled(($event.target as HTMLInputElement).checked)"
        />
      </label>
      <label class="setting-row">
        <span>{{ t('nova.voice.tts.autoRead') }}</span>
        <input
          type="checkbox"
          :checked="voice.settings.autoRead"
          aria-label="tts-autoread"
          @change="onToggleAutoRead(($event.target as HTMLInputElement).checked)"
        />
      </label>
      <label class="setting-row">
        <span>{{ t('nova.voice.tts.rate') }}: {{ voice.settings.rate.toFixed(1) }}</span>
        <input
          type="range"
          min="0.5" max="2" step="0.1"
          :value="voice.settings.rate"
          aria-label="tts-rate"
          @input="onSetRate(Number(($event.target as HTMLInputElement).value))"
        />
      </label>
      <label class="setting-row">
        <span>{{ t('nova.voice.tts.pitch') }}: {{ voice.settings.pitch.toFixed(1) }}</span>
        <input
          type="range"
          min="0" max="2" step="0.1"
          :value="voice.settings.pitch"
          aria-label="tts-pitch"
          @input="onSetPitch(Number(($event.target as HTMLInputElement).value))"
        />
      </label>
      <label class="setting-row">
        <span>{{ t('nova.voice.tts.volume') }}: {{ voice.settings.volume.toFixed(1) }}</span>
        <input
          type="range"
          min="0" max="1" step="0.1"
          :value="voice.settings.volume"
          aria-label="tts-volume"
          @input="onSetVolume(Number(($event.target as HTMLInputElement).value))"
        />
      </label>
      <label v-if="voices.length > 0" class="setting-row">
        <span>{{ voices[0]?.name }}</span>
        <select
          :value="voices[0]?.name"
          aria-label="tts-voice"
          @change="onSetVoice(($event.target as HTMLSelectElement).value)"
        >
          <option v-for="v in voices" :key="v.name" :value="v.name">{{ v.name }} ({{ v.lang }})</option>
        </select>
      </label>
    </div>

    <form class="voice-form" @submit.prevent="onSpeak">
      <textarea
        v-model="text"
        class="voice-input"
        :placeholder="t('nova.voice.tts.placeholder')"
        :disabled="voice.state === 'speaking'"
        rows="4"
        aria-label="tts-input"
      ></textarea>
      <button
        v-if="voice.state !== 'speaking'"
        type="submit"
        class="voice-btn"
        :disabled="!text.trim()"
      >
        {{ t('nova.voice.tts.button.speak') }}
      </button>
      <button
        v-else
        type="button"
        class="voice-btn voice-btn--stop"
        @click="onCancel"
      >
        {{ t('nova.voice.tts.button.stop') }}
      </button>
    </form>

    <div v-if="voice.state === 'error'" class="voice-state voice-state--error" role="alert">
      <span>{{ voice.errorText }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * NOVA #005-B \u00b7 M4 \u8bed\u97f3 \u00b7 Voice \u89c6\u56fe script (\u7b2c\u2462\u7b14)
 *
 * \u6e32\u67d3\u7aef TTS \u63a5\u623a\u8def\u5f84 (M4 \u7c89\u9636\u5f0f\u62c6\u5206):
 *   - voice (Pinia store, src/stores/voice.ts): settings \u6301\u4e45\u5316\u8c03 IPC, state \u672c\u5730\u72b6\u6001\u673a
 *   - speechSynthesis \u5f15\u64ce\u672c\u8eab\u5728\u6e32\u67d3\u7aef, \u672c\u9875\u76f4\u63a5\u8c03\u7528 window.speechSynthesis
 *   - \u4e0d\u8fdb\u5165 ChatManager; \u4e0d\u4fee\u6539 Chat.vue; \u4e0d\u52a8 M1 \u9501\u9762
 *
 * \u9519\u8bef\u72b6\u6001\u4e0a\u62a5 (\u7c89\u9636\u5f0f \u2014\u2014 \u8bbe\u8ba1\u7a3f F7.1 stub):
 *   - speechSynthesis \u5168\u7f3a\u5931 \u2192 error(\u9519\u8bef\u6587\u6848 = unavailable)
 *   - text \u4e3a\u7a7a \u2192 error(\u9519\u8bef\u6587\u6848 = \u201c\u671f\u520a\u5df2\u505c\u6b62\u201d \u662f\u8bbe\u8ba1\u7a3f canceled \u590d\u7528, MVP \u4e0d\u533a\u5206)
 *   - \u672a\u6765 W4 \u63a5\u4e91\u7aef ASR: \u4f9d F8 \u9690\u79c1\u8bbe\u8ba1\u989d\u5916\u589e\u52a0\u660e\u786e\u9519\u8bef\u6587\u6848
 */
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useVoiceStore } from '@/stores/voice';

interface VoiceInfo { name: string; lang: string }

const { t } = useI18n();
const voice = useVoiceStore();
const text = ref<string>('');
const voices = ref<VoiceInfo[]>([]);

function refreshVoices(): void {
  if (typeof window === 'undefined') return;
  const g = window as { speechSynthesis?: { getVoices?: () => Array<{ name: string; lang: string }> } };
  if (g.speechSynthesis?.getVoices) {
    voices.value = g.speechSynthesis.getVoices().map((v) => ({ name: v.name, lang: v.lang }));
  }
}

function onToggleEnabled(v: boolean): void { void voice.persistSettings({ enabled: v }); }
function onToggleAutoRead(v: boolean): void { void voice.persistSettings({ autoRead: v }); }
function onSetRate(v: number): void { void voice.persistSettings({ rate: v }); }
function onSetPitch(v: number): void { void voice.persistSettings({ pitch: v }); }
function onSetVolume(v: number): void { void voice.persistSettings({ volume: v }); }
function onSetVoice(_v: string): void { /* M4 MVP voices:0, UI 占用位; 真 voice \u9009\u62e9\u5ef6\u540e */ }

function onSpeak(): void {
  if (typeof window === 'undefined') return;
  const win = window as { speechSynthesis?: { speak?: (u: unknown) => void; cancel?: () => void } };
  const ss = win.speechSynthesis;
  if (!ss || !ss.speak) {
    voice.setState('error', t('nova.voice.tts.error.unavailable'));
    return;
  }
  const text2 = text.value.trim();
  if (!text2) {
    voice.setState('error', t('nova.voice.tts.error.canceled'));
    return;
  }
  voice.setState('speaking');
  const U = (globalThis as { SpeechSynthesisUtterance?: new (t: string) => unknown }).SpeechSynthesisUtterance;
  if (!U) {
    voice.setState('error', t('nova.voice.tts.error.unavailable'));
    return;
  }
  const u = new U(text2);
  try {
    (u as { lang?: string }).lang = 'zh-CN';
    (u as { rate?: number }).rate = voice.settings.rate;
    (u as { pitch?: number }).pitch = voice.settings.pitch;
    (u as { volume?: number }).volume = voice.settings.volume;
    (u as { onstart?: () => void }).onstart = () => voice.setState('speaking');
    (u as { onend?: () => void }).onend = () => voice.setState('idle');
    (u as { onerror?: () => void }).onerror = () => voice.setState('error', t('nova.voice.tts.error.canceled'));
    if (ss.cancel) ss.cancel();
    ss.speak(u);
  } catch {
    voice.setState('error', t('nova.voice.tts.error.canceled'));
  }
}

function onCancel(): void {
  if (typeof window === 'undefined') return;
  const g = window as { speechSynthesis?: { cancel?: () => void } };
  try {
    if (g.speechSynthesis && g.speechSynthesis.cancel) g.speechSynthesis.cancel();
  } catch { /* ignore */ }
  voice.setState('idle');
}

onMounted(() => {
  refreshVoices();
  if (typeof window !== 'undefined') {
    const g = window as { speechSynthesis?: { addEventListener?: (t: string, h: () => void) => void } };
    g.speechSynthesis?.addEventListener?.('voiceschanged', refreshVoices);
  }
  void voice.loadSettings();
});
</script>

<style lang="scss" scoped>
@import '../styles/tokens.css';

.voice-page {
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 24px 32px;
  max-width: 720px;
  margin: 0 auto;
}

.voice-head {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.voice-title {
  font-size: 20px;
  font-weight: 600;
  color: var(--fg-default);
}

.voice-speaking {
  font-size: 12px;
  color: var(--fg-muted);
}

.voice-settings {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  background: var(--bg-base);
  border-radius: 6px;
}

.setting-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 14px;
  color: var(--fg-default);
}

.setting-row input[type='range'],
.setting-row select {
  flex: 1;
  margin-left: 16px;
}

.voice-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.voice-input {
  padding: 10px 12px;
  font-size: 14px;
  font-family: var(--font-mono);
  background: var(--bg-base);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  color: var(--fg-default);
  resize: vertical;
}

.voice-input:focus {
  outline: none;
  border-color: var(--accent);
}

.voice-btn {
  padding: 10px 16px;
  font-size: 14px;
  background: var(--accent);
  color: var(--bg-base);
  border: none;
  border-radius: 6px;
  cursor: pointer;
}

.voice-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.voice-btn--stop {
  background: var(--error);
}

.voice-state--error {
  padding: 10px 12px;
  font-size: 13px;
  color: var(--error);
  background: var(--error-bg);
  border-radius: 6px;
}
</style>