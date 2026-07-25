// SWA (Secure Web Authentication) and password vaulting (enterprise legacy protocol).
// Local baseline: form POST authenticate against vaulted app credentials stored per connection.
// Vault secrets use envelope encryption in attributeMapping._swaVaultEnvelope; plaintext hashes are not stored.

import { envelopeDecrypt, envelopeEncrypt, sha256Hex } from '@xid-kit/crypto'
import { createTenantDb, schema } from '@xid-kit/db'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { Context } from 'hono'
import * as v from 'valibot'
import { AppError } from '../lib/errors'
import { decodeKek } from '../oidc/shared'
import type { XidHonoEnv } from '../lib/types'
import { readJsonBody } from '../lib/validate'
import { isDevOrTestEnvironment } from '../test-harness/dev-gate'
import { fakeSwaAuthenticate } from '../test-harness/fake-swa'
import { requireApiKeyOrOrgManager } from '../v1/shared'
import {
  completeLegacyLogin,
  constantTimeEqual,
  legacyConfig,
  resolveLegacyConnection,
  type LegacyProfile,
} from './legacy-shared'
import { resolveSsoConnectionTenant, withTenant } from './tenant'

// SWA 认证 body(JSON 与 form 双通道同形状)。形状失败按 credentials_required 处理
// (凭证类端点不区分"形状错误"与"凭证缺失",见 anti-abuse rule),不走 validation_failed 422。
const swaAuthBodySchema = v.object({
  username: v.optional(v.string()),
  password: v.optional(v.string()),
  redirectAfterLogin: v.optional(v.string()),
})

type SwaAuthBody = v.InferOutput<typeof swaAuthBodySchema>

type VaultedCredential = {
  username: string
  passwordHash: string
  email?: string
  firstName?: string
  lastName?: string
}

type VaultEnvelope = {
  iv: string
  ciphertext: string
  tag: string
  kekVersion: number
}

function decodeEnvelopeField(value: string): Uint8Array {
  return Uint8Array.from(atob(value.replace(/\s/g, '')), (ch) => ch.charCodeAt(0))
}

async function readVaultFromEnvelope(
  c: Context<XidHonoEnv>,
  connection: typeof schema.ssoConnections.$inferSelect,
): Promise<Record<string, VaultedCredential>> {
  const mapping = connection.attributeMapping
  const envelope =
    mapping &&
    typeof mapping === 'object' &&
    mapping['_swaVaultEnvelope'] &&
    typeof mapping['_swaVaultEnvelope'] === 'object'
      ? (mapping['_swaVaultEnvelope'] as VaultEnvelope)
      : null
  if (!envelope) return readLegacyPlaintextVault(connection)

  const kekB64 = c.env.KEK
  if (!kekB64) throw new AppError('internal_error', { longMessage: 'kek_unavailable' })

  const decrypted = await envelopeDecrypt(
    {
      iv: decodeEnvelopeField(envelope.iv),
      ciphertext: decodeEnvelopeField(envelope.ciphertext),
      tag: decodeEnvelopeField(envelope.tag),
      kekVersion: envelope.kekVersion,
    },
    decodeKek(kekB64),
  )
  const parsed = JSON.parse(new TextDecoder().decode(decrypted)) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  return parsed as Record<string, VaultedCredential>
}

function readLegacyPlaintextVault(
  connection: typeof schema.ssoConnections.$inferSelect,
): Record<string, VaultedCredential> {
  const mapping = connection.attributeMapping
  const vault =
    mapping &&
    typeof mapping === 'object' &&
    mapping['_swaVault'] &&
    typeof mapping['_swaVault'] === 'object'
      ? (mapping['_swaVault'] as Record<string, VaultedCredential>)
      : {}
  return vault
}

async function readVault(
  c: Context<XidHonoEnv>,
  connection: typeof schema.ssoConnections.$inferSelect,
): Promise<Record<string, VaultedCredential>> {
  const mapping = connection.attributeMapping
  if (
    mapping &&
    typeof mapping === 'object' &&
    mapping['_swaVaultEnvelope'] &&
    typeof mapping['_swaVaultEnvelope'] === 'object'
  ) {
    return readVaultFromEnvelope(c, connection)
  }
  return readLegacyPlaintextVault(connection)
}

async function verifySwaCredentials(
  c: Context<XidHonoEnv>,
  connection: typeof schema.ssoConnections.$inferSelect,
  username: string,
  password: string,
): Promise<LegacyProfile | null> {
  const vault = await readVault(c, connection)
  const entry = vault[username]
  if (entry) {
    const hash = await sha256Hex(password)
    if (!constantTimeEqual(hash, entry.passwordHash)) return null
    return {
      idpId: entry.username,
      email: entry.email ?? (username.includes('@') ? username : null),
      emailVerified: Boolean(entry.email ?? username.includes('@')),
      firstName: entry.firstName ?? null,
      lastName: entry.lastName ?? null,
      groups: [],
      customAttributes: {
        protocol: 'swa',
        swaTargetUrl: legacyConfig(connection).swaTargetUrl ?? null,
      },
    }
  }

  if (isDevOrTestEnvironment(c.env)) {
    return fakeSwaAuthenticate(username, password)
  }

  return null
}

