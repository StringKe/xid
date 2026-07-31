import { PRIVACY_EXPORT_TTL_MS, PRIVACY_PAGE_SIZE } from './constants'

const EXPORT_CONTENT_TYPE = 'application/json; charset=utf-8'
const EXPORT_SCHEMA_VERSION = 1

type ExportSection = {
  name: string
  sql: string
  params: readonly unknown[]
}

function exportSections(tenantId: string, userId: string): ExportSection[] {
  const scoped = [tenantId, userId] as const
  return [
    {
      name: 'profile',
      sql: `SELECT id, tenant_id, username, external_id, first_name, last_name, display_name,
                   avatar_url, locale, timezone, public_metadata, private_metadata, unsafe_metadata,
                   custom_attributes, status, provisioned_by, deleted_at, erased_at, created_at,
                   updated_at
              FROM users
             WHERE tenant_id = ? AND id = ?
             ORDER BY id`,
      params: scoped,
    },
    {
      name: 'emails',
      sql: `SELECT id, email, verified, verification_status, is_primary, verified_at,
                   created_at, updated_at
              FROM user_emails
             WHERE tenant_id = ? AND user_id = ?
             ORDER BY id`,
      params: scoped,
    },
    {
      name: 'phones',
      sql: `SELECT id, phone, verified, verification_status, is_primary, verified_at,
                   created_at, updated_at
              FROM user_phones
             WHERE tenant_id = ? AND user_id = ?
             ORDER BY id`,
      params: scoped,
    },
    {
      name: 'identities',
      sql: `SELECT id, identity_type, provider, provider_user_id, token_expires_at, scopes,
                   profile_raw, last_used_at, revoked_at, created_at, updated_at
              FROM user_identities
             WHERE tenant_id = ? AND user_id = ?
             ORDER BY id`,
      params: scoped,
    },
    {
      name: 'privacyConsents',
      sql: `SELECT id, consent_type, granted, source_ip, granted_at, created_at, updated_at
              FROM gdpr_consents
             WHERE tenant_id = ? AND user_id = ?
             ORDER BY id`,
      params: scoped,
    },
    {
      name: 'acceptedInvitations',
      sql: `SELECT id, org_id, email, role, invite_type, status, accepted_by_user_id,
                   expires_at, created_at, updated_at
              FROM invitations
             WHERE tenant_id = ? AND accepted_by_user_id = ?
             ORDER BY id`,
      params: scoped,
    },
    {
      name: 'memberships',
      sql: `SELECT id, org_id, role, membership_type, status, is_managed, joined_at,
                   created_at, updated_at
              FROM memberships
             WHERE tenant_id = ? AND user_id = ?
             ORDER BY id`,
      params: scoped,
    },
    {
      name: 'roleGrants',
      sql: `SELECT id, project_id, role_id, granted_via_grant_id, revoked_at, created_at, updated_at
              FROM user_grants
             WHERE tenant_id = ? AND user_id = ?
             ORDER BY id`,
      params: scoped,
    },
    {
      name: 'sessions',
      sql: `SELECT id, active_org_id, device_name, user_agent, ip, location, status, remember_me,
                   is_impersonation, impersonator_user_id, acr, amr, aal, authenticated_at,
                   last_active_at, expires_at, created_at
              FROM sessions
             WHERE tenant_id = ? AND user_id = ?
             ORDER BY id`,
      params: scoped,
    },
    {
      name: 'passwordMetadata',
      sql: `SELECT id, algo, breached, breach_checked_at, created_at, updated_at
              FROM passwords
             WHERE tenant_id = ? AND user_id = ?
             ORDER BY id`,
      params: scoped,
    },
    {
      name: 'passwordHistory',
      sql: `SELECT id, created_at
              FROM password_history
             WHERE tenant_id = ? AND user_id = ?
             ORDER BY id`,
      params: scoped,
    },
    {
      name: 'passkeys',
      sql: `SELECT id, cose_alg, transports, credential_device_type, backed_up, device_name,
                   attestation_fmt, enterprise_attestation_verified, last_used_at, revoked_at,
                   created_at, updated_at
              FROM passkey_credentials
             WHERE tenant_id = ? AND user_id = ?
             ORDER BY id`,
      params: scoped,
    },
    {
      name: 'mfaFactors',
      sql: `SELECT id, factor_type, status, target, passkey_credential_id, is_default,
                   last_used_at, activated_at, created_at, updated_at
              FROM mfa_factors
             WHERE tenant_id = ? AND user_id = ?
             ORDER BY id`,
      params: scoped,
    },
    {
      name: 'backupCodeMetadata',
      sql: `SELECT id, batch_id, used, used_at, created_at
              FROM backup_codes
             WHERE tenant_id = ? AND user_id = ?
             ORDER BY id`,
      params: scoped,
    },
    {
      name: 'trustedDevices',
      sql: `SELECT id, device_name, last_seen_ip, last_seen_at, expires_at, revoked_at, created_at
              FROM trusted_devices
             WHERE tenant_id = ? AND user_id = ?
             ORDER BY id`,
      params: scoped,
    },
    {
      name: 'oauthConsents',
      sql: `SELECT id, client_id, granted_scopes, created_at, updated_at
              FROM oauth_consents
             WHERE tenant_id = ? AND user_id = ?
             ORDER BY id`,
      params: scoped,
    },
    {
      name: 'refreshTokenMetadata',
      sql: `SELECT id, family_id, client_id, scope, active_org_id, project_grant_id, resource,
                   authorization_details, auth_time, acr, amr, revoked_at, family_revoked_at,
                   expires_at, absolute_expires_at, created_at
              FROM refresh_tokens
             WHERE tenant_id = ? AND user_id = ?
             ORDER BY id`,
      params: scoped,
    },
    {
      name: 'accessTokenMetadata',
      sql: `SELECT id, jti, client_id, authorization_code, refresh_family_id, expires_at, created_at
              FROM access_token_issuances
             WHERE tenant_id = ? AND subject = ?
             ORDER BY id`,
      params: scoped,
    },
    {
      name: 'directoryProfiles',
      sql: `SELECT id, directory_id, external_id, user_name, scim_raw, active, status, deleted_at,
                   created_at, updated_at
              FROM directory_users
             WHERE tenant_id = ? AND user_id = ?
             ORDER BY id`,
      params: scoped,
    },
    {
      name: 'samlSessions',
      sql: `SELECT id, direction, scope_id, session_index, session_id, name_id, name_id_format,
                   expires_at, consumed_at, created_at, updated_at
              FROM saml_session_bindings
             WHERE tenant_id = ? AND user_id = ?
             ORDER BY id`,
      params: scoped,
    },
    {
      name: 'privacyRequests',
      sql: `SELECT id, request_type, status, available_at, expires_at, scheduled_for,
                   processing_started_at, completed_at, canceled_at, error_code, created_at,
                   updated_at
              FROM privacy_requests
             WHERE tenant_id = ? AND user_id = ?
             ORDER BY id`,
      params: scoped,
    },
    {
      name: 'auditEvents',
      sql: `SELECT seq, id, org_id, event_type, actor_id, actor_ip, target_type, target_id, meta,
                   occurred_at
              FROM audit_events
             WHERE tenant_id = ?
               AND (actor_id = ? OR (target_type = 'user' AND target_id = ?))
             ORDER BY seq`,
      params: [tenantId, userId, userId],
    },
  ]
}

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

