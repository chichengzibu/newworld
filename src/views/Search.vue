<template>
  <div class="search-page nova-tech-surface">
    <header class="search-head">
      <h2 class="search-title">{{ t('nova.search.title') }}</h2>
      <p class="search-untrusted nova-search-untrusted" v-if="results.length > 0" aria-hidden="false">{{ t('nova.search.untrusted') }}</p>
    </header>

    <form class="search-form" @submit.prevent="onSubmit">
      <input
        v-model="query"
        class="search-input"
        :placeholder="t('nova.search.placeholder')"
        :disabled="loading"
        aria-label="search-query"
      />
      <button type="submit" class="search-btn" :disabled="loading || !query.trim()">
        {{ t('nova.search.button') }}
      </button>
    </form>

    <div v-if="loading" class="search-state" role="status">
      <span class="spinner" aria-hidden="true"></span>
      <span>{{ t('nova.search.state.loading') }}</span>
    </div>

    <div v-else-if="state === 'empty'" class="search-state">
      <span>{{ t('nova.search.state.empty') }}</span>
    </div>

    <div v-else-if="state === 'error'" class="search-state search-state--error">
      <span>{{ lastErrorText }}</span>
    </div>

    <section v-else-if="results.length > 0" class="search-results">
      <div class="search-resultbar">
        <span class="search-count">{{ t('nova.search.result.count', { n: results.length }) }}</span>
        <button type="button" class="copy-btn" @click="onCopy" :disabled="copying">
          {{ copied ? t('nova.search.copy.done') : t('nova.search.copy.btn') }}
        </button>
      </div>

      <ol class="result-list">
        <li v-for="(r, i) in results" :key="r.url" class="result-card">
          <div class="result-head">
            <span class="result-num">[{{ i + 1 }}]</span>
            <a class="result-title" :href="r.url" target="_blank" rel="noopener noreferrer">
              {{ r.title }}
            </a>
          </div>
          <p class="result-snippet" v-if="r.snippet">{{ r.snippet }}</p>
          <p class="result-url">{{ r.url }}</p>
        </li>
      </ol>

      <footer class="search-footnotes">
        <span class="footnote-label">{{ t('nova.search.result.source') }}</span>
        <ol class="footnote-list">
          <li v-for="(r, i) in results" :key="'fn-' + r.url">
            <a :href="r.url" target="_blank" rel="noopener noreferrer">[{{ i + 1 }}] {{ r.title }}</a>
          </li>
        </ol>
      </footer>
    </section>

    <!-- idle 初始空态: 之前 state='idle' 时模板没有任何分支渲染 → 整页空白,
         用户不知道这一页能做什么、结果会显示在哪。补引导 + 可点击示例查询。
         注意: .search-page 挂 nova-tech-surface(深底玻璃面 + 白字),
         此处文字一律不显式设 color, 继承白字, 避免浅色主题下深底深字。 -->
    <div v-else class="search-idle" role="note">
      <div class="search-idle-icon" aria-hidden="true">
        <svg viewBox="0 0 48 48" width="48" height="48" fill="none">
          <circle cx="21" cy="21" r="12" stroke="currentColor" stroke-width="2.5" />
          <path d="M30 30l9 9" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" />
          <path d="M15 21h12M21 15v12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" opacity="0.45" />
        </svg>
      </div>
      <h3 class="search-idle-title">{{ t('nova.search.idle.title') }}</h3>
      <p class="search-idle-desc">{{ t('nova.search.idle.desc') }}</p>
      <div class="search-idle-examples">
        <span class="search-idle-examples-label">{{ t('nova.search.idle.examples') }}</span>
        <button
          v-for="ex in exampleQueries"
          :key="ex"
          type="button"
          class="search-example-chip"
          @click="useExample(ex)"
        >
          {{ ex }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * NOVA #004-B · M3 联网搜索 · Search 视图(第③笔, 新文件)
 *
 * 红线: 不 import Chat.vue / 不进 ChatManager 指令管线(触发面=独立路由, 稿 F3 §1)。
 * 三态: loading / empty / error(稿 F5); i18n = nova.search.*(F5 §3 清单 + 裁定② copy 2 键)。
 *
 * e2e/无桥桩(渲染层镜像稿 F7 §1):
 *   纯前端 e2e 环境无 preload 桥(window.electronAPI 不存在) → 走内建固定桩结果,
 *   零网络、结果面稳定; 真实 Electron 环境桥在场 → 走 nova:search IPC 真链路。
 *   桩判定 = 桥存在性(而非版本号), 语义清晰: 无桥才可桩, 有桥必真链路。
 *
 * 不可信标注: t('nova.search.untrusted') 置于结果列表上方(稿 F4 §1 标注在数据之前)。
 */
import { ref, computed } from 'vue';
import { useI18n } from 'vue-i18n';

const { t } = useI18n();

interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
  provider?: string;
  fetchedAt?: number;
}
type NovaSearchRes = {
  success: boolean;
  data?: SearchResultItem[];
  error?: string;
  code?: string;
  elapsedMs?: number;
};
type NovaApi = {
  nova?: {
    search?: (q: { query: string; count?: number; locale?: string }) => Promise<NovaSearchRes>;
  };
};

