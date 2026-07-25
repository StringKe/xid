import { describe, it, expect } from 'vitest'
import { hashRefreshToken, issueRefreshFamily } from '@xid-kit/protocol'
import { loadActiveSigner } from '../shared'
import {
  grantAuthorizationCode,
  grantClientCredentials,
  grantRefreshToken,
  revokeFamiliesForCode,
} from '../token-grants'
import { persistAuthorizationCodeRefresh } from '../token-issue'
import type { TokenContext } from '../token-issue'
import { buildTestTenant, makeEnv, makeFakeD1 } from './helpers'

function asContext(value: unknown) {
  return value as TokenContext['c']
}

async function makeGrantContext(over: Partial<TokenContext> = {}): Promise<TokenContext> {
  const { ctx, kekB64 } = await buildTestTenant()
  const signer = await loadActiveSigner(ctx, kekB64)
  const c = {
    env: makeEnv({ DB: makeFakeD1({}), KEK: kekB64 }),
    get: (key: string) => (key === 'tenant' ? ctx : undefined),
  }
  return {
    c: asContext(c),
    signer,
    client: {
      clientType: 'confidential',
      allowedScopes: ['openid', 'profile'],
      accessTokenTtlSec: 3600,
      requirePkce: false,
      clientId: 'cli_app',
      redirectUris: ['https://rp.example/cb'],
    } as TokenContext['client'],
    clientId: 'cli_app',
    dpopJkt: null,
    mtlsCertThumbprint: null,
    form: {},
    now: Math.floor(Date.now() / 1000),
    ...over,
  }
}

describe('grantClientCredentials', () => {
  it('rejects public clients', async () => {
    const tc = await makeGrantContext({
      client: { clientType: 'public', allowedScopes: ['openid'] } as TokenContext['client'],
    })
    const result = await grantClientCredentials(tc)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('invalid_client')
  })

  it('rejects scopes outside client allowlist', async () => {
    const tc = await makeGrantContext({ form: { scope: 'admin' } })
    const result = await grantClientCredentials(tc)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('invalid_scope')
  })

  it('issues access token for allowed scopes', async () => {
    const tc = await makeGrantContext({ form: { scope: 'openid profile' } })
    const result = await grantClientCredentials(tc)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value['token_type']).toBe('Bearer')
      expect(result.value['access_token']).toBeTypeOf('string')
      expect(result.value['scope']).toBe('openid profile')
    }
  })
})

