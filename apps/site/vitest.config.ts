import { defineConfig } from 'vitest/config'

export default defineConfig({
  server: {
    watch: null,
  },
  test: {
    pool: 'forks',
    environment: 'node',
    globals: false,
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'worker/**/*.test.ts'],
  },
})
