// 出站 SAML IdP 发起的 SLO:为浏览器准备首个 LogoutRequest,后续 SP 由 /slo 的 LogoutResponse 回调串联;
// 以及按 SessionIndex / NameID 撤销本地会话。

import { createTenantDb, schema } from '@xid-kit/db'
import {
  buildLogoutRequestXml,
  encodeRedirectBindingMessage,
  signLogoutRequest,
  signRedirectBindingRequest,
} from '@xid-kit/saml'
import { and, eq } from 'drizzle-orm'
import type { Context } from 'hono'
import { AppError } from '../lib/errors'
import { revokeSession, sessionDoRevoke } from '../lib/session'
import type { SessionData, XidHonoEnv } from '../lib/types'
import { idpEntityId, postBindingForm, resolveSp } from './outbound-saml-shared'
import { importSamlSigningKey, loadSigningCert } from './outbound-saml-signing'
import { peekOutboundSamlSessionsForUser, storeOutboundLogoutRequestContext } from './saml-do'
import type { OutboundSamlLogoutTarget } from './saml-do'
import type { ConsumedSamlSessionBinding } from './saml-session-bindings'

export type OutboundSamlLogoutAction =
  | {
      binding: 'redirect'
      url: string
    }
  | {
      binding: 'post'
      destination: string
      samlRequest: string
      relayState: string
    }

export async function auditSloFailure(
  c: Context<XidHonoEnv>,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await Promise.resolve(
      c.env.AUDIT_QUEUE.send({
        tenantId: c.get('tenant').tenantId,
        action: 'saml.slo_failed',
        actorId: undefined,
        ts: Date.now(),
        payload,
      }),
    )
  } catch {
    // best-effort observability
  }
}

function logoutReturnTo(c: Context<XidHonoEnv>): string {
  return `${c.get('tenant').issuer}/sign-in`
}

export function safeLogoutReturnTo(c: Context<XidHonoEnv>, value: string): string {
  const fallback = logoutReturnTo(c)
  try {
    const issuer = new URL(c.get('tenant').issuer)
    const target = new URL(value)
    return target.origin === issuer.origin ? target.toString() : fallback
  } catch {
    return fallback
  }
}

async function prepareOutboundSamlLogoutAction(
  c: Context<XidHonoEnv>,
  target: OutboundSamlLogoutTarget,
  remaining: readonly OutboundSamlLogoutTarget[],
  returnTo: string,
): Promise<OutboundSamlLogoutAction> {
  const sp = await resolveSp(c, target.appId)
  if (!sp.sloUrl) throw new AppError('connection_not_found', { httpStatus: 404 })
  const cert = await loadSigningCert(c, sp)
  const key = await importSamlSigningKey(cert, c.env.KEK)
  const requestInput = {
    issuer: idpEntityId(c, target.appId),
    destination: sp.sloUrl,
    nameId: target.nameId,
    nameIdFormat: target.nameIdFormat,
    sessionIndex: target.sessionIndex,
  }
  const relayState = returnTo

  if (sp.sloBinding === 'post') {
    const signed = await signLogoutRequest(requestInput, key)
    if (!signed.ok) throw new AppError('internal_error', { httpStatus: 500 })
    await storeOutboundLogoutRequestContext(c, {
      appId: target.appId,
      requestId: signed.value.messageId,
      sessionIndex: target.sessionIndex,
      relayState,
      returnTo,
      remaining,
    })
    return {
      binding: 'post',
      destination: sp.sloUrl,
      samlRequest: signed.value.samlMessage,
      relayState,
    }
  }

  const built = buildLogoutRequestXml(requestInput)
  const encoded = await encodeRedirectBindingMessage(built.xml)
  const signed = await signRedirectBindingRequest(encoded, relayState, key)
  if (!signed.ok) throw new AppError('internal_error', { httpStatus: 500 })
  await storeOutboundLogoutRequestContext(c, {
    appId: target.appId,
    requestId: built.requestId,
    sessionIndex: target.sessionIndex,
    relayState,
    returnTo,
    remaining,
  })
  return {
    binding: 'redirect',
    url: `${sp.sloUrl}${sp.sloUrl.includes('?') ? '&' : '?'}${signed.value.query}`,
  }
}

