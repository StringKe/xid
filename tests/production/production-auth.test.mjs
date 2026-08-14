import { afterEach, describe, expect, it } from 'vitest'
import {
  d1,
  productionBaseUrl,
  productionSurfaceBaseUrl,
  productionTenantBaseUrl,
  productionWildcardProbeBaseUrl,
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

  it('resolves isolated Worker origins and defaults each one to production', () => {
    expect(productionSurfaceBaseUrl('XID_PRODUCTION_SITE_BASE_URL', {})).toBe('https://xid.dev')
    expect(
      productionSurfaceBaseUrl('XID_PRODUCTION_SITE_BASE_URL', {
        XID_PRODUCTION_SITE_BASE_URL: 'https://site-preview.example/',
      }),
    ).toBe('https://site-preview.example')
    expect(
      productionSurfaceBaseUrl('XID_PRODUCTION_CONSOLE_BASE_URL', {
        XID_PRODUCTION_CONSOLE_BASE_URL: 'http://127.0.0.1:8788',
      }),
    ).toBe('http://127.0.0.1:8788')
    expect(
      productionSurfaceBaseUrl('XID_PRODUCTION_CORE_BASE_URL', {
        XID_PRODUCTION_CORE_BASE_URL: 'https://core-preview.example',
      }),
    ).toBe('https://core-preview.example')
    expect(productionTenantBaseUrl({})).toBe('https://default.xid.dev')
    expect(
      productionTenantBaseUrl({
        XID_PRODUCTION_TENANT_BASE_URL: 'https://tenant-preview.example/',
      }),
    ).toBe('https://tenant-preview.example')
  })

  it('rejects surface URLs that are not HTTP origins', () => {
    for (const value of [
      'xid.dev',
      'ftp://xid.dev',
      'https://user@example.com',
      'https://xid.dev/path',
      'https://xid.dev?preview=1',
      'https://xid.dev#preview',
    ]) {
      expect(() =>
        productionSurfaceBaseUrl('XID_PRODUCTION_SITE_BASE_URL', {
          XID_PRODUCTION_SITE_BASE_URL: value,
        }),
      ).toThrow('XID_PRODUCTION_SITE_BASE_URL must be an absolute HTTP(S) origin')
    }
  })

  it('derives a unique wildcard probe origin from the tenant DNS suffix', () => {
    expect(productionWildcardProbeBaseUrl({}, '123e4567-e89b-12d3-a456-426614174000')).toBe(
      'https://xid-preflight-123e4567e89b12d3a456426614174000.xid.dev',
    )
    expect(
      productionWildcardProbeBaseUrl(
        {
          XID_PRODUCTION_TENANT_BASE_URL: 'http://default.localhost.test:8787',
        },
        'probe-1',
      ),
    ).toBe('http://xid-preflight-probe1.localhost.test:8787')
  })

  it('rejects a non-DNS wildcard probe target or an empty nonce', () => {
    expect(() =>
      productionWildcardProbeBaseUrl(
        { XID_PRODUCTION_TENANT_BASE_URL: 'http://127.0.0.1:8787' },
        'probe-1',
      ),
    ).toThrow('XID_PRODUCTION_TENANT_BASE_URL must use a DNS hostname')
    expect(() => productionWildcardProbeBaseUrl({}, '---')).toThrow(
      'wildcard route probe nonce must contain a letter or digit',
    )
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

  it('retries a transient Cloudflare D1 authorization response', async () => {
    let attempts = 0
    await expect(
      d1('SELECT 1', 'retry D1 command', {
        runCommand: async () => {
          attempts += 1
          if (attempts === 1) {
            throw new Error('Cloudflare API failed: not authorized [code: 7403]')
          }
          return '[{"success":true,"results":[{"ok":1}]}]'
        },
      }),
    ).resolves.toEqual([{ ok: 1 }])
    expect(attempts).toBe(2)
  })

  it('does not retry an unrelated D1 failure', async () => {
    let attempts = 0
    await expect(
      d1('SELECT 1', 'failed D1 command', {
        runCommand: async () => {
          attempts += 1
          throw new Error('D1 query failed')
        },
      }),
    ).rejects.toThrow('D1 query failed')
    expect(attempts).toBe(1)
  })
})
