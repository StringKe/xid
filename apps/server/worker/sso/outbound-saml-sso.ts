// 出站 SAML IdP 的 /sso:按 AuthnRequest 的 ForceAuthn、IsPassive 和 NameIDPolicy 决定重新认证、
// 返回错误状态或为已认证用户签发 SAMLResponse,并 POST 到 SP 的 ACS。

import { createTenantDb, schema } from '@xid-kit/db'
import { signSamlResponse } from '@xid-kit/saml'
import type { SamlAttributeValue } from '@xid-kit/saml'
import { and, eq } from 'drizzle-orm'
import type { Context } from 'hono'
import { AppError } from '../lib/errors'
import { findOrganizationAccessGrant } from '../lib/organization-access'
import { logWorkerWarning } from '../lib/safe-log'
import type { SessionData, XidHonoEnv } from '../lib/types'
import {
  assertUserPassesAssignmentGate,
  parseAssignmentGate,
  withoutAssignmentGate,
} from './assignment-gate'
import { chooseNameIdFormat, nameIdValue } from './outbound-saml-name-id'
import { resolvePersistentNameId } from './outbound-saml-persistent-name-id'
import { idpEntityId, postBindingForm, requiredParam, resolveSp } from './outbound-saml-shared'
import type { SamlServiceProvider } from './outbound-saml-shared'
import { importSamlSigningKey, loadSigningCert } from './outbound-saml-signing'
import { readVerifiedOutboundSsoRequest } from './outbound-saml-sso-message'
import { SAML_STATUS, buildSignedSamlStatusResponse } from './outbound-saml-status'
import {
  consumeOutboundSsoRequest,
  OUTBOUND_SSO_RESUME_PARAM,
  outboundSsoInteractionRedirect,
  outboundSsoResumePath,
  stashOutboundSsoRequest,
} from './outbound-sso-continuation'
import type { OutboundSsoRequest } from './outbound-sso-continuation'
import { trackOutboundSamlSession } from './saml-do'

type UserRow = typeof schema.users.$inferSelect

type SsoTarget = { appId: string; sp: SamlServiceProvider; request: OutboundSsoRequest }

const DEFAULT_NAME_ID_FORMAT = 'urn:oasis:names:tc:SAML:2.0:nameid-format:emailAddress'

async function readAuthenticatedUser(
  c: Context<XidHonoEnv>,
  session: SessionData,
): Promise<UserRow> {
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const user = await db.users.findOne(
    and(eq(schema.users.id, session.userId), eq(schema.users.status, 'active')),
  )
  if (!user) throw new AppError('invalid_credentials', { httpStatus: 401 })
  if (session.activeOrgId) {
    const grant = await findOrganizationAccessGrant(db, {
      userId: session.userId,
      orgId: session.activeOrgId,
    })
    if (!grant) throw new AppError('access_denied', { httpStatus: 403 })
  }
  return user
}

async function primaryEmail(c: Context<XidHonoEnv>, user: UserRow): Promise<string | null> {
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  if (user.primaryEmailId) {
    const row = await db.userEmails.findOne(eq(schema.userEmails.id, user.primaryEmailId))
    if (row?.email) return row.email
  }
  const first = await db.userEmails.findOne(eq(schema.userEmails.userId, user.id))
  return first?.email ?? null
}

