// apps/server vitest 根配置:worker 与 SPA 分文件 project,避免 StyleX 拖住 worker 进程退出。
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: ['./vitest.worker.config.ts', './vitest.spa.config.ts'],
  },
})
