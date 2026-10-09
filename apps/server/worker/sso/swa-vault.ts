// SWA password vault: each member's credentials for the downstream application are stored as a
// KEK envelope in sso_connections.attribute_mapping._swaCredentials[userId]. The plaintext binds
// connection and user, so an envelope copied to another slot is rejected on read.

import { createTenantDb, schema } from '@xid-kit/db'
import { and, eq } from 'drizzle-orm'
import * as v from 'valibot'
import { AppError } from '../lib/errors'
import type { TenantVar } from '../lib/types'
import { SWA_CREDENTIALS_KEY } from './legacy-config'
import { isStoredEnvelope, openLegacySecret, sealLegacySecret } from './legacy-secret-envelope'
import type { LegacyConnection } from './legacy-shared'

export type SwaCredential = { username: string; password: string }

const SAVE_ATTEMPTS = 3

const sealedCredentialSchema = v.object({
  v: v.literal(1),
  connectionId: v.string(),
  userId: v.string(),
  username: v.string(),
  password: v.string(),
})

function credentialEnvelopes(
  mapping: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const value = mapping?.[SWA_CREDENTIALS_KEY]
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {}
}

export async function readSwaCredential(
  env: { KEK: string },
  connection: LegacyConnection,
  userId: string,
): Promise<SwaCredential | null> {
  const envelope = credentialEnvelopes(connection.attributeMapping)[userId]
  if (!isStoredEnvelope(envelope)) return null
  const plaintext = await openLegacySecret(env, envelope)
  let decoded: unknown
  try {
    decoded = JSON.parse(plaintext)
  } catch (cause) {
    throw new AppError('server_error', { cause, longMessage: 'swa_credential_unreadable' })
  }
  const parsed = v.safeParse(sealedCredentialSchema, decoded)
  if (
    !parsed.success ||
    parsed.output.connectionId !== connection.id ||
    parsed.output.userId !== userId
  ) {
    throw new AppError('server_error', { longMessage: 'swa_credential_binding_mismatch' })
  }
  return { username: parsed.output.username, password: parsed.output.password }
}

// Writes (or with `credential: null` removes) one member's entry. The row is updated with a
// compare-and-swap on updated_at so concurrent saves by different members cannot drop each other.
export async function saveSwaCredential(input: {
  env: Env
  tenant: TenantVar
  connectionId: string
  userId: string
  credential: SwaCredential | null
}): Promise<void> {
  const { env, tenant, connectionId, userId, credential } = input
  const db = createTenantDb(env.DB, tenant)
  for (let attempt = 0; attempt < SAVE_ATTEMPTS; attempt++) {
    const row = await db.ssoConnections.findOne(eq(schema.ssoConnections.id, connectionId))
    if (!row || row.protocol !== 'swa' || row.status !== 'active') {
      throw new AppError('connection_not_found', { httpStatus: 404 })
    }
    const envelopes = credentialEnvelopes(row.attributeMapping)
    if (credential) {
      envelopes[userId] = await sealLegacySecret(
        env,
        JSON.stringify({ v: 1, connectionId, userId, ...credential }),
      )
    } else {
      delete envelopes[userId]
    }
    const mapping: Record<string, unknown> = {
      ...row.attributeMapping,
      [SWA_CREDENTIALS_KEY]: envelopes,
    }
    delete mapping['_swaVault']
    delete mapping['_swaVaultEnvelope']
    // Strictly increasing so a writer that read the old row can never match again.
    const updatedAt = new Date(Math.max(Date.now(), row.updatedAt.getTime() + 1))
    const updated = await db.ssoConnections.update(
      { attributeMapping: mapping, updatedAt },
      and(
        eq(schema.ssoConnections.id, connectionId),
        eq(schema.ssoConnections.updatedAt, row.updatedAt),
      ),
    )
    if (updated.length > 0) return
  }
  throw new AppError('conflict')
}