const STUB_RESULTS: SearchResultItem[] = [
  { title: '[e2e stub] result 1', url: 'https://example.com/stub/1', snippet: 'stub result 1' },
  { title: '[e2e stub] result 2', url: 'https://example.com/stub/2', snippet: 'stub result 2' },
];

const query = ref('');
const results = ref<SearchResultItem[]>([]);
const loading = ref(false);
const state = ref<'idle' | 'empty' | 'error'>('idle');
const lastErrorText = ref('');
const copying = ref(false);
const copied = ref(false);

/** idle 空态的示例查询 —— 点击即填入并搜索, 让用户第一次进来就有可走的路径 */
const exampleQueries = computed<string[]>(() => [
  t('nova.search.idle.ex1'),
  t('nova.search.idle.ex2'),
  t('nova.search.idle.ex3'),
]);

function useExample(q: string): void {
  query.value = q;
  void doSearch(q);
}

function bridge(): ((q: { query: string; count?: number; locale?: string }) => Promise<NovaSearchRes>) | null {
  const w = window as unknown as { electronAPI?: NovaApi };
  return typeof w?.electronAPI?.nova?.search === 'function' ? w.electronAPI!.nova!.search! : null;
}

async function doSearch(q: string): Promise<void> {
  loading.value = true;
  state.value = 'idle';
  results.value = [];

  try {
    const call = bridge();
    if (!call) {
      // 无 IPC 桥(e2e 纯前端 / 单测无 preload): 内建桩, 零网络(F7 §1 渲染层镜像)
      await new Promise((r) => setTimeout(r, 60));
      results.value = STUB_RESULTS;
      return;
    }

    const res = await call({ query: q, count: 5 });
    if (!res?.success) {
      throw Object.assign(new Error(res?.error || 'unknown'), { code: res?.code || 'network' });
    }
    results.value = Array.isArray(res.data) ? res.data : [];
    if (results.value.length === 0) state.value = 'empty';
  } catch (e) {
    const code = (e as { code?: string })?.code || 'network';
    const key =
      code === 'rate-limited' ? 'nova.search.state.ratelimited'
      : code === 'timeout' ? 'nova.search.state.timeout'
      : code === 'invalid-query' ? 'nova.search.state.empty'
      : 'nova.search.state.error';
    lastErrorText.value = t(key);
    state.value = 'error';
  } finally {
    loading.value = false;
  }
}

function onSubmit(): void {
  const q = query.value.trim();
  if (!q || loading.value) return;
  void doSearch(q);
}

async function onCopy(): Promise<void> {
  if (copying.value || results.value.length === 0) return;
  copying.value = true;
  const text = results.value
    .map((r, i) => `[${i + 1}] ${r.title}\n${r.url}${r.snippet ? `\n${r.snippet}` : ''}`)
    .join('\n\n');
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      // 降级: textarea execCommand(无 clipboard 权限环境)
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
       
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    copied.value = true;
    setTimeout(() => (copied.value = false), 1600);
  } catch {
    copied.value = false;
  } finally {
    copying.value = false;
  }
}
</script>

<style scoped>
.search-page {
  min-height: 70vh;
  display: flex;
  flex-direction: column;
  padding: 32px 40px;
  gap: 18px;
  position: relative;
}

.search-title {
  margin: 0;
  font-size: 22px;
  /* v4.9：去掉渐变文字（AI 味最重的一处），回归正常前景色标题 */
  color: var(--fg-primary);
  letter-spacing: 0.01em;
}

