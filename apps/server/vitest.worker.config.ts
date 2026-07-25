import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      'cloudflare:email': fileURLToPath(
        new URL('./test/cloudflare-email-stub.ts', import.meta.url),
      ),
    },
  },
  test: {
    name: 'worker',
    pool: 'forks',
    environment: 'node',
    passWithNoTests: true,
    globals: false,
    include: ['worker/**/*.test.ts', 'scripts/**/*.test.mjs', 'vite-plugins/**/*.test.ts'],
  },
})
