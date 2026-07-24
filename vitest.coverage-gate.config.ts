import { defineConfig } from 'vitest/config'

const isWorkerGate = process.env.XID_COVERAGE_GATE === 'worker'

const coreGate = {
  include: [
    'packages/protocol/src/**/*.test.ts',
    'packages/crypto/src/**/*.test.ts',
    'packages/webauthn/src/**/*.test.ts',
  ],
  coverageInclude: [
    'packages/protocol/src/**/*.ts',
    'packages/crypto/src/**/*.ts',
    'packages/webauthn/src/**/*.ts',
  ],
  coverageExclude: [
    '**/*.test.ts',
    '**/__tests__/**',
    '**/index.ts',
    'packages/protocol/src/types.ts',
    'packages/crypto/src/types.ts',
  ],
  thresholds: { lines: 70, functions: 70, branches: 55, statements: 70 },
}

const workerGate = {
  include: [
    'apps/server/worker/durable-objects/**/*.test.ts',
    'apps/server/worker/queues/__tests__/{audit,webhook,metering}.test.ts',
    'apps/server/worker/oidc/__tests__/{token,token-grants,token-exchange,token-issue,token-security}.test.ts',
    'apps/server/worker/lib/__tests__/session.test.ts',
  ],
  coverageInclude: [
    'apps/server/worker/durable-objects/{audit-seq-do,challenge-store,device-flow-store,metering-do,oauth-flow-do,par-store,rate-limit-store,session-do}.ts',
    'apps/server/worker/queues/{audit,metering,webhook}.ts',
    'apps/server/worker/oidc/{token,token-exchange,token-grants,token-issue}.ts',
    'apps/server/worker/lib/session.ts',
  ],
  coverageExclude: ['**/*.test.ts', '**/__tests__/**'],
  // 门禁语义是"防大幅回退",不是把实测值卡到小数点。阈值一律低于实测 3-4pp:
  // 贴线设置会让一次无关重构的 0.07pp 抖动把 CI 判红,门禁失去信号价值。
  // 实测(2026-07-24):lines 82.48 / functions 89.54 / branches 74.90 / statements 79.81。
  thresholds: { lines: 78, functions: 85, branches: 71, statements: 75 },
}

const gate = isWorkerGate ? workerGate : coreGate

export default defineConfig({
  test: {
    include: gate.include,
    coverage: {
      provider: 'v8',
      reporter: ['text-summary'],
      reportsDirectory: isWorkerGate
        ? './node_modules/.cache/worker-coverage-gate'
        : './node_modules/.cache/coverage-gate',
      include: gate.coverageInclude,
      exclude: gate.coverageExclude,
      thresholds: isWorkerGate ? workerGate.thresholds : coreGate.thresholds,
    },
  },
})
