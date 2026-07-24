// /device_authorization - RFC8628 Device Authorization Grant
// device_code / user_code 存 DeviceFlowStore DO,含 interval / expires_in。
// 错误形状:RFC8628 3.5,invalid_client 401 + WWW-Authenticate,其余 400 { error }。
// 见 oidc-oauth rule / docs/design/03-oidc-oauth.md endpoint 表。
// 铁律:TenantContext 从 c.get('tenant') 取;DO name=tenantId。

import { Hono } from 'hono'
import * as v from 'valibot'
import { base64UrlEncode } from '@xid-kit/crypto'
import type { XidHonoEnv } from '../lib/types'
import { AppError } from '../lib/errors'
import { authenticateClient } from './lib/client-auth'
import type { AuthenticatedClient } from './lib/client-auth'
import { DEVICE_CODE_POLL_INTERVAL_SEC, DEVICE_CODE_TTL_SEC } from '../lib/ttl'
import {
  BASIC_AUTH_CHALLENGE,
  findDisallowedScope,
  oauthError,
  oauthInvalidRequest,
  tokenJson,
} from '../oidc/shared'

const app = new Hono<XidHonoEnv>()

// 形状层:scope 可选 string;scope 白名单与 grant 授权仍由 validateScopes(domain 层)判定。
const deviceFormSchema = v.object({ scope: v.optional(v.string()) })

const DEVICE_CODE_BYTES = 32
const USER_CODE_CHARSET = 'BCDFGHJKLMNPQRSTVWXZ'
const USER_CODE_LEN = 8

function generateDeviceCode(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(DEVICE_CODE_BYTES)))
}

function generateUserCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(USER_CODE_LEN))
  let code = ''
  for (let i = 0; i < USER_CODE_LEN; i++) {
    code += USER_CODE_CHARSET[bytes[i]! % USER_CODE_CHARSET.length]
  }
  return code
}

function deviceDoStub(env: Env, tenantId: string): DurableObjectStub {
  return env.DEVICE_FLOW.get(env.DEVICE_FLOW.idFromName(tenantId))
}

// RFC8628 3.5 错误码:scope 越权 invalid_scope,grant 未授权 unauthorized_client。
type ScopeError = { code: 'invalid_scope' | 'unauthorized_client'; description: string }

function validateScopes(client: AuthenticatedClient, requestedScopes: string[]): ScopeError | null {
  const disallowed = findDisallowedScope(client.allowedScopes, requestedScopes)
  if (disallowed) {
    return {
      code: 'invalid_scope',
      description: `scope "${disallowed}" not allowed for this client`,
    }
  }
  if (!client.allowedGrantTypes.includes('urn:ietf:params:oauth:grant-type:device_code')) {
    return {
      code: 'unauthorized_client',
      description: 'device_code grant not allowed for this client',
    }
  }
  return null
}

// DeviceFlowStore /create 的成功契约是 200 + { created: true }。只看 res.ok 会把任何 2xx
// 空响应或 { created: false } 当成写入成功,于是发出一个 DO 侧根本不存在的 device_code:
// 用户在 /activate 授权后设备永远拿不到 token。无法证明写入成功就必须报错。
async function assertDeviceGrantCreated(res: Response): Promise<void> {
  if (res.status !== 200) {
    throw new AppError('server_error', { longMessage: 'Failed to create device grant' })
  }
  let body: unknown
  try {
    body = await res.json()
  } catch (error) {
    throw new AppError('server_error', {
      longMessage: 'Failed to create device grant',
      cause: error,
    })
  }
  if (!body || typeof body !== 'object' || (body as Record<string, unknown>)['created'] !== true) {
    throw new AppError('server_error', { longMessage: 'Failed to create device grant' })
  }
}

async function storeDeviceGrant(
  env: Env,
  opts: {
    deviceCode: string
    userCode: string
    clientId: string
    tenantId: string
    scopes: string[]
    expiresAt: number
  },
): Promise<void> {
  const stub = deviceDoStub(env, opts.tenantId)
  const res = await stub.fetch('https://device-flow/create', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...opts, interval: DEVICE_CODE_POLL_INTERVAL_SEC }),
  })
  await assertDeviceGrantCreated(res)
}

app.post('/device_authorization', async (c) => {
  const ctx = c.get('tenant')
  const clientResult = await authenticateClient(c)
  if (!clientResult.ok) {
    return oauthError(c, {
      status: 401,
      error: 'invalid_client',
      description: clientResult.error.message,
      extraHeaders: { 'www-authenticate': BASIC_AUTH_CHALLENGE },
    })
  }

  const client = clientResult.value
  const form = await c.req.formData()
  const parsed = v.safeParse(deviceFormSchema, { scope: form.get('scope') ?? undefined })
  if (!parsed.success) return oauthInvalidRequest(c, parsed.issues)
  const requestedScopes = (parsed.output.scope ?? 'openid').split(' ').filter(Boolean)

  const scopeError = validateScopes(client, requestedScopes)
  if (scopeError) {
    return oauthError(c, {
      status: 400,
      error: scopeError.code,
      description: scopeError.description,
    })
  }

  const deviceCode = generateDeviceCode()
  const userCode = generateUserCode()
  const expiresAt = Date.now() + DEVICE_CODE_TTL_SEC * 1000

  await storeDeviceGrant(c.env, {
    deviceCode,
    userCode,
    clientId: client.clientId,
    tenantId: ctx.tenantId,
    scopes: requestedScopes,
    expiresAt,
  })

  const verificationUri = `${ctx.issuer}/activate`
  return tokenJson(c, {
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: verificationUri,
    verification_uri_complete: `${verificationUri}?user_code=${userCode}`,
    expires_in: DEVICE_CODE_TTL_SEC,
    interval: DEVICE_CODE_POLL_INTERVAL_SEC,
  })
})

export function registerDevice(parent: Hono<XidHonoEnv>): void {
  parent.route('/', app)
}