async function handleSwaAuthenticate(c: Context<XidHonoEnv>): Promise<Response> {
  const connectionId = c.req.param('connectionId')
  if (!connectionId) throw new AppError('invalid_request', { longMessage: 'connectionId required' })

  const contentType = c.req.header('content-type') ?? ''
  let body: SwaAuthBody
  if (contentType.includes('application/json')) {
    const json = await readJsonBody(c)
    const parsed = json.ok ? v.safeParse(swaAuthBodySchema, json.value) : null
    body = parsed?.success ? parsed.output : {}
  } else {
    const form = await c.req.parseBody()
    const parsed = v.safeParse(swaAuthBodySchema, {
      username: form['username'],
      password: form['password'],
      redirectAfterLogin: form['redirectAfterLogin'],
    })
    body = parsed.success ? parsed.output : {}
  }

  const username = body.username?.trim() ?? ''
  const password = body.password ?? ''
  if (!username || !password)
    throw new AppError('invalid_request', { longMessage: 'credentials_required' })

  const tenant = await resolveSsoConnectionTenant(c, connectionId)
  return withTenant(c, tenant, async () => {
    const connection = await resolveLegacyConnection(c, connectionId, 'swa')
    const profile = await verifySwaCredentials(c, connection, username, password)
    if (!profile) throw new AppError('invalid_credentials')
    return completeLegacyLogin({
      c,
      connection,
      profile,
      redirectAfterLogin: body.redirectAfterLogin,
      returnToOrigin: tenant.issuer.replace(/\/$/, ''),
    })
  })
}

// vault 写入 body。形状失败按 vault_credentials_required(同凭证模糊化),不走 validation_failed。
const vaultBodySchema = v.object({
  username: v.optional(v.string()),
  password: v.optional(v.string()),
  email: v.optional(v.string()),
  firstName: v.optional(v.string()),
  lastName: v.optional(v.string()),
})

async function handleSwaVault(c: Context<XidHonoEnv>): Promise<Response> {
  const connectionId = c.req.param('connectionId')
  if (!connectionId) throw new AppError('invalid_request', { longMessage: 'connectionId required' })

  const json = await readJsonBody(c)
  const parsed = json.ok ? v.safeParse(vaultBodySchema, json.value) : null
  const body = parsed?.success ? parsed.output : null
  const username = body?.username?.trim() ?? ''
  const password = body?.password ?? ''
  if (!username || !password)
    throw new AppError('invalid_request', { longMessage: 'vault_credentials_required' })

  const tenant = await resolveSsoConnectionTenant(c, connectionId)
  return withTenant(c, tenant, async () => {
    const connection = await resolveLegacyConnection(c, connectionId, 'swa')
    await requireApiKeyOrOrgManager(c, connection.orgId, 'connections:write')

    const kekB64 = c.env.KEK
    if (!kekB64) throw new AppError('internal_error', { longMessage: 'kek_unavailable' })

    const passwordHash = await sha256Hex(password)
    const vault = await readVault(c, connection)
    vault[username] = {
      username,
      passwordHash,
      email: body?.email,
      firstName: body?.firstName,
      lastName: body?.lastName,
    }

    const encrypted = await envelopeEncrypt(
      new TextEncoder().encode(JSON.stringify(vault)),
      decodeKek(kekB64),
      1,
    )
    const envelope: VaultEnvelope = {
      iv: btoa(String.fromCharCode(...encrypted.iv)),
      ciphertext: btoa(String.fromCharCode(...encrypted.ciphertext)),
      tag: btoa(String.fromCharCode(...encrypted.tag)),
      kekVersion: encrypted.kekVersion,
    }

    const db = createTenantDb(c.env.DB, tenant)
    const mapping: Record<string, unknown> = {
      ...(connection.attributeMapping ?? {}),
      _swaVaultEnvelope: envelope,
    }
    delete mapping['_swaVault']

    await db.ssoConnections.update(
      { attributeMapping: mapping },
      eq(schema.ssoConnections.id, connection.id),
    )

    return c.json(
      {
        stored: true,
        username,
        vaultCredentialRef: legacyConfig(connection).vaultCredentialRef ?? connection.id,
      },
      200,
    )
  })
}

const swa = new Hono<XidHonoEnv>()
swa.post('/:connectionId/authenticate', handleSwaAuthenticate)
swa.post('/:connectionId/vault', handleSwaVault)

export function registerSwaRoutes(app: Hono<XidHonoEnv>): void {
  app.route('/sso/swa', swa)
}
