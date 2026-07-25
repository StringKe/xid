// packages/webauthn vitest 配置。
// WebAuthn 四验证只依赖 Web Crypto(crypto.subtle),Node 22 原生支持,用 node pool。
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    pool: 'forks',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: false,
  },
})
