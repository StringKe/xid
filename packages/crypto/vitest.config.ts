// packages/crypto vitest 配置。
// 信封加密与签名密钥只依赖 Web Crypto(crypto.subtle),Node 22 原生支持,用 node pool。
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    pool: 'forks',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: false,
  },
})