export function createPrivacyExportStream(
  env: Env,
  input: { requestId: string; tenantId: string; userId: string; generatedAt: number },
): ReadableStream<Uint8Array> {
  const sections = exportSections(input.tenantId, input.userId)
  let sectionIndex = 0
  let offset = 0
  let sectionOpen = false
  let firstRow = true
  let started = false
  let finished = false

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (finished) return
      try {
        if (!started) {
          controller.enqueue(
            encode(
              `{"schemaVersion":${EXPORT_SCHEMA_VERSION},"requestId":${JSON.stringify(
                input.requestId,
              )},"generatedAt":${JSON.stringify(new Date(input.generatedAt).toISOString())},"data":{`,
            ),
          )
          started = true
        }

        const section = sections[sectionIndex]
        if (!section) {
          controller.enqueue(encode('}}'))
          controller.close()
          finished = true
          return
        }

        if (!sectionOpen) {
          controller.enqueue(
            encode(`${sectionIndex === 0 ? '' : ','}${JSON.stringify(section.name)}:[`),
          )
          sectionOpen = true
        }

        const rows = (
          await env.DB.prepare(`${section.sql} LIMIT ? OFFSET ?`)
            .bind(...section.params, PRIVACY_PAGE_SIZE, offset)
            .all<Record<string, unknown>>()
        ).results
        for (const row of rows) {
          controller.enqueue(encode(`${firstRow ? '' : ','}${JSON.stringify(row)}`))
          firstRow = false
        }

        if (rows.length === PRIVACY_PAGE_SIZE) {
          offset += rows.length
          return
        }

        controller.enqueue(encode(']'))
        sectionIndex += 1
        offset = 0
        sectionOpen = false
        firstRow = true
      } catch (error) {
        finished = true
        controller.error(error)
      }
    },
  })
}

export async function completePrivacyExport(
  env: Env,
  input: { requestId: string; tenantId: string; userId: string; now?: number },
): Promise<void> {
  const now = input.now ?? Date.now()
  const storageKey = `privacy-exports/${input.tenantId}/${input.userId}/${input.requestId}.json`
  const body = createPrivacyExportStream(env, { ...input, generatedAt: now })
  await env.STORAGE.put(storageKey, body, {
    httpMetadata: { contentType: EXPORT_CONTENT_TYPE },
    customMetadata: { requestId: input.requestId },
  })
  const result = await env.DB.prepare(
    `UPDATE privacy_requests
        SET status = 'completed', storage_key = ?, content_type = ?, available_at = ?,
            expires_at = ?, completed_at = ?, processing_started_at = NULL, error_code = NULL,
            updated_at = ?
      WHERE id = ? AND tenant_id = ? AND user_id = ? AND request_type = 'export'
        AND status = 'processing'`,
  )
    .bind(
      storageKey,
      EXPORT_CONTENT_TYPE,
      now,
      now + PRIVACY_EXPORT_TTL_MS,
      now,
      now,
      input.requestId,
      input.tenantId,
      input.userId,
    )
    .run()
  if ((result.meta.changes ?? 0) !== 1) {
    await env.STORAGE.delete(storageKey)
    throw new Error('privacy_export_state_transition_failed')
  }
}
