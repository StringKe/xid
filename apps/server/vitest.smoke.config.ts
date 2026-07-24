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
    name: 'smoke',
    pool: 'forks',
    environment: 'node',
    globals: false,
    include: ['tests/smoke/**/*.test.mjs'],
    testTimeout: 900000,
    hookTimeout: 900000,
  },
})
