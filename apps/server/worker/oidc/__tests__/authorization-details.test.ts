import { describe, it, expect } from 'vitest'
import type { Context } from 'hono'
import type { XidHonoEnv } from '../../lib/types'
import {
  authorizationDetailsResources,
  authorizationDetailsScopes,
  authorizationDetailsTypesSupported,
  parseAuthorizationDetails,
} from '../authorization-details'
import { buildTestTenant, makeEnv, makeFakeD1 } from './helpers'

async function ctxWithTenant(): Promise<Context<XidHonoEnv>> {
  const { ctx } = await buildTestTenant()
  return {
    env: makeEnv({
      DB: makeFakeD1({
        resource_servers: [
          {
            audience: 'https://api.example',
            tenant_id: ctx.tenantId,
            status: 'active',
            scopes: JSON.stringify(['read', 'write']),
          },
        ],
      }),
    }),
    get: (key: string) => (key === 'tenant' ? ctx : undefined),
  } as unknown as Context<XidHonoEnv>
}

describe('authorization-details', () => {
  it('advertises supported types', () => {
    expect(authorizationDetailsTypesSupported()).toContain('resource_access')
  })

  it('rejects invalid JSON payload', async () => {
    const result = await parseAuthorizationDetails(await ctxWithTenant(), '{not-json')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('invalid_authorization_details')
  })

  it('rejects unknown authorization_details type', async () => {
    const result = await parseAuthorizationDetails(
      await ctxWithTenant(),
      JSON.stringify([
        { type: 'payment_initiation', locations: ['https://api.example'], actions: ['read'] },
      ]),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('invalid_authorization_details')
  })

  it('rejects unsupported fields on resource_access', async () => {
    const result = await parseAuthorizationDetails(
      await ctxWithTenant(),
      JSON.stringify([
        {
          type: 'resource_access',
          locations: ['https://api.example'],
          actions: ['read'],
          extra: true,
        },
      ]),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('invalid_authorization_details')
  })

  it('accepts valid resource_access and derives resources/scopes', async () => {
    const parsed = await parseAuthorizationDetails(
      await ctxWithTenant(),
      JSON.stringify([
        {
          type: 'resource_access',
          locations: ['https://api.example'],
          actions: ['read', 'write'],
        },
      ]),
    )
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(authorizationDetailsResources(parsed.value)).toEqual(['https://api.example'])
      expect(authorizationDetailsScopes(parsed.value)).toEqual(['read', 'write'])
    }
  })

  it('rejects actions not allowed by resource audience', async () => {
    const result = await parseAuthorizationDetails(
      await ctxWithTenant(),
      JSON.stringify([
        { type: 'resource_access', locations: ['https://api.example'], actions: ['admin'] },
      ]),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('invalid_authorization_details')
  })

  it('rejects empty locations array', async () => {
    const result = await parseAuthorizationDetails(
      await ctxWithTenant(),
      JSON.stringify([{ type: 'resource_access', locations: [], actions: ['read'] }]),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('invalid_authorization_details')
  })
})
