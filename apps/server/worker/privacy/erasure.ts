import {
  enqueuePersistedPlatformAudit,
  preparePlatformAuditOutboxInsert,
} from '../platform/audit-outbox'
import { sessionDoRevoke, sessionDoRevokeAll } from '../lib/session'
import { PRIVACY_PAGE_SIZE } from './constants'
import {
  preparePrivacyErasureAtomicGuard,
  requirePrivacyErasureEligibility,
} from './erasure-eligibility'

type ExportObjectRow = {
  id: string
  storageKey: string
}

type ImpersonationSessionRow = {
  id: string
  userId: string
}

type UserScopedEraseTable =
  | 'authorization_codes'
  | 'backup_codes'
  | 'directory_users'
  | 'gdpr_consents'
  | 'manager_assignments'
  | 'memberships'
  | 'metering_outbox'
  | 'mfa_factors'
  | 'oauth_consents'
  | 'passkey_credentials'
  | 'password_history'
  | 'password_reset_tokens'
  | 'passwords'
  | 'refresh_tokens'
  | 'saml_session_bindings'
  | 'sessions'
  | 'trusted_devices'
  | 'user_emails'
  | 'user_grants'
  | 'user_identities'
  | 'user_phones'
  | 'verification_tokens'

async function deletePriorExportObjects(env: Env, tenantId: string, userId: string): Promise<void> {
  let cursor = ''
  while (true) {
    const rows = (
      await env.DB.prepare(
        `SELECT id, storage_key AS storageKey
           FROM privacy_requests
          WHERE tenant_id = ? AND user_id = ? AND request_type = 'export'
            AND storage_key IS NOT NULL AND id > ?
          ORDER BY id
          LIMIT ?`,
      )
        .bind(tenantId, userId, cursor, PRIVACY_PAGE_SIZE)
        .all<ExportObjectRow>()
    ).results
    if (rows.length === 0) return
    await env.STORAGE.delete(rows.map((row) => row.storageKey))
    cursor = rows[rows.length - 1]?.id ?? cursor
    if (rows.length < PRIVACY_PAGE_SIZE) return
  }
}

async function revokeImpersonationSessions(
  env: Env,
  tenantId: string,
  impersonatorUserId: string,
): Promise<void> {
  let cursor = ''
  while (true) {
    const rows = (
      await env.DB.prepare(
        `SELECT id, user_id AS userId
           FROM sessions
          WHERE tenant_id = ? AND impersonator_user_id = ? AND id > ?
          ORDER BY id
          LIMIT ?`,
      )
        .bind(tenantId, impersonatorUserId, cursor, PRIVACY_PAGE_SIZE)
        .all<ImpersonationSessionRow>()
    ).results
    if (rows.length === 0) return
    for (const row of rows) {
      await sessionDoRevoke(env, row.userId, row.id)
    }
    cursor = rows[rows.length - 1]?.id ?? cursor
    if (rows.length < PRIVACY_PAGE_SIZE) return
  }
}

function deleteByUser(
  env: Env,
  table: UserScopedEraseTable,
  tenantId: string,
  userId: string,
): D1PreparedStatement {
  return env.DB.prepare(`DELETE FROM ${table} WHERE tenant_id = ? AND user_id = ?`).bind(
    tenantId,
    userId,
  )
}

