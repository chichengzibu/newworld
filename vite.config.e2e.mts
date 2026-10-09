import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import Components from 'unplugin-vue-components/vite';
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers';
import { resolve } from 'path';

/**
 * 纯前端 e2e 专用 vite 配置(不带 vite-plugin-electron)
 *
 * vitest.e2e.config.ts 的 webServer.command 引用本文件。
 * 复用 vite.config.mts 的前端关键项(alias @ / Element Plus 按需),
 * 但去掉 electron([...]) 与 renderer() 插件 —— 只把 src/ Vue3 应用
 * 跑在纯浏览器端,供 routes-render 这类 web 渲染 e2e 使用。
 *
 * 启动: `npx vite --config vite.config.e2e.mts`(自动选空闲端口,非 5173;
 *       5173 被 vite-plugin-electron 的 dev 默认占用)。
 */
export default defineConfig({
  base: './',
  // 与 vite.config.mts 一致:应用代码引用了这两个全局注入符号,缺失会崩挂载
  define: {
    __APP_VERSION__: JSON.stringify((process.env.npm_package_version || 'dev')),
    __BUILD_TIME__: JSON.stringify(new Date().toLocaleString('zh-CN')),
  },
  server: {
    proxy: {
      '/ollama': {
        target: 'http://localhost:11434',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/ollama/, ''),
      },
    },
  },
  plugins: [
    vue(),
    Components({
      resolvers: [
        ElementPlusResolver({
          importStyle: 'css',
        }),
      ],
      dirs: ['src/components', 'src/views'],
      extensions: ['vue'],
      exclude: [/\.(scss|sass|less|css)$/],
      dts: false,
    }),
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  css: {
    preprocessorOptions: {
      scss: {
        api: 'modern-compiler',
      },
    },
  },
});
