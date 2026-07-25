import { afterEach, describe, expect, it } from 'vitest'
import {
  d1,
  productionBaseUrl,
  productionD1Args,
  workerFilter,
  dbBinding,
} from './harness/production-auth.mjs'
import {
  VERIFIED_WRANGLER_CONFIG_PATH,
  verifiedWranglerConfigArgs,
} from '../../apps/server/scripts/production-target.mjs'

const targetOverrideNames = ['XID_PRODUCTION_DB_BINDING', 'XID_PRODUCTION_WORKER_FILTER']
const originalTargetOverrides = Object.fromEntries(
  targetOverrideNames.map((name) => [name, process.env[name]]),
)

afterEach(() => {
  for (const name of targetOverrideNames) {
    const value = originalTargetOverrides[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

describe('production auth D1 target', () => {
  it('rejects production host overrides', () => {
    expect(() => productionBaseUrl({ XID_PRODUCTION_BASE_URL: 'https://example.invalid' })).toThrow(
      'production base URL override is forbidden; use https://xid.dev',
    )
    expect(productionBaseUrl({})).toBe('https://xid.dev')
  })

  it('uses the verified production Worker, DB binding and wrangler config', () => {
    process.env.XID_PRODUCTION_DB_BINDING = 'other-db'
    process.env.XID_PRODUCTION_WORKER_FILTER = 'other-worker'

    expect(dbBinding).toBe('DB')
    expect(workerFilter).toBe('@xid-kit/server')
    expect(productionD1Args('SELECT 1')).toEqual([
      '--filter',
      '@xid-kit/server',
      'exec',
      'wrangler',
      'd1',
      'execute',
      'DB',
      '--remote',
      '--command',
      'SELECT 1',
      '--json',
      ...verifiedWranglerConfigArgs(),
    ])
    expect(verifiedWranglerConfigArgs()).toEqual(['--config', VERIFIED_WRANGLER_CONFIG_PATH])
  })

  it('passes only the fixed command arguments to the injected runner', async () => {
    let captured
    await expect(
      d1('SELECT 1', 'test D1 command', {
        runCommand: async (command, args) => {
          captured = { command, args }
          return '[{"success":true,"results":[]}]'
        },
      }),
    ).resolves.toEqual([])

    expect(captured).toEqual({ command: 'pnpm', args: productionD1Args('SELECT 1') })
  })
})
