import { defineConfig } from 'vite-plus'

// Vite+ 统一工具链根配置。lint=Oxlint,fmt=Oxfmt,test=Vitest。
// 不使用 eslint / prettier:格式与 lint 全由 Vite+ 内置的 Oxfmt / Oxlint 负责。
// 跨包编排由 turborepo 负责(见 .stdai/standards/rules/monorepo-toolchain.md),此处不定义跨包 run task。
export default defineConfig({
  fmt: {
    singleQuote: true,
    semi: false,
    // stdagent 机械生成产物(源在 .stdai/standards/,禁止手改):Oxfmt 重排会与 stdagent sync 输出互相打架,排除。
    // sdk/**:非 JS 语言 SDK 矩阵(go/rust/php/swift 等,各语言自有 formatter),php vendor 内置 css 会让 Oxfmt 崩溃,整体排除。
    ignorePatterns: [
      'CLAUDE.md',
      'AGENTS.md',
      '.claude/**',
      '.codex/**',
      '.agents/**',
      'sdk/**',
      // lingui compile 产物:单行 JSON catalog,不参与 Oxfmt
      'packages/i18n/locales/**/messages.mjs',
    ],
  },
  lint: {
    plugins: ['typescript'],
    // typeCheck(tsgo) 关闭:tsgo 在大包 native crash(SIGABRT)且漏报真 type errors,改用官方 tsc 作权威类型门
    // (server check 已含 tsc;tsc 经 main 指向源会间接类型检查被 import 的内核包)。typeAware lint 保留(no-floating-promises)
    options: {
      // typeAware + typeCheck(tsgo) 均关:tsgo 在大包 native crash + OOM + 漏报真 errors,不可靠。
      // 类型正确性改由独立 turbo typecheck task(官方 tsc)兜底(server typecheck script);
      // vp check 只做 oxfmt 格式 + oxlint 语法规则(轻量,turbo 并发不 OOM)。
      typeAware: false,
      typeCheck: false,
    },
    // oxlint(vite-plus)在 CI(2-thread/7GB)渲染海量 warnings 时 native crash(core dumped);且 typeAware 关闭后
    // type-aware 规则(no-floating-promises)无效。降级到稳定的语法规则子集。质量约定(文件/函数大小/复杂度/
    // floating-promise)保留在 code-style/error-handling rule 文档 + 官方 tsc(typecheck task)+ 对抗审查兜底。
    rules: {
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'no-explicit-any': 'error',
      'max-params': ['warn', 4],
    },
    overrides: [
      {
        files: ['apps/server/src/**', 'packages/react/**'],
        plugins: ['typescript', 'react'],
      },
      {
        files: [
          'apps/server/worker/**',
          'packages/protocol/**',
          'packages/webauthn/**',
          'packages/crypto/**',
          'packages/saml/**',
          'packages/db/**',
          'packages/backend/**',
        ],
        env: { node: true },
        rules: { 'no-console': 'off' },
      },
      {
        files: ['**/*.test.ts', '**/*.spec.ts'],
        plugins: ['typescript', 'vitest'],
      },
    ],
  },
})