describe('grantAuthorizationCode', () => {
  it('requires code parameter', async () => {
    const tc = await makeGrantContext()
    const result = await grantAuthorizationCode(tc)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('invalid_request')
  })

  it('rejects unknown or already consumed code', async () => {
    const tc = await makeGrantContext({ form: { code: 'missing_code' } })
    const result = await grantAuthorizationCode(tc)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('invalid_grant')
  })

  it('does not consume a code before client binding succeeds', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const capture = { inserts: [], updates: [] }
    const db = makeFakeD1(
      {
        authorization_codes: [
          {
            code: 'ac_bound_elsewhere',
            tenant_id: ctx.tenantId,
            client_id: 'other_client',
            user_id: 'user_1',
            redirect_uri: 'https://rp.example/cb',
            scope: 'openid',
            nonce: null,
            code_challenge: null,
            code_challenge_method: null,
            dpop_jkt: null,
            auth_time: new Date(),
            acr: null,
            amr: null,
            resource: null,
            authorization_details: null,
            active_org_id: null,
            project_grant_id: null,
            consumed_at: null,
            replay_detected_at: null,
            expires_at: new Date(Date.now() + 60_000),
            created_at: new Date(),
          },
        ],
      },
      capture,
    )
    const tc = await makeGrantContext({ form: { code: 'ac_bound_elsewhere' } })
    tc.c = asContext({
      env: makeEnv({ DB: db, KEK: kekB64 }),
      get: (key: string) => (key === 'tenant' ? ctx : undefined),
    })

    const result = await grantAuthorizationCode(tc)

    expect(result.ok).toBe(false)
    expect(capture.updates).toHaveLength(0)
  })

  it('uses a replay marker in the same conditional insert as the refresh record', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const issued = await issueRefreshFamily({
      tenantId: ctx.tenantId,
      userId: 'user_1',
      clientId: 'cli_app',
      scope: 'offline_access',
      jkt: null,
      now: 1_700_000_000,
      newId: 'rt_1',
      familyId: 'family_1',
    })
    let capturedSql = ''
    const db = {
      prepare: (sql: string) => {
        capturedSql = sql
        return { bind: () => ({ run: async () => ({ meta: { changes: 0 } }) }) }
      },
    } as unknown as D1Database
    const tc = await makeGrantContext()
    tc.c = asContext({
      env: makeEnv({ DB: db, KEK: kekB64 }),
      get: (key: string) => (key === 'tenant' ? ctx : undefined),
    })

    const persisted = await persistAuthorizationCodeRefresh(tc, issued.record, 'ac_replayed')

    expect(persisted).toBe(false)
    expect(capturedSql).toContain('replay_detected_at IS NULL')
    expect(capturedSql).toContain('authorization_code')
  })

  it('revokes only the replayed authorization code family with a successor fence', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const capture = { inserts: [], updates: [] }
    const tc = await makeGrantContext()
    tc.c = asContext({
      env: makeEnv({
        DB: makeFakeD1(
          {
            refresh_tokens: [
              {
                id: 'rt_initial',
                tenant_id: ctx.tenantId,
                authorization_code: 'ac_replayed',
                family_id: 'family_replayed',
              },
            ],
          },
          capture,
        ),
        KEK: kekB64,
      }),
      get: (key: string) => (key === 'tenant' ? ctx : undefined),
    })

    await revokeFamiliesForCode(tc, 'ac_replayed')

    const refreshUpdate = capture.updates.find((sql) => /update\s+refresh_tokens/iu.test(sql))
    expect(refreshUpdate).toContain('family_id')
    expect(refreshUpdate).toContain('family_revoked_at')
    expect(refreshUpdate).toMatch(/where[\s\S]+family_id\s+in/iu)
    expect(refreshUpdate).toMatch(/family_revoked_at\s+is\s+null/iu)
    const revocations = capture.inserts.filter(
      (entry) => entry.table === 'access_token_revocations',
    )
    expect(revocations).toHaveLength(2)
  })
})

describe('grantRefreshToken', () => {
  it('requires refresh_token parameter', async () => {
    const tc = await makeGrantContext()
    const result = await grantRefreshToken(tc)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('invalid_request')
  })

  it('rejects unknown refresh token hash', async () => {
    const tc = await makeGrantContext({ form: { refresh_token: 'rt_unknown' } })
    const result = await grantRefreshToken(tc)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('invalid_grant')
  })

  it('rejects public client refresh token without DPoP binding', async () => {
    const presented = 'rt_public_unbound'
    const tokenHash = await hashRefreshToken(presented)
    const { ctx, kekB64 } = await buildTestTenant()
    const tc = await makeGrantContext({
      client: { clientType: 'public', allowedScopes: ['openid'] } as TokenContext['client'],
      form: { refresh_token: presented },
    })
    const db = makeFakeD1({
      refresh_tokens: [
        {
          id: 'rt_1',
          tenant_id: ctx.tenantId,
          token_hash: tokenHash,
          family_id: 'fam_1',
          parent_token_id: null,
          user_id: 'u_1',
          client_id: 'cli_app',
          scope: 'openid',
          jkt: null,
          active_org_id: null,
          project_grant_id: null,
          resource: null,
          authorization_details: null,
          auth_time: null,
          acr: null,
          amr: null,
          revoked_at: null,
          expires_at: new Date(Date.now() + 60_000),
          absolute_expires_at: new Date(Date.now() + 60_000),
          created_at: new Date(),
        },
      ],
    })
    tc.c = asContext({
      env: makeEnv({ DB: db, KEK: kekB64 }),
      get: (key: string) => (key === 'tenant' ? ctx : undefined),
    })
    const result = await grantRefreshToken(tc)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain('DPoP-bound')
  })
})
