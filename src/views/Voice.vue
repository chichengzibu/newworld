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
        <el-switch
          :model-value="voice.settings.enabled"
          aria-label="tts-enabled"
          @change="onToggleEnabled($event as boolean)"
        />
      </label>
      <label class="setting-row">
        <span>{{ t('nova.voice.tts.autoRead') }}</span>
        <el-switch
          :model-value="voice.settings.autoRead"
          aria-label="tts-autoread"
          @change="onToggleAutoRead($event as boolean)"
        />
      </label>
      <label class="setting-row setting-row--slider">
        <span>{{ t('nova.voice.tts.rate') }}: {{ voice.settings.rate.toFixed(1) }}</span>
        <el-slider
          :model-value="voice.settings.rate"
          :min="0.5" :max="2" :step="0.1"
          aria-label="tts-rate"
          @input="onSetRate($event as number)"
        />
      </label>
      <label class="setting-row setting-row--slider">
        <span>{{ t('nova.voice.tts.pitch') }}: {{ voice.settings.pitch.toFixed(1) }}</span>
        <el-slider
          :model-value="voice.settings.pitch"
          :min="0" :max="2" :step="0.1"
          aria-label="tts-pitch"
          @input="onSetPitch($event as number)"
        />
      </label>
      <label class="setting-row setting-row--slider">
        <span>{{ t('nova.voice.tts.volume') }}: {{ voice.settings.volume.toFixed(1) }}</span>
        <el-slider
          :model-value="voice.settings.volume"
          :min="0" :max="1" :step="0.1"
          aria-label="tts-volume"
          @input="onSetVolume($event as number)"
        />
      </label>
      <label v-if="voices.length > 0" class="setting-row">
        <span>{{ voices[0]?.name }}</span>
        <el-select
          :model-value="voices[0]?.name"
          aria-label="tts-voice"
          style="width: 320px"
          @change="onSetVoice($event as string)"
        >
          <el-option v-for="v in voices" :key="v.name" :label="`${v.name} (${v.lang})`" :value="v.name" />
        </el-select>
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
 * 错误状态上报（P2 已落地）：
 *   - 页面每条失败路径都带 code/source/cause 调 voice.setState('error', ...)
 *   - store 统一把错误写进本地台账（voice-unavailable / voice-invalid-text / voice-engine / voice-settings）
 *   - 空文本与引擎失败此前共用「朗读已停止」，现分别显示真实原因
 *   - 未来 W4 接云端 ASR 时沿用同一套 code → kind 映射
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
  try {
    if (g.speechSynthesis?.getVoices) {
      voices.value = g.speechSynthesis.getVoices().map((v) => ({ name: v.name, lang: v.lang }));
    }
  } catch (e) {
    voice.reportVoiceError({ code: 'engine-error', source: 'voice:voices', cause: e });
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
    voice.setState('error', t('nova.voice.tts.error.unavailable'), { code: 'unavailable', source: 'voice:tts' });
    return;
  }
  const text2 = text.value.trim();
  if (!text2) {
    voice.setState('error', t('nova.voice.tts.error.empty'), { code: 'invalid-text', source: 'voice:tts' });
    return;
  }
  voice.setState('speaking');
  const U = (globalThis as { SpeechSynthesisUtterance?: new (t: string) => unknown }).SpeechSynthesisUtterance;
  if (!U) {
    voice.setState('error', t('nova.voice.tts.error.noVoice'), { code: 'no-voice', source: 'voice:tts' });
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
    (u as { onerror?: (e?: { error?: string }) => void }).onerror = (e) => {
      voice.setState('error', t('nova.voice.tts.error.engine'), {
        code: 'engine-error',
        source: 'voice:tts',
        cause: new Error(e?.error ?? 'speech-synthesis-onerror'),
      });
    };
    if (ss.cancel) ss.cancel();
    ss.speak(u);
  } catch (e) {
    voice.setState('error', t('nova.voice.tts.error.engine'), { code: 'engine-error', source: 'voice:tts', cause: e });
  }
}

function onCancel(): void {
  if (typeof window === 'undefined') return;
  const g = window as { speechSynthesis?: { cancel?: () => void } };
  try {
    if (g.speechSynthesis && g.speechSynthesis.cancel) g.speechSynthesis.cancel();
  } catch (e) {
    // 停止失败不该改变 UI 状态，但必须可观测
    voice.reportVoiceError({ code: 'engine-error', source: 'voice:tts', cause: e }, t('nova.voice.tts.error.canceled'));
  }
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

/* el-slider 宿主: 固定宽度, 不吃 flex 拉伸 */
.setting-row--slider .el-slider {
  width: 320px;
  margin-left: 16px;
  flex: none;
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