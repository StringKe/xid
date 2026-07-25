// React Native SDK unit tests.
// Hook tests use @testing-library/react renderHook, which needs a DOM (jsdom).
// No react-native native modules are imported in tests (browser/tokenCache are injected mocks).
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    pool: 'forks',
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    globals: false,
  },
})
