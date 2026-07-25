// Expo SDK unit tests.
// useProtectedRoute tests use @testing-library/react renderHook, which needs a DOM (jsdom).
// expo-secure-store / expo-web-browser are vi.mock'ed -- no native modules load.
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    pool: 'forks',
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    globals: false,
  },
})