export async function completePrivacyErasure(
  env: Env,
  input: { requestId: string; tenantId: string; userId: string; now?: number },
): Promise<void> {
  const now = input.now ?? Date.now()

  // Scheduling checks the same rule, but roles can change during the 30-day grace period.
  await requirePrivacyErasureEligibility(env, input.tenantId, input.userId)

  // SessionDO is the immediate revocation source. If it is unavailable, leave D1 untouched and
  // retry instead of reporting a deletion whose existing session still works.
  await sessionDoRevokeAll(env, input.userId)
  await revokeImpersonationSessions(env, input.tenantId, input.userId)
  await deletePriorExportObjects(env, input.tenantId, input.userId)

  const audit = preparePlatformAuditOutboxInsert(
    env,
    {
      tenantId: input.tenantId,
      action: 'user.erasure_completed',
      payload: { targetType: 'user', targetId: input.userId },
      ts: now,
    },
    now,
  )

  const statements: D1PreparedStatement[] = [
    preparePrivacyErasureAtomicGuard(env, input),
    // Existing access JWTs remain cryptographically valid until exp. Persist their jti in the
    // denylist before deleting issuance metadata so erasure revokes them immediately.
    env.DB.prepare(
      `INSERT OR IGNORE INTO access_token_revocations (
         id, tenant_id, jti, client_id, subject, expires_at, revoked_at, created_at
       )
       SELECT lower(hex(randomblob(16))), tenant_id, jti, client_id, subject, expires_at, ?, ?
         FROM access_token_issuances
        WHERE tenant_id = ? AND subject = ? AND expires_at > ?`,
    ).bind(now, now, input.tenantId, input.userId, now),
    env.DB.prepare(
      `DELETE FROM directory_group_members
        WHERE tenant_id = ?
          AND directory_user_id IN (
            SELECT id FROM directory_users WHERE tenant_id = ? AND user_id = ?
          )`,
    ).bind(input.tenantId, input.tenantId, input.userId),
    env.DB.prepare(
      `UPDATE memberships
          SET invited_by_user_id = NULL, updated_at = ?
        WHERE tenant_id = ? AND invited_by_user_id = ?`,
    ).bind(now, input.tenantId, input.userId),
    env.DB.prepare(
      `UPDATE invitations
          SET invited_by_user_id = CASE WHEN invited_by_user_id = ? THEN NULL ELSE invited_by_user_id END,
              accepted_by_user_id = CASE WHEN accepted_by_user_id = ? THEN NULL ELSE accepted_by_user_id END,
              email_claim_user_id = CASE
                WHEN email_claim_user_id = ? THEN NULL ELSE email_claim_user_id
              END,
              displaced_email_id = CASE
                WHEN displaced_user_id = ? THEN NULL ELSE displaced_email_id
              END,
              displaced_user_id = CASE
                WHEN displaced_user_id = ? THEN NULL ELSE displaced_user_id
              END,
              email_claim_token_hash = CASE
                WHEN email_claim_user_id = ? THEN NULL ELSE email_claim_token_hash
              END,
              email_claim_email_hash = CASE
                WHEN email_claim_user_id = ? THEN NULL ELSE email_claim_email_hash
              END,
              email_claim_recovery_hash = CASE
                WHEN email_claim_user_id = ? THEN NULL ELSE email_claim_recovery_hash
              END,
              email_claim_consumption_id = CASE
                WHEN email_claim_user_id = ? THEN NULL ELSE email_claim_consumption_id
              END,
              email_claim_session_id = CASE
                WHEN email_claim_user_id = ? THEN NULL ELSE email_claim_session_id
              END,
              email_claim_session_reserved_at = CASE
                WHEN email_claim_user_id = ? THEN NULL ELSE email_claim_session_reserved_at
              END,
              email_claim_finalization_id = CASE
                WHEN email_claim_user_id = ? THEN NULL ELSE email_claim_finalization_id
              END,
              email = CASE
                WHEN accepted_by_user_id = ? OR email_claim_user_id = ?
                THEN 'erased-' || lower(hex(randomblob(16))) || '@invalid.invalid'
                ELSE email
              END,
              status = CASE
                WHEN email_claim_user_id = ? AND status IN ('pending', 'claim_verified')
                THEN 'revoked'
                ELSE status
              END,
              updated_at = ?
        WHERE tenant_id = ?
          AND (
            invited_by_user_id = ?
            OR accepted_by_user_id = ?
            OR email_claim_user_id = ?
            OR displaced_user_id = ?
          )`,
    ).bind(
      input.userId,
      input.userId,
      input.userId,
      input.userId,
      input.userId,
      input.userId,
      input.userId,
      input.userId,
      input.userId,
      input.userId,
      input.userId,
      input.userId,
      input.userId,
      input.userId,
      input.userId,
      now,
      input.tenantId,
      input.userId,
      input.userId,
      input.userId,
      input.userId,
    ),
    env.DB.prepare(
      `UPDATE users
          SET merged_into_user_id = NULL, updated_at = ?
        WHERE tenant_id = ? AND merged_into_user_id = ?`,
    ).bind(now, input.tenantId, input.userId),
    deleteByUser(env, 'passwords', input.tenantId, input.userId),
    deleteByUser(env, 'password_history', input.tenantId, input.userId),
    deleteByUser(env, 'password_reset_tokens', input.tenantId, input.userId),
    deleteByUser(env, 'verification_tokens', input.tenantId, input.userId),
    deleteByUser(env, 'passkey_credentials', input.tenantId, input.userId),
    deleteByUser(env, 'mfa_factors', input.tenantId, input.userId),
    deleteByUser(env, 'backup_codes', input.tenantId, input.userId),
    deleteByUser(env, 'trusted_devices', input.tenantId, input.userId),
    env.DB.prepare(
      `DELETE FROM sessions
        WHERE tenant_id = ? AND (user_id = ? OR impersonator_user_id = ?)`,
    ).bind(input.tenantId, input.userId, input.userId),
    deleteByUser(env, 'user_emails', input.tenantId, input.userId),
    deleteByUser(env, 'user_phones', input.tenantId, input.userId),
    deleteByUser(env, 'user_identities', input.tenantId, input.userId),
    deleteByUser(env, 'gdpr_consents', input.tenantId, input.userId),
    deleteByUser(env, 'memberships', input.tenantId, input.userId),
    deleteByUser(env, 'user_grants', input.tenantId, input.userId),
    deleteByUser(env, 'manager_assignments', input.tenantId, input.userId),
    deleteByUser(env, 'authorization_codes', input.tenantId, input.userId),
    deleteByUser(env, 'refresh_tokens', input.tenantId, input.userId),
    deleteByUser(env, 'oauth_consents', input.tenantId, input.userId),
    deleteByUser(env, 'directory_users', input.tenantId, input.userId),
    deleteByUser(env, 'saml_session_bindings', input.tenantId, input.userId),
    deleteByUser(env, 'metering_outbox', input.tenantId, input.userId),
    env.DB.prepare(`DELETE FROM access_token_issuances WHERE tenant_id = ? AND subject = ?`).bind(
      input.tenantId,
      input.userId,
    ),
    env.DB.prepare(
      `DELETE FROM scim_target_resources
        WHERE tenant_id = ? AND resource_type = 'User' AND local_resource_id = ?`,
    ).bind(input.tenantId, input.userId),
    env.DB.prepare(
      `UPDATE privacy_requests
          SET status = 'expired', storage_key = NULL, content_type = NULL, available_at = NULL,
              error_code = NULL, updated_at = ?
        WHERE tenant_id = ? AND user_id = ? AND request_type = 'export'
          AND status <> 'canceled'`,
    ).bind(now, input.tenantId, input.userId),
    env.DB.prepare(
      `UPDATE users
          SET username = NULL,
              external_id = NULL,
              primary_email_id = NULL,
              pending_email = NULL,
              primary_phone_id = NULL,
              first_name = NULL,
              last_name = NULL,
              display_name = NULL,
              avatar_url = NULL,
              locale = NULL,
              timezone = NULL,
              public_metadata = '{}',
              private_metadata = '{}',
              unsafe_metadata = '{}',
              custom_attributes = '{}',
              status = 'deleted',
              password_change_required = 0,
              is_new_user = 0,
              profile_completion_status = 'erased',
              lockout_until = NULL,
              failed_login_count = 0,
              last_login_at = NULL,
              merged_into_user_id = NULL,
              provisioned_by = NULL,
              deleted_at = COALESCE(deleted_at, ?),
              erased_at = ?,
              updated_at = ?
        WHERE tenant_id = ? AND id = ? AND erased_at IS NULL`,
    ).bind(now, now, now, input.tenantId, input.userId),
    env.DB.prepare(
      `UPDATE privacy_requests
          SET status = 'completed', processing_started_at = NULL, completed_at = ?,
              error_code = NULL, updated_at = ?
        WHERE id = ? AND tenant_id = ? AND user_id = ? AND request_type = 'delete'
          AND status = 'processing'`,
    ).bind(now, now, input.requestId, input.tenantId, input.userId),
    audit.statement,
  ]

  const results = await env.DB.batch(statements)
  const requestResult = results[results.length - 2]
  if ((requestResult?.meta.changes ?? 0) !== 1) {
    throw new Error('privacy_erasure_state_transition_failed')
  }
  await enqueuePersistedPlatformAudit(env, audit)
}
