// 审计事件写成一句完整的话:谁、做了什么、对象。未登记的事件类型回落为「谁 记录了 事件名」。

import { msg } from '@lingui/core/macro'
import type { I18n } from '@lingui/core'
import type { UserAuditEvent } from './user-api'

export function actorLabel(
  i18n: I18n,
  event: UserAuditEvent,
  subject: string,
  subjectId: string,
): string {
  if (event.actorId === subjectId) return subject
  if (event.actorName) return event.actorName
  if (event.actorId === 'system' || event.actorId === null) return i18n._(msg`XID`)
  if (event.actorId.startsWith('ak_')) return i18n._(msg`An API key`)
  return i18n._(msg`A deleted user`)
}

export function activitySentence(
  i18n: I18n,
  event: UserAuditEvent,
  subject: string,
  subjectId: string,
): string {
  const actor = actorLabel(i18n, event, subject, subjectId)
  const eventType = event.eventType
  switch (eventType) {
    case 'auth.login_succeeded':
      return i18n._(msg`${subject} signed in.`)
    case 'auth.login_failed':
      return i18n._(msg`A sign-in attempt for ${subject} failed.`)
    case 'user.created':
      return i18n._(msg`${actor} created ${subject}.`)
    case 'user.updated':
    case 'user.metadata_updated':
      return i18n._(msg`${actor} updated the profile of ${subject}.`)
    case 'user.deleted':
      return i18n._(msg`${actor} deleted ${subject}.`)
    case 'user.restored':
      return i18n._(msg`${actor} restored ${subject}.`)
    case 'user.banned':
      return i18n._(msg`${actor} suspended ${subject}.`)
    case 'user.unbanned':
      return i18n._(msg`${actor} resumed ${subject}.`)
    case 'user.password_reset_requested':
      return i18n._(msg`${actor} sent ${subject} a password reset link.`)
    case 'user.mfa_reset':
      return i18n._(msg`${actor} reset two-step verification for ${subject}.`)
    case 'user.sessions_revoked':
      return i18n._(msg`${actor} signed ${subject} out everywhere.`)
    case 'session.revoked':
      return i18n._(msg`${actor} ended one session of ${subject}.`)
    case 'membership.created':
      return i18n._(msg`${actor} added ${subject} to an organization.`)
    case 'membership.updated':
      return i18n._(msg`${actor} changed the organization role of ${subject}.`)
    case 'membership.removed':
      return i18n._(msg`${actor} removed ${subject} from an organization.`)
    default:
      return i18n._(msg`${actor} recorded ${eventType}.`)
  }
}
