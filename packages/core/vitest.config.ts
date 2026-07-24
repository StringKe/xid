// packages/core vitest 配置。
// core 逻辑无浏览器 DOM 依赖(fetch / now 均注入),用 node pool 即可;base64url 解码走 Web Crypto/标准 API。
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    pool: 'forks',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: false,
  },
})