function readMappingString(
  mapping: Record<string, unknown>,
  key: string,
  fallback: string,
): string {
  const value = mapping[key]
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

function userAttributes(
  sp: SamlServiceProvider,
  user: UserRow,
  email: string,
): Record<string, SamlAttributeValue> {
  const mapping = withoutAssignmentGate(sp.attributeMapping as Record<string, unknown>)
  const firstName = user.firstName ?? ''
  const lastName = user.lastName ?? ''
  const displayName = user.displayName ?? [firstName, lastName].filter(Boolean).join(' ')
  const out: Record<string, SamlAttributeValue> = {
    [readMappingString(mapping, 'email', 'email')]: email,
    [readMappingString(mapping, 'userEmail', 'User.Email')]: email,
  }
  if (firstName) out[readMappingString(mapping, 'firstName', 'firstName')] = firstName
  if (lastName) out[readMappingString(mapping, 'lastName', 'lastName')] = lastName
  if (displayName) out[readMappingString(mapping, 'displayName', 'displayName')] = displayName
  // 只在映射显式配置 userId 时发出 XID user id,供需要不可变 ID 的 SP(如 Atlassian)使用。
  const userIdAttribute = readMappingString(mapping, 'userId', '')
  if (userIdAttribute) out[userIdAttribute] = user.id
  return out
}

async function statusResponse(
  c: Context<XidHonoEnv>,
  target: SsoTarget,
  status: { topLevel: string; secondLevel: string; reason: string },
): Promise<Response> {
  logWorkerWarning('sso.outbound_saml.status_response', {
    component: 'outbound-saml',
    operation: 'sso',
    outcome: status.secondLevel,
    reason: status.reason,
  })
  const samlMessage = await buildSignedSamlStatusResponse(c, {
    sp: target.sp,
    issuer: idpEntityId(c, target.appId),
    inResponseTo: target.request.inResponseTo,
    topLevelStatus: status.topLevel,
    secondLevelStatus: status.secondLevel,
  })
  return c.html(
    postBindingForm({
      destination: target.sp.acsUrl,
      samlMessage,
      fieldName: 'SAMLResponse',
      relayState: target.request.relayState,
    }),
    200,
  )
}

// ForceAuthn 要求在收到 AuthnRequest 之后完成的认证,复用更早建立的会话不算数。
function satisfiesAuthentication(
  session: SessionData | null | undefined,
  request: OutboundSsoRequest,
): session is SessionData {
  if (!session || session.status !== 'active') return false
  return !request.forceAuthn || session.authenticatedAt.getTime() >= request.requestedAt
}

async function issueAssertion(
  c: Context<XidHonoEnv>,
  target: SsoTarget & { session: SessionData; nameIdFormat: string },
): Promise<Response> {
  const { appId, sp, request, session, nameIdFormat } = target
  const user = await readAuthenticatedUser(c, session)
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  await assertUserPassesAssignmentGate(db, {
    orgId: sp.orgId,
    userId: user.id,
    gate: parseAssignmentGate(sp.attributeMapping as Record<string, unknown>),
  })
  const email = await primaryEmail(c, user)
  const nameId = await nameIdValue({
    format: nameIdFormat,
    email,
    username: user.username ?? null,
    persistentNameId: () =>
      resolvePersistentNameId(c.env.DB, c.get('tenant'), { spId: appId, userId: user.id }),
  })
  if (nameId === null) {
    return statusResponse(c, target, {
      topLevel: SAML_STATUS.responder,
      secondLevel: SAML_STATUS.invalidNameIdPolicy,
      reason: 'name_id_value_missing',
    })
  }
  const attributeEmail = email ?? user.username
  if (!attributeEmail) throw new AppError('invalid_request', { httpStatus: 400 })
  const cert = await loadSigningCert(c, sp)
  const key = await importSamlSigningKey(cert, c.env.KEK)
  const signed = await signSamlResponse(
    {
      issuer: idpEntityId(c, appId),
      audience: sp.spEntityId,
      acsUrl: sp.acsUrl,
      subjectNameId: nameId,
      nameIdFormat,
      attributes: userAttributes(sp, user, attributeEmail),
      sessionIndex: session.sessionId,
      inResponseTo: request.inResponseTo,
    },
    key,
  )
  if (!signed.ok) {
    throw new AppError('internal_error', {
      httpStatus: 500,
      longMessage: 'outbound_saml_sign_failed',
    })
  }
  await trackOutboundSamlSession(
    c,
    {
      appId,
      sessionIndex: session.sessionId,
      userId: session.userId,
      sessionId: session.sessionId,
      nameId,
      nameIdFormat,
    },
    Math.max(0, session.expiresAt.getTime() - Date.now()),
  )
  return c.html(
    postBindingForm({
      destination: sp.acsUrl,
      samlMessage: signed.value.samlResponse,
      fieldName: 'SAMLResponse',
      relayState: request.relayState,
    }),
    200,
  )
}

export async function handleSso(c: Context<XidHonoEnv>): Promise<Response> {
  const session = c.get('session')
  const appId = requiredParam(c, 'appId')
  const sp = await resolveSp(c, appId)
  const resumeId = c.req.method === 'GET' ? c.req.query(OUTBOUND_SSO_RESUME_PARAM) : undefined
  const request = resumeId
    ? await consumeOutboundSsoRequest(c, { appId, id: resumeId })
    : await readVerifiedOutboundSsoRequest(c, { appId, sp })
  const target: SsoTarget = { appId, sp, request }
  const format = chooseNameIdFormat({
    configuredFormat: sp.nameIdFormat || DEFAULT_NAME_ID_FORMAT,
    requestedFormat: request.nameIdFormat,
  })
  if (!format.ok) {
    const requesterError = format.cause === 'requested_format_unsupported'
    return statusResponse(c, target, {
      topLevel: requesterError ? SAML_STATUS.requester : SAML_STATUS.responder,
      secondLevel: SAML_STATUS.invalidNameIdPolicy,
      reason: format.cause,
    })
  }
  if (!satisfiesAuthentication(session, request)) {
    if (request.isPassive) {
      return statusResponse(c, target, {
        topLevel: SAML_STATUS.responder,
        secondLevel: SAML_STATUS.noPassive,
        reason: request.forceAuthn ? 'force_authn_with_is_passive' : 'no_session',
      })
    }
    const id = await stashOutboundSsoRequest(c, { appId, request })
    return outboundSsoInteractionRedirect(c, {
      session: session ?? null,
      returnTo: outboundSsoResumePath(appId, id),
      reauthenticate: request.forceAuthn,
    })
  }
  return issueAssertion(c, { ...target, session, nameIdFormat: format.format })
}