export async function prepareFirstAvailableLogoutAction(
  c: Context<XidHonoEnv>,
  targets: readonly OutboundSamlLogoutTarget[],
  returnTo: string,
): Promise<OutboundSamlLogoutAction | null> {
  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index]!
    try {
      return await prepareOutboundSamlLogoutAction(c, target, targets.slice(index + 1), returnTo)
    } catch (error) {
      await auditSloFailure(c, {
        appId: target.appId,
        kind: 'logout_request_prepare',
        sessionIndex: target.sessionIndex,
        error: String(error),
      })
    }
  }
  return null
}

export function renderOutboundLogoutAction(
  c: Context<XidHonoEnv>,
  action: OutboundSamlLogoutAction,
): Response {
  if (action.binding === 'redirect') return c.redirect(action.url)
  return c.html(
    postBindingForm({
      destination: action.destination,
      samlMessage: action.samlRequest,
      fieldName: 'SAMLRequest',
      relayState: action.relayState,
    }),
    200,
  )
}

export async function revokeOutboundBinding(
  c: Context<XidHonoEnv>,
  binding: { userId: string; sessionId: string },
): Promise<void> {
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const row = await db.sessions.findOne(eq(schema.sessions.id, binding.sessionId))
  if (!row || row.status !== 'active') return
  if (row.userId !== binding.userId) {
    throw new AppError('server_error', {
      cause: new Error('SAML session binding user mismatch'),
    })
  }
  const session: SessionData = {
    sessionId: row.id,
    userId: row.userId,
    status: 'active',
    activeOrgId: row.activeOrgId ?? null,
    authenticatedAt: row.authenticatedAt,
    lastActiveAt: row.lastActiveAt,
    expiresAt: row.expiresAt,
    rememberMe: row.rememberMe,
    isImpersonation: row.isImpersonation,
    impersonatorUserId: row.impersonatorUserId ?? null,
    acr: row.acr ?? null,
    amr: row.amr ?? null,
    aal: row.aal ?? null,
  }
  try {
    await revokeSession(c, session)
  } catch (cause) {
    const fallback = await Promise.allSettled([
      sessionDoRevoke(c.env, binding.userId, binding.sessionId),
      db.sessions.update(
        { status: 'revoked' },
        and(
          eq(schema.sessions.id, binding.sessionId),
          eq(schema.sessions.userId, binding.userId),
          eq(schema.sessions.status, 'active'),
        ),
      ),
    ])
    if (fallback.some((result) => result.status === 'fulfilled')) return
    throw new AppError('server_error', {
      cause: new AggregateError(
        [
          cause,
          ...fallback.map((result) =>
            result.status === 'rejected' ? result.reason : new Error('unexpected success'),
          ),
        ],
        'SAML session revocation failed in both stores',
      ),
    })
  }
}

export async function attemptAllOutboundSessionRevocations(
  c: Context<XidHonoEnv>,
  bindings: readonly ConsumedSamlSessionBinding[],
): Promise<{ cause: unknown } | null> {
  let firstFailure: { cause: unknown } | null = null
  for (const binding of bindings) {
    try {
      await revokeOutboundBinding(c, binding)
    } catch (cause) {
      firstFailure ??= { cause }
    }
  }
  return firstFailure
}

// 出站 IdP:准备浏览器执行的首个 SLO action；后续 SP 由 /slo LogoutResponse 回调串联。
export async function initiateOutboundSamlLogout(
  c: Context<XidHonoEnv>,
  session: SessionData,
): Promise<OutboundSamlLogoutAction | null> {
  let tracked: Awaited<ReturnType<typeof peekOutboundSamlSessionsForUser>>
  try {
    tracked = await peekOutboundSamlSessionsForUser(c, session.userId, session.sessionId)
  } catch (error) {
    await auditSloFailure(c, {
      appId: null,
      kind: 'logout_request_discovery',
      sessionId: session.sessionId,
      error: String(error),
    })
    return null
  }
  const targets: OutboundSamlLogoutTarget[] = tracked
    .filter((item) => item.nameId !== '' && item.nameIdFormat !== '')
    .map((item) => ({
      appId: item.appId,
      sessionIndex: item.sessionIndex,
      nameId: item.nameId,
      nameIdFormat: item.nameIdFormat,
    }))
  return prepareFirstAvailableLogoutAction(c, targets, logoutReturnTo(c))
}
