import { fileURLToPath } from 'node:url'
import stylexRollup from '@stylexjs/unplugin/rollup'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      'cloudflare:email': fileURLToPath(
        new URL('./test/cloudflare-email-stub.ts', import.meta.url),
      ),
    },
  },
  // rollup 变体避免 stylex.vite 在 vitest 结束时遗留文件句柄(10s close timeout)。
  plugins: [stylexRollup({ useCSSLayers: true, dev: false, runtimeInjection: true })],
  server: {
    watch: null,
  },
  test: {
    name: 'spa',
    pool: 'forks',
    environment: 'node',
    passWithNoTests: true,
    globals: false,
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
})
