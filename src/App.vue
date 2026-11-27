<template>
  <el-config-provider :locale="epLocale">
    <div id="nw-app">
      <AppLayout />
      <DevPanel />
      <CommandConfirmDialog />
    </div>
  </el-config-provider>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import AppLayout from '@/components/layout/AppLayout.vue';
import DevPanel from '@/components/dev/DevPanel.vue';
import CommandConfirmDialog from '@/components/common/CommandConfirmDialog.vue';
import { onMounted } from 'vue';
import { useAppStore } from '@/stores/app';
import { useGatewayStore } from '@/stores/gateway';
import { prefetchRoutes } from '@/router';
import zhCn from 'element-plus/dist/locale/zh-cn.mjs';
import enUs from 'element-plus/dist/locale/en.mjs';

const appStore = useAppStore();
const gatewayStore = useGatewayStore();
const { locale } = useI18n();
// 替代被移除的全局 app.use(ElementPlus,{locale}),由各 Element Plus 组件子树继承
const epLocale = computed(() => (locale.value === 'en-US' ? enUs : zhCn));

onMounted(() => {
  appStore.initialize();
  gatewayStore.initialize();
  // 大厂做法: 启动后空闲预载高频路由 chunk,减少后续切换白屏
  prefetchRoutes();
});
</script>

<style lang="scss">
#nw-app {
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: var(--bg-base);
  color: var(--fg-primary);
  position: relative;
}
</style>
