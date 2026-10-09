// SWA password vault: each member's credentials for one downstream application live in
// swa_credentials as a KEK envelope. The sealed plaintext binds connection and user, so a row whose
// envelope was copied from another member is rejected on read.

import { createTenantDb, schema } from '@xid-kit/db'
import { and, eq } from 'drizzle-orm'
import * as v from 'valibot'
import { AppError } from '../lib/errors'
import type { TenantVar } from '../lib/types'
import { openLegacySecret, sealLegacySecret } from './legacy-secret-envelope'
import type { LegacyConnection } from './legacy-shared'

export type SwaCredential = { username: string; password: string }

type SwaCredentialRow = typeof schema.swaCredentials.$inferSelect

const sealedCredentialSchema = v.object({
  v: v.literal(1),
  connectionId: v.string(),
  userId: v.string(),
  username: v.string(),
  password: v.string(),
})

function rowKey(connectionId: string, userId: string) {
  return and(
    eq(schema.swaCredentials.connectionId, connectionId),
    eq(schema.swaCredentials.userId, userId),
  )
}

export async function openSwaCredential(
  env: { KEK: string },
  row: SwaCredentialRow,
): Promise<SwaCredential> {
  const plaintext = await openLegacySecret(env, {
    iv: row.secretIv,
    ciphertext: row.secretCiphertext,
    tag: row.secretTag,
    kekVersion: row.kekVersion,
  })
  let decoded: unknown
  try {
    decoded = JSON.parse(plaintext)
  } catch (cause) {
    throw new AppError('server_error', { cause, longMessage: 'swa_credential_unreadable' })
  }
  const parsed = v.safeParse(sealedCredentialSchema, decoded)
  if (
    !parsed.success ||
    parsed.output.connectionId !== row.connectionId ||
    parsed.output.userId !== row.userId
  ) {
    throw new AppError('server_error', { longMessage: 'swa_credential_binding_mismatch' })
  }
  return { username: parsed.output.username, password: parsed.output.password }
}

export async function readSwaCredential(
  env: Env,
  tenant: TenantVar,
  input: { connectionId: string; userId: string },
): Promise<SwaCredential | null> {
  const db = createTenantDb(env.DB, tenant)
  const row = await db.swaCredentials.findOne(rowKey(input.connectionId, input.userId))
  return row ? openSwaCredential(env, row) : null
}

// One row per (tenant, connection, user); concurrent saves resolve on the unique index.
export async function saveSwaCredential(input: {
  env: Env
  tenant: TenantVar
  connection: LegacyConnection
  userId: string
  credential: SwaCredential
}): Promise<void> {
  const { env, tenant, connection, userId, credential } = input
  const sealed = await sealLegacySecret(
    env,
    JSON.stringify({ v: 1, connectionId: connection.id, userId, ...credential }),
  )
  const now = Date.now()
  await env.DB.prepare(
    `INSERT INTO swa_credentials
       (id, tenant_id, org_id, connection_id, user_id, secret_iv, secret_ciphertext, secret_tag,
        kek_version, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)
     ON CONFLICT (tenant_id, connection_id, user_id) DO UPDATE SET
       org_id = excluded.org_id,
       secret_iv = excluded.secret_iv,
       secret_ciphertext = excluded.secret_ciphertext,
       secret_tag = excluded.secret_tag,
       kek_version = excluded.kek_version,
       updated_at = excluded.updated_at`,
  )
    .bind(
      crypto.randomUUID(),
      tenant.tenantId,
      connection.orgId,
      connection.id,
      userId,
      sealed.iv,
      sealed.ciphertext,
      sealed.tag,
      sealed.kekVersion,
      now,
    )
    .run()
}

export async function deleteSwaCredential(
  env: Env,
  tenant: TenantVar,
  input: { connectionId: string; userId: string },
): Promise<void> {
  const db = createTenantDb(env.DB, tenant)
  await db.swaCredentials.hardDelete(rowKey(input.connectionId, input.userId))
}