.search-untrusted {
  margin: 6px 0 0;
  font-size: 12px;
  opacity: 0.75;
  border-left: 2px solid var(--nova-cyan, #7c8db5);
  padding-left: 8px;
}

.search-form {
  display: flex;
  gap: 10px;
}

.search-input {
  flex: 1;
  padding: 10px 14px;
  font-size: 14px;
  border-radius: 8px;
  border: 1px solid var(--el-border-color, #333);
  background: rgba(160, 168, 186, 0.04);
  color: inherit;
  outline: none;
  transition: border-color var(--nova-dur-fast, 180ms);
}
.search-input:focus {
  border-color: var(--nova-cyan, #7c8db5);
  
}
.search-input:disabled {
  opacity: 0.6;
}

.search-btn {
  padding: 10px 22px;
  font-size: 14px;
  border-radius: 8px;
  border: none;
  cursor: pointer;
  background: var(--accent-base, #7c8db5);
  color: #050508;
  font-weight: 600;
  transition: opacity var(--nova-dur-fast, 180ms), transform var(--nova-dur-fast, 180ms);
}
.search-btn:hover:not(:disabled) {
  transform: translateY(-1px);
}
.search-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.search-state {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 24px 12px;
  font-size: 14px;
  opacity: 0.85;
}
.search-state--error {
  color: var(--el-color-danger, #f56c6c);
}

.spinner {
  width: 14px;
  height: 14px;
  border: 2px solid var(--nova-cyan, #7c8db5);
  border-top-color: transparent;
  border-radius: 50%;
  animation: nw-spin 0.8s linear infinite;
}
@media (prefers-reduced-motion: reduce) {
  .spinner {
    animation: none;
  }
}

/* idle 初始空态 —— 填满原先的大片空白, 给出能力说明与可点击示例 */
.search-idle {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  gap: 10px;
  padding: 40px 16px 64px;
}
.search-idle-icon {
  color: var(--nova-cyan, #7c8db5);
  opacity: 0.8;
  margin-bottom: 2px;
}
.search-idle-title {
  margin: 0;
  font-size: 17px;
  font-weight: 600;
  letter-spacing: 0.01em;
}
.search-idle-desc {
  margin: 0;
  max-width: 540px;
  font-size: 13px;
  line-height: 1.7;
  opacity: 0.78;
}
.search-idle-examples {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  align-items: center;
  gap: 8px;
  margin-top: 14px;
}
.search-idle-examples-label {
  font-size: 12px;
  opacity: 0.6;
}
.search-example-chip {
  appearance: none;
  font-family: inherit;
  font-size: 12px;
  line-height: 1.5;
  padding: 6px 13px;
  border-radius: 9999px;
  cursor: pointer;
  color: inherit;
  background: rgba(160, 168, 186, 0.08);
  border: 1px solid rgba(160, 168, 186, 0.24);
  transition: border-color var(--nova-dur-fast, 180ms), transform var(--nova-dur-fast, 180ms);
}
.search-example-chip:hover {
  border-color: var(--nova-cyan, #7c8db5);
  transform: translateY(-1px);
}
.search-example-chip:focus-visible {
  outline: 2px solid var(--nova-cyan, #7c8db5);
  outline-offset: 2px;
}

.search-resultbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.search-count {
  font-size: 13px;
  opacity: 0.8;
}
.copy-btn {
  font-size: 12px;
  padding: 5px 12px;
  border-radius: 6px;
  border: 1px solid var(--el-border-color, #333);
  background: transparent;
  color: inherit;
  cursor: pointer;
  transition: border-color var(--nova-dur-fast, 180ms);
}
.copy-btn:hover:not(:disabled) {
  border-color: var(--nova-cyan, #7c8db5);
}
.copy-btn:disabled {
  cursor: default;
}

.result-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.result-card {
  border: 1px solid rgba(160, 168, 186, 0.12);
  border-radius: 10px;
  padding: 12px 16px;
  background: rgba(160, 168, 186, 0.03);
}
.result-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.result-num {
  font-size: 12px;
  color: var(--nova-cyan, #7c8db5);
  font-family: ui-monospace, monospace;
}
.result-title {
  color: inherit;
  font-size: 15px;
  font-weight: 600;
  text-decoration: none;
}
.result-title:hover {
  color: var(--nova-cyan, #7c8db5);
}
.result-snippet {
  margin: 6px 0 0;
  font-size: 13px;
  line-height: 1.6;
  opacity: 0.88;
}
.result-url {
  margin: 6px 0 0;
  font-size: 11px;
  opacity: 0.55;
  word-break: break-all;
  font-family: ui-monospace, monospace;
}

.search-footnotes {
  margin-top: 18px;
  padding-top: 12px;
  border-top: 1px dashed rgba(160, 168, 186, 0.25);
  font-size: 12px;
}
.footnote-list {
  margin: 6px 0 0;
  padding-left: 20px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.footnote-list a {
  color: inherit;
  opacity: 0.8;
  text-decoration: none;
}
.footnote-list a:hover {
  color: var(--nova-cyan, #7c8db5);
}
</style>
