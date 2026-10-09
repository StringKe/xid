// 入站 SAML SLO:IdP 发来 LogoutRequest -> 撤销绑定的本地 session -> 签名 LogoutResponse 回 IdP。

import {
  buildLogoutResponseXml,
  decodeSamlBindingPayload,
  encodeRedirectBindingMessage,
  signLogoutResponse,
  signRedirectBindingResponse,
  verifySamlLogoutRequest,
} from '@xid-kit/saml'
import { createTenantDb, schema } from '@xid-kit/db'
import { and, eq } from 'drizzle-orm'
import type { Context } from 'hono'
import { AppError } from '../lib/errors'
import { revokeSession, sessionDoRevoke } from '../lib/session'
import type { SessionData, XidHonoEnv } from '../lib/types'
import { samlErrorToApp } from './saml-errors'
import { loadSpSigningKey, resolveConnection, sloUrl, spEntityId } from './saml-connection'
import { readSloRequest, sloPostForm } from './saml-slo-binding'
import {
  isLogoutRequestReplay,
  releaseLogoutRequestReplay,
  resolveInboundSamlSessionByNameId,
  resolveInboundSamlSessionIndex,
  restoreConsumedSamlSessionBindings,
} from './saml-do'
import type { ConsumedSamlSessionBinding, SamlLogoutRequestReplayInput } from './saml-do'
import { resolveSsoConnectionTenant, withTenant } from './tenant'
import { enforceEnterpriseSsoPolicy } from './enterprise-policy'

async function revokeInboundSamlSession(
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

async function attemptAllInboundSessionRevocations(
  c: Context<XidHonoEnv>,
  bindings: readonly ConsumedSamlSessionBinding[],
): Promise<{ cause: unknown } | null> {
  let firstFailure: { cause: unknown } | null = null
  for (const binding of bindings) {
    try {
      await revokeInboundSamlSession(c, binding)
    } catch (cause) {
      firstFailure ??= { cause }
    }
  }
  return firstFailure
}

async function consumeVerifiedInboundLogoutRequest(
  c: Context<XidHonoEnv>,
  connectionId: string,
  verified: {
    requestId: string
    validUntil: number
    sessionIndexes: readonly string[]
    nameId?: string
  },
): Promise<void> {
  const replayInput: SamlLogoutRequestReplayInput = {
    direction: 'inbound',
    scopeId: connectionId,
    requestId: verified.requestId,
    validUntil: verified.validUntil,
  }
  if (await isLogoutRequestReplay(c, replayInput)) {
    throw samlErrorToApp('replay_detected', 'LogoutRequest was already consumed')
  }
  const bindings: ConsumedSamlSessionBinding[] = []
  let consumeFailure: { cause: unknown } | null = null
  if (verified.sessionIndexes.length > 0) {
    for (const sessionIndex of new Set(verified.sessionIndexes)) {
      try {
        const binding = await resolveInboundSamlSessionIndex(c, connectionId, sessionIndex)
        if (binding) bindings.push(binding)
      } catch (cause) {
        consumeFailure ??= { cause }
      }
    }
  } else if (verified.nameId) {
    try {
      bindings.push(...(await resolveInboundSamlSessionByNameId(c, connectionId, verified.nameId)))
    } catch (cause) {
      consumeFailure = { cause }
    }
  }
  const revokeFailure = await attemptAllInboundSessionRevocations(c, bindings)
  const failure = consumeFailure ?? revokeFailure
  if (failure) {
    await restoreConsumedSamlSessionBindings(c, {
      direction: 'inbound',
      scopeId: connectionId,
      bindings,
    })
    await releaseLogoutRequestReplay(c, replayInput)
    throw new AppError('server_error', { cause: failure.cause })
  }
}

// GET/POST /sso/saml/:connection/slo
export async function handleInboundSlo(c: Context<XidHonoEnv>): Promise<Response> {
  const connectionId = c.req.param('connection')
  if (!connectionId) throw new AppError('not_found', { httpStatus: 404 })
  const tenant = await resolveSsoConnectionTenant(c, connectionId)
  return withTenant(c, tenant, async () => {
    const connection = await resolveConnection(c, connectionId)
    await enforceEnterpriseSsoPolicy({ c, action: 'logout', email: null })
    const ctx = c.get('tenant')
    const { encoded, binding, relayState, redirectSignature } = await readSloRequest(c)
    const decoded = await decodeSamlBindingPayload(encoded, binding)
    if (!decoded.ok) throw samlErrorToApp(decoded.error.code, decoded.error.reason)

    const verified = await verifySamlLogoutRequest(decoded.value, {
      idpCertificatesB64: connection.idpCertificates,
      expectedIssuer: connection.idpEntityId ?? '',
      expectedDestination: sloUrl(ctx, connectionId),
      clockSkewToleranceMs: connection.samlClockSkewMs,
      ...(redirectSignature ? { redirectSignature } : {}),
    })
    if (!verified.ok) throw samlErrorToApp(verified.error.code, verified.error.reason)

    const responseDestination = connection.idpSloUrl
    if (!responseDestination) {
      throw new AppError('connection_not_found', { httpStatus: 404 })
    }
    const signingKey = await loadSpSigningKey(c)
    if (!signingKey) throw new AppError('connection_not_found', { httpStatus: 404 })
    const responseInput = {
      issuer: spEntityId(ctx, connectionId),
      destination: responseDestination,
      inResponseTo: verified.value.requestId,
    }

    if (binding === 'redirect') {
      const built = buildLogoutResponseXml(responseInput)
      const param = await encodeRedirectBindingMessage(built.xml)
      const signed = await signRedirectBindingResponse(param, relayState, signingKey)
      if (!signed.ok) {
        throw new AppError('internal_error', {
          httpStatus: 500,
          longMessage: 'saml_slo_sign_failed',
        })
      }
      await consumeVerifiedInboundLogoutRequest(c, connectionId, verified.value)
      const sep = responseDestination.includes('?') ? '&' : '?'
      return c.redirect(`${responseDestination}${sep}${signed.value.query}`)
    }

    const signed = await signLogoutResponse(responseInput, signingKey)
    if (!signed.ok) {
      throw new AppError('internal_error', {
        httpStatus: 500,
        longMessage: 'saml_slo_sign_failed',
      })
    }
    await consumeVerifiedInboundLogoutRequest(c, connectionId, verified.value)

    const html = sloPostForm({
      destination: responseDestination,
      samlResponse: signed.value.samlMessage,
      relayState,
    })
    return c.html(html, 200)
  })
}
