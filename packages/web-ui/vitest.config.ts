import stylexRollup from '@stylexjs/unplugin/rollup'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [stylexRollup({ useCSSLayers: true, dev: false, runtimeInjection: true })],
  server: {
    watch: null,
  },
  test: {
    environment: 'node',
    globals: false,
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
})
