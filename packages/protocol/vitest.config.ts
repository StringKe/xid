// packages/protocol vitest 配置。
// 协议内核只依赖 Web Crypto(crypto.subtle),Node 22 原生支持,用 node pool。
// @cloudflare/vitest-pool-workers 留给真实 Worker binding 集成测试。
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    pool: 'forks',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: false,
  },
})
