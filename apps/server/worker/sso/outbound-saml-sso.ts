// 出站 SAML IdP 的 /sso:为已认证用户签发 SAMLResponse 并 POST 到 SP 的 ACS。

import { createTenantDb, schema } from '@xid-kit/db'
import { signSamlResponse } from '@xid-kit/saml'
import type { SamlAttributeValue } from '@xid-kit/saml'
import { and, eq } from 'drizzle-orm'
import type { Context } from 'hono'
import { AppError } from '../lib/errors'
import { findOrganizationAccessGrant } from '../lib/organization-access'
import type { SessionData, XidHonoEnv } from '../lib/types'
import {
  assertUserPassesAssignmentGate,
  parseAssignmentGate,
  withoutAssignmentGate,
} from './assignment-gate'
import { idpEntityId, postBindingForm, requiredParam, resolveSp } from './outbound-saml-shared'
import type { SamlServiceProvider } from './outbound-saml-shared'
import { importSamlSigningKey, loadSigningCert } from './outbound-saml-signing'
import { readVerifiedOutboundSsoRequest } from './outbound-saml-sso-message'
import {
  consumeOutboundSsoRequest,
  OUTBOUND_SSO_RESUME_PARAM,
  outboundSsoInteractionRedirect,
  outboundSsoResumePath,
  stashOutboundSsoRequest,
} from './outbound-sso-continuation'
import { trackOutboundSamlSession } from './saml-do'

type UserRow = typeof schema.users.$inferSelect

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

async function primaryEmail(c: Context<XidHonoEnv>, user: UserRow): Promise<string> {
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  if (user.primaryEmailId) {
    const row = await db.userEmails.findOne(eq(schema.userEmails.id, user.primaryEmailId))
    if (row?.email) return row.email
  }
  const first = await db.userEmails.findOne(eq(schema.userEmails.userId, user.id))
  if (first?.email) return first.email
  if (user.username) return user.username
  throw new AppError('invalid_request', { httpStatus: 400 })
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
  return out
}

export async function handleSso(c: Context<XidHonoEnv>): Promise<Response> {
  const session = c.get('session')
  const appId = requiredParam(c, 'appId')
  const sp = await resolveSp(c, appId)
  const resumeId = c.req.method === 'GET' ? c.req.query(OUTBOUND_SSO_RESUME_PARAM) : undefined
  const request = resumeId
    ? await consumeOutboundSsoRequest(c, { appId, id: resumeId })
    : await readVerifiedOutboundSsoRequest(c, { appId, sp })
  if (!session || session.status !== 'active') {
    const id = await stashOutboundSsoRequest(c, { appId, request })
    return outboundSsoInteractionRedirect(c, {
      session,
      returnTo: outboundSsoResumePath(appId, id),
    })
  }
  const { inResponseTo, relayState } = request
  const user = await readAuthenticatedUser(c, session)
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  await assertUserPassesAssignmentGate(db, {
    orgId: sp.orgId,
    userId: user.id,
    gate: parseAssignmentGate(sp.attributeMapping as Record<string, unknown>),
  })
  const cert = await loadSigningCert(c, sp)
  const key = await importSamlSigningKey(cert, c.env.KEK)
  const email = await primaryEmail(c, user)
  const sessionIndex = session.sessionId
  const signed = await signSamlResponse(
    {
      issuer: idpEntityId(c, appId),
      audience: sp.spEntityId,
      acsUrl: sp.acsUrl,
      subjectNameId: email,
      nameIdFormat: sp.nameIdFormat || DEFAULT_NAME_ID_FORMAT,
      attributes: userAttributes(sp, user, email),
      sessionIndex,
      inResponseTo,
    },
    key,
  )
  if (!signed.ok) {
    throw new AppError('internal_error', {
      httpStatus: 500,
      longMessage: 'outbound_saml_sign_failed',
    })
  }

  const ttlMs = Math.max(0, session.expiresAt.getTime() - Date.now())
  await trackOutboundSamlSession(
    c,
    {
      appId,
      sessionIndex,
      userId: session.userId,
      sessionId: session.sessionId,
      nameId: email,
      nameIdFormat: sp.nameIdFormat || DEFAULT_NAME_ID_FORMAT,
    },
    ttlMs,
  )

  const html = postBindingForm({
    destination: sp.acsUrl,
    samlMessage: signed.value.samlResponse,
    fieldName: 'SAMLResponse',
    relayState,
  })
  return c.html(html, 200)
}
