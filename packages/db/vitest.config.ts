// packages/db vitest 配置。
// 租户隔离测试用 node pool + in-memory D1 mock(不需要 Workers runtime)。
// 真实 Worker binding 集成测试留 apps/server。
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    pool: 'forks',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: false,
  },
})
