// Angular SDK unit tests run in a Node environment.
// Angular framework (DI/TestBed) is not used in tests -- pure logic units only.
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    pool: 'forks',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: false,
  },
})
