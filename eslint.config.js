import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import vue from 'eslint-plugin-vue'
import vueTsEslintConfig from '@vue/eslint-config-typescript'
import globals from 'globals'

export default [
  // 1. 忽略规则
  {
    ignores: [
      'dist/**',
      'dist.bak-*/**',
      'dist-electron/**',
      // 【2026-11-24】打包产物与备份(含 release.bak-*/release-fresh-*, 里面是
      // 整个 Electron 发行包的几万个 JS, 曾经把 lint 顶到 3 万+ errors)
      'release*/**',
      'coverage*/**',
      // 构建备份目录(build.mjs moveAside / 环境备份脚本留下的, 内容是打包产物)
      'dist.bak-*/**',
      'dist-electron.bak-*/**',
      '.nw-env-backup-*/**',
      '.nw-lowercase-backup-*/**',
      '.nw-backup-*/**',
      '.nw-*-backup-*/**',
      // 通用 .nw-* 临时目录(.nw-design-fix-* / .nw-theme-* 等, 覆盖上述未列全的命名)
      '.nw-*/**',
      // ohos HAP 构建产物(third_party 内嵌 electron dist + entry/assets/app/dist)
      'ohos/**',
      // MCP 服务端的打包产物目录(vendored bundle)
      'electron/mcp/bin/**',
      // 子进程探针 fixture(以 node 子进程方式运行, 不参与源码 lint)
      'tests/fixtures/**',
      // 临时产物(.tmp-*.png/.log/.mjs/.tmp-audit-shots 等)
      '.tmp-*/**',
      '.tmp-*',
      'e2e-screenshots/**',
      'node_modules/**',
      'sandbox/runtime/**',
      'sandbox/base/.cache/**',
      'tests/e2e-report/**',
      'tests/e2e/**/screenshots/**',
      '*.config.js',
      '*.config.ts',
      '*.config.mjs',
      'bin/postinstall.mjs',
      'scripts/**',
    ],
  },

  // 2. 基础 JS 推荐
  js.configs.recommended,

  // 3. TS 推荐(覆盖 electron/ + 部分 src/)
  ...tseslint.configs.recommended,
  {
    files: ['electron/**/*.ts', 'electron/**/*.d.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^(e|err|error|ex)$',
        varsIgnorePattern: '^_',
        ignoreRestSiblings: true,
        destructuredArrayIgnorePattern: '^_',
        reportUsedIgnorePattern: false,
      }],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-var-requires': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-unsafe-function-type': 'off',
      '@typescript-eslint/ban-types': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-undef': 'off',
    },
  },

  // 4. Vue 推荐(覆盖 src/ + *.vue)
  ...vue.configs['flat/recommended'],
  ...vueTsEslintConfig(),
  {
    files: ['src/**/*.{js,ts,vue}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^(e|err|error|ex)$',
        varsIgnorePattern: '^_',
        ignoreRestSiblings: true,
        destructuredArrayIgnorePattern: '^_',
        reportUsedIgnorePattern: false,
      }],
      '@typescript-eslint/ban-ts-comment': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-undef': 'off',
      'no-case-declarations': 'off',
      'vue/multi-word-component-names': 'off',
      'vue/no-v-html': 'off',
      'vue/no-unused-vars': 'warn',
      'vue/html-self-closing': 'off',
      'vue/max-attributes-per-line': 'off',
      'vue/singleline-html-element-content-newline': 'off',
      'vue/html-indent': 'off',
      'vue/html-closing-bracket-newline': 'off',
      'vue/attributes-order': 'off',
      'vue/first-attribute-linebreak': 'off',
      'vue/attribute-hyphenation': 'off',
    },
  },

  // 5. 测试文件特殊宽松
  {
    files: ['tests/**/*.{ts,js}'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      'no-empty': 'off',
      'no-empty-pattern': 'off',
      'no-undef': 'off',
    },
  },

  // 6. 全局兜底:给 types/ 和其他顶层 .ts 同样的宽松
  {
    files: ['**/*.ts', '**/*.d.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-var-requires': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^(e|err|error|ex)$',
        varsIgnorePattern: '^_',
        ignoreRestSiblings: true,
        destructuredArrayIgnorePattern: '^_',
        reportUsedIgnorePattern: false,
      }],
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-unsafe-function-type': 'off',
      '@typescript-eslint/ban-types': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-undef': 'off',
      'prefer-const': 'warn',
    },
  },
]
