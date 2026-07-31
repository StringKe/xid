// client 认证辅助:client_secret_basic / client_secret_post / private_key_jwt / none+PKCE。
// 见 oidc-oauth rule / docs/design/03-oidc-oauth.md 客户端认证表。
// 铁律:TenantContext 从 c.get('tenant') 取;D1 查询走 @xid-kit/db 租户查询层;
//        client_secret 哈希比较,不存明文。

import { eq } from 'drizzle-orm'
import { createTenantDb, schema } from '@xid-kit/db'
import type { Result } from '@xid-kit/types'
import type { Context } from 'hono'
import type { XidHonoEnv } from '../../lib/types'
import {
  authenticateClient as authenticateOidcClient,
  extractClientCredentials,
} from '../../oidc/client-auth'
import {
  storedClientPolicy,
  validateClientRegistrationPolicy,
} from '../../oidc/client-registration-policy'

export type AuthenticatedClient = {
  clientId: string
  clientType: string
  allowedGrantTypes: string[]
  allowedScopes: string[]
  requirePkce: boolean
  dpopBoundAccessTokens: boolean
  accessTokenTtlSec: number | null
  idTokenSignedAlg: string
  redirectUris: string[]
  firstParty: boolean
}

export type ClientAuthOptions = {
  requireConfidential?: boolean
}

type ClientRow = typeof schema.applications.$inferSelect

export type ClientAuthError = {
  message: string
  code: 'invalid_client' | 'invalid_request' | 'server_error'
  httpStatus: 400 | 401 | 500
  basicChallenge: boolean
}

function rowToClient(row: ClientRow): AuthenticatedClient {
  return {
    clientId: row.clientId,
    clientType: row.clientType,
    allowedGrantTypes: row.allowedGrantTypes,
    allowedScopes: row.allowedScopes,
    requirePkce: row.requirePkce,
    dpopBoundAccessTokens: row.dpopBoundAccessTokens,
    accessTokenTtlSec: row.accessTokenTtlSec,
    idTokenSignedAlg: row.idTokenSignedAlg,
    redirectUris: row.redirectUris,
    firstParty: row.firstParty,
  }
}

function clientErr(
  message: string,
  input: Partial<Omit<ClientAuthError, 'message'>> = {},
): Result<never, ClientAuthError> {
  return {
    ok: false,
    error: {
      message,
      code: input.code ?? 'invalid_client',
      httpStatus: input.httpStatus ?? 401,
      basicChallenge: input.basicChallenge ?? false,
    },
  }
}

async function readCredentialForm(
  c: Context<XidHonoEnv>,
): Promise<Record<string, string | undefined>> {
  try {
    const form = await c.req.formData()
    return {
      client_id: stringFormValue(form.get('client_id')),
      client_secret: stringFormValue(form.get('client_secret')),
      client_assertion_type: stringFormValue(form.get('client_assertion_type')),
      client_assertion: stringFormValue(form.get('client_assertion')),
    }
  } catch {
    return {}
  }
}

function stringFormValue(value: FormDataEntryValue | null): string | undefined {
  return typeof value === 'string' ? value : undefined
}

// 主认证函数:按 token_endpoint_auth_method 分支认证。
// requireConfidential=true 时拒绝 public client(none 方法)。
export async function authenticateClient(
  c: Context<XidHonoEnv>,
  opts: ClientAuthOptions = {},
): Promise<Result<AuthenticatedClient, ClientAuthError>> {
  const ctx = c.get('tenant')
  const db = createTenantDb(c.env.DB, ctx)
  const creds = extractClientCredentials(c.req.header('authorization'), await readCredentialForm(c))
  const clientId = creds.basic?.clientId ?? creds.postClientId
  if (!clientId) return clientErr('client_id missing', { basicChallenge: true })

  const row = await db.applications.findOne(eq(schema.applications.clientId, clientId))
  if (!row) return clientErr('client not found', { basicChallenge: true })
  if (row.status !== 'active') return clientErr('client inactive', { basicChallenge: true })
  if (validateClientRegistrationPolicy(storedClientPolicy(row))) {
    return clientErr('client registration invalid', { basicChallenge: true })
  }

  if (opts.requireConfidential && row.tokenEndpointAuthMethod === 'none') {
    return clientErr('confidential client required', { basicChallenge: true })
  }
  const authenticated = await authenticateOidcClient({
    c,
    client: row,
    creds,
    ctx,
    tokenEndpoint: `${ctx.issuer}/token`,
    now: Math.floor(Date.now() / 1000),
  })
  if (!authenticated.ok) {
    if (authenticated.error.code === 'server_error') {
      return clientErr(authenticated.error.message, {
        code: 'server_error',
        httpStatus: 500,
      })
    }
    return clientErr(authenticated.error.message, {
      code: authenticated.error.code === 'invalid_request' ? 'invalid_request' : 'invalid_client',
      httpStatus: authenticated.error.httpStatus === 400 ? 400 : 401,
      basicChallenge: authenticated.error.meta?.paramName === 'Basic',
    })
  }
  return { ok: true, value: rowToClient(row) }
}
