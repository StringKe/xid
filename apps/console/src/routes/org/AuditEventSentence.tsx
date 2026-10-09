// 审计日志一行里的句子:常见事件写成完整句子,其余事件用通用句式,事件名在下一行原样给出。

import { Trans } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import { SECURITY_EVENT_TYPES, SecurityEventSentence } from './AuditSecurityEventSentence'
import { Strong, useAuditNames } from './AuditSentenceParts'
import type { AuditEntry } from './overview-queries'

export function EventSentence({ entry }: { entry: AuditEntry }): ReactNode {
  const { actor, target } = useAuditNames(entry)
  if (SECURITY_EVENT_TYPES.has(entry.eventType)) return <SecurityEventSentence entry={entry} />
  switch (entry.eventType) {
    case 'user.created':
      return (
        <Trans>
          <Strong>{actor}</Strong> created the user <Strong>{target}</Strong>
        </Trans>
      )
    case 'user.updated':
      return (
        <Trans>
          <Strong>{actor}</Strong> updated <Strong>{target}</Strong>
        </Trans>
      )
    case 'user.deleted':
      return (
        <Trans>
          <Strong>{actor}</Strong> deleted the user <Strong>{target}</Strong>
        </Trans>
      )
    case 'user.restored':
      return (
        <Trans>
          <Strong>{actor}</Strong> restored the user <Strong>{target}</Strong>
        </Trans>
      )
    case 'user.mfa_reset':
      return (
        <Trans>
          <Strong>{actor}</Strong> reset two-step verification for <Strong>{target}</Strong>
        </Trans>
      )
    case 'user.sessions_revoked':
      return (
        <Trans>
          <Strong>{actor}</Strong> signed <Strong>{target}</Strong> out everywhere
        </Trans>
      )
    case 'user.password_set':
      return (
        <Trans>
          <Strong>{actor}</Strong> set a new password for <Strong>{target}</Strong>
        </Trans>
      )
    case 'user.password_reset_requested':
      return (
        <Trans>
          <Strong>{actor}</Strong> sent a password reset to <Strong>{target}</Strong>
        </Trans>
      )
    case 'user.email_added':
      return (
        <Trans>
          <Strong>{actor}</Strong> added an email address to <Strong>{target}</Strong>
        </Trans>
      )
    case 'user.primary_email_changed':
      return (
        <Trans>
          <Strong>{actor}</Strong> changed the primary email address of <Strong>{target}</Strong>
        </Trans>
      )
    case 'user.exported':
      return (
        <Trans>
          <Strong>{actor}</Strong> exported users
        </Trans>
      )
    case 'auth.login_succeeded':
      return (
        <Trans>
          <Strong>{actor}</Strong> signed in
        </Trans>
      )
    case 'auth.login_failed':
      return <Trans>A sign-in attempt failed</Trans>
    case 'session.revoked':
      return (
        <Trans>
          <Strong>{actor}</Strong> ended a session
        </Trans>
      )
    case 'invitation.created':
      return (
        <Trans>
          <Strong>{actor}</Strong> invited <Strong>{target}</Strong>
        </Trans>
      )
    case 'invitation.accepted':
      return (
        <Trans>
          <Strong>{actor}</Strong> accepted an invitation
        </Trans>
      )
    case 'invitation.revoked':
      return (
        <Trans>
          <Strong>{actor}</Strong> revoked an invitation
        </Trans>
      )
    case 'membership.created':
      return (
        <Trans>
          <Strong>{actor}</Strong> added <Strong>{target}</Strong> as a member
        </Trans>
      )
    case 'membership.updated':
      return (
        <Trans>
          <Strong>{actor}</Strong> changed the role of <Strong>{target}</Strong>
        </Trans>
      )
    case 'membership.removed':
      return (
        <Trans>
          <Strong>{actor}</Strong> removed <Strong>{target}</Strong> from the organization
        </Trans>
      )
    case 'api_key.created':
      return (
        <Trans>
          <Strong>{actor}</Strong> created the API key <Strong>{target}</Strong>
        </Trans>
      )
    case 'api_key.revoked':
      return (
        <Trans>
          <Strong>{actor}</Strong> revoked the API key <Strong>{target}</Strong>
        </Trans>
      )
    case 'scim.user.deactivated':
      return (
        <Trans>
          <Strong>{actor}</Strong> deactivated <Strong>{target}</Strong>
        </Trans>
      )
    case 'scim.user.deleted':
      return (
        <Trans>
          <Strong>{actor}</Strong> deleted <Strong>{target}</Strong>
        </Trans>
      )
    case 'scim.user.reactivated':
      return (
        <Trans>
          <Strong>{actor}</Strong> reactivated <Strong>{target}</Strong>
        </Trans>
      )
    case 'sso_connection.created':
      return (
        <Trans>
          <Strong>{actor}</Strong> connected enterprise SSO
        </Trans>
      )
    case 'sso_connection.updated':
      return (
        <Trans>
          <Strong>{actor}</Strong> changed the enterprise SSO connection
        </Trans>
      )
    case 'sso_connection.deleted':
      return (
        <Trans>
          <Strong>{actor}</Strong> deleted the enterprise SSO connection
        </Trans>
      )
    case 'outbound_saml_app.created':
      return (
        <Trans>
          <Strong>{actor}</Strong> added a SAML app
        </Trans>
      )
    case 'outbound_saml_app.updated':
      return (
        <Trans>
          <Strong>{actor}</Strong> changed a SAML app
        </Trans>
      )
    case 'outbound_saml_app.deleted':
      return (
        <Trans>
          <Strong>{actor}</Strong> deleted a SAML app
        </Trans>
      )
    case 'organization.auth_policy.updated':
      return (
        <Trans>
          <Strong>{actor}</Strong> changed sign-in and MFA settings
        </Trans>
      )
    case 'webhook.created':
      return (
        <Trans>
          <Strong>{actor}</Strong> added a webhook endpoint
        </Trans>
      )
    case 'webhook.secret_rotated':
      return (
        <Trans>
          <Strong>{actor}</Strong> rotated a webhook signing secret
        </Trans>
      )
    default:
      return entry.targetId ? (
        <Trans>
          <Strong>{actor}</Strong> acted on <Strong>{target}</Strong>
        </Trans>
      ) : (
        <Trans>
          <Strong>{actor}</Strong> made a change
        </Trans>
      )
  }
}
