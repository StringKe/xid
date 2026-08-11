// CI 门禁:确保 P0 安全/协议/隔离/i18n 测试文件存在且含用例(不替代 coverage)。

import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/** @type {ReadonlyArray<{ path: string; area: string; minTests?: number }>} */
const KEY_PATH_TESTS = [
  {
    path: 'apps/server/worker/auth/__tests__/magic-link.test.ts',
    area: 'magic-link jti/enum',
    minTests: 5,
  },
  {
    path: 'apps/server/worker/auth/__tests__/hosted-policy.test.ts',
    area: 'hosted auth policy',
    minTests: 10,
  },
  {
    path: 'apps/server/worker/auth/__tests__/passkey.test.ts',
    area: 'webauthn four-verify',
    minTests: 5,
  },
  {
    path: 'apps/server/worker/v1/__tests__/isolation.test.ts',
    area: 'tenant isolation v1',
    minTests: 15,
  },
  {
    path: 'packages/db/src/__tests__/tenant-db.test.ts',
    area: 'drizzle tenant injection',
    minTests: 3,
  },
  {
    path: 'apps/server/worker/rbac/__tests__/claims.test.ts',
    area: 'rbac claims assembly',
    minTests: 4,
  },
  { path: 'apps/server/worker/rbac/__tests__/rbac.test.ts', area: 'rbac abac/merge', minTests: 10 },
  {
    path: 'apps/server/worker/oidc/__tests__/token.test.ts',
    area: 'oidc token/PKCE/refresh',
    minTests: 10,
  },
  { path: 'apps/server/worker/oidc/__tests__/fapi.test.ts', area: 'fapi par+dpop', minTests: 3 },
  { path: 'apps/server/worker/oidc/__tests__/dpop.test.ts', area: 'dpop proof', minTests: 2 },
  {
    path: 'packages/protocol/src/__tests__/refresh.test.ts',
    area: 'refresh rotation family',
    minTests: 5,
  },
  {
    path: 'packages/webauthn/src/__tests__/verify.test.ts',
    area: 'webauthn verify kernel',
    minTests: 10,
  },
  { path: 'apps/server/worker/scim/__tests__/scim.test.ts', area: 'scim inbound', minTests: 20 },
  {
    path: 'apps/server/worker/platform/__tests__/platform.test.ts',
    area: 'platform management',
    minTests: 10,
  },
  {
    path: 'apps/server/worker/crons/__tests__/dispatch.test.ts',
    area: 'cron dispatch/dau',
    minTests: 10,
  },
  {
    path: 'apps/server/worker/crons/__tests__/dispatch-routing.test.ts',
    area: 'cron dispatch routing',
    minTests: 2,
  },
  {
    path: 'apps/server/worker/crons/__tests__/signing-rotation.test.ts',
    area: 'signing key rotation',
    minTests: 5,
  },
  {
    path: 'apps/server/worker/crons/__tests__/signing-rotation-flow.test.ts',
    area: 'signing rotation cron flow',
    minTests: 4,
  },
  {
    path: 'apps/server/worker/crons/__tests__/daily-saml-poll.test.ts',
    area: 'saml metadata poll negatives',
    minTests: 5,
  },
  {
    path: 'apps/server/worker/auth/__tests__/password.test.ts',
    area: 'password argon2/hibp/reset',
    minTests: 15,
  },
  {
    path: 'apps/server/worker/crons/__tests__/hourly-cleanup.test.ts',
    area: 'hourly cleanup',
    minTests: 5,
  },
  {
    path: 'apps/server/worker/crons/__tests__/daily-run.test.ts',
    area: 'daily cron orchestration',
    minTests: 3,
  },
  {
    path: 'apps/server/worker/crons/__tests__/daily-poll.test.ts',
    area: 'daily cert/domain poll',
    minTests: 7,
  },
  { path: 'packages/i18n/src/catalog.test.ts', area: 'i18n catalog parity', minTests: 1 },
  { path: 'apps/server/src/lib/i18n-ui-audit.test.ts', area: 'lingui ui coverage', minTests: 1 },
  {
    path: 'apps/server/worker/oauth/__tests__/revoke.test.ts',
    area: 'token revoke denylist',
    minTests: 3,
  },
  {
    path: 'apps/server/worker/oauth/__tests__/introspect.test.ts',
    area: 'token introspect',
    minTests: 3,
  },
  {
    path: 'apps/server/worker/me-auth/__tests__/passwordless.test.ts',
    area: 'passwordless enum',
    minTests: 10,
  },
  {
    path: 'tests/protocols/source-map-coverage.test.mjs',
    area: 'protocol source-map gate',
    minTests: 5,
  },
  {
    path: 'tests/quality-gate-summary.test.mjs',
    area: 'quality gate area minimums',
    minTests: 3,
  },
  {
    path: 'apps/server/worker/lib/__tests__/session.test.ts',
    area: 'session idle enforcement',
    minTests: 20,
  },
  {
    path: 'apps/server/worker/oidc/__tests__/shared.test.ts',
    area: 'access ttl three-layer resolve',
    minTests: 5,
  },
]

function countTests(source) {
  const itMatches = source.match(/^\s*it(?:\.each)?\s*\(/gm) ?? []
  const testMatches = source.match(/^\s*test\s*\(/gm) ?? []
  return itMatches.length + testMatches.length
}

describe('key-path test checklist', () => {
  for (const entry of KEY_PATH_TESTS) {
    it(`keeps ${entry.area} coverage at ${entry.path}`, () => {
      expect(existsSync(entry.path), `missing key-path test file: ${entry.path}`).toBe(true)
      const source = readFileSync(entry.path, 'utf8')
      expect(
        source.includes('describe('),
        `${entry.path} must contain vitest describe blocks`,
      ).toBe(true)
      const tests = countTests(source)
      expect(tests, `${entry.path} must contain at least one it()`).toBeGreaterThan(0)
      if (entry.minTests !== undefined) {
        expect(
          tests,
          `${entry.path} regressed below minimum ${entry.minTests} tests (found ${tests})`,
        ).toBeGreaterThanOrEqual(entry.minTests)
      }
    })
  }
})
