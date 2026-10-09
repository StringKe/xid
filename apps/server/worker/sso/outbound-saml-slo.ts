// 出站 SAML IdP 的 /slo:SP 发起的 LogoutRequest 撤销本地会话并回 LogoutResponse;
// SP 回来的 LogoutResponse 继续串联下一个 SP。

import {
  buildLogoutResponseXml,
  decodeSamlBindingPayload,
  encodeRedirectBindingMessage,
  signLogoutResponse,
  signRedirectBindingResponse,
  verifySamlLogoutRequest,
  verifySamlLogoutResponse,
} from '@xid-kit/saml'
import type { Context } from 'hono'
import { AppError } from '../lib/errors'
import type { XidHonoEnv } from '../lib/types'
import {
  attemptAllOutboundSessionRevocations,
  auditSloFailure,
  prepareFirstAvailableLogoutAction,
  renderOutboundLogoutAction,
  revokeOutboundBinding,
  safeLogoutReturnTo,
} from './outbound-saml-logout'
import {
  idpEntityId,
  idpSloUrl,
  postBindingForm,
  requiredParam,
  resolveSp,
} from './outbound-saml-shared'
import { importSamlSigningKey, loadSigningCert } from './outbound-saml-signing'
import { readOutboundSloMessage } from './outbound-saml-slo-message'
import {
  consumeOutboundLogoutRequestContext,
  isLogoutRequestReplay,
  releaseLogoutRequestReplay,
  resolveOutboundSamlSessionIndex,
} from './saml-do'
import type { SamlLogoutRequestReplayInput } from './saml-do'
import {
  resolveOutboundSamlSessionByNameId,
  restoreConsumedSamlSessionBindings,
} from './saml-session-bindings'
import type { ConsumedSamlSessionBinding } from './saml-session-bindings'

const STATUS_SUCCESS = 'urn:oasis:names:tc:SAML:2.0:status:Success'

async function consumeVerifiedOutboundLogoutRequest(
  c: Context<XidHonoEnv>,
  input: {
    appId: string
    requestId: string
    validUntil: number
    sessionIndexes: readonly string[]
    nameId?: string
  },
): Promise<void> {
  const replayInput: SamlLogoutRequestReplayInput = {
    direction: 'outbound',
    scopeId: input.appId,
    requestId: input.requestId,
    validUntil: input.validUntil,
  }
  if (await isLogoutRequestReplay(c, replayInput)) {
    throw new AppError('replay_detected', { httpStatus: 403 })
  }
  const bindings: ConsumedSamlSessionBinding[] = []
  let consumeFailure: { cause: unknown } | null = null
  if (input.sessionIndexes.length > 0) {
    for (const sessionIndex of new Set(input.sessionIndexes)) {
      try {
        const binding = await resolveOutboundSamlSessionIndex(c, input.appId, sessionIndex)
        if (binding) bindings.push(binding)
      } catch (cause) {
        consumeFailure ??= { cause }
      }
    }
  } else if (input.nameId) {
    try {
      bindings.push(...(await resolveOutboundSamlSessionByNameId(c, input.appId, input.nameId)))
    } catch (cause) {
      consumeFailure = { cause }
    }
  }
  const revokeFailure = await attemptAllOutboundSessionRevocations(c, bindings)
  const failure = consumeFailure ?? revokeFailure
  if (failure) {
    await restoreConsumedSamlSessionBindings(c, {
      direction: 'outbound',
      scopeId: input.appId,
      bindings,
    })
    await releaseLogoutRequestReplay(c, replayInput)
    throw new AppError('server_error', { cause: failure.cause })
  }
}

export async function handleOutboundSlo(c: Context<XidHonoEnv>): Promise<Response> {
  const appId = requiredParam(c, 'appId')
  const sp = await resolveSp(c, appId)
  const sloDestination = idpSloUrl(c, appId)
  const message = await readOutboundSloMessage(c)
  const decoded = await decodeSamlBindingPayload(message.encoded, message.binding)
  if (!decoded.ok) throw new AppError('malformed_request', { httpStatus: 400 })

  if (message.kind === 'request') {
    const verified = await verifySamlLogoutRequest(decoded.value, {
      idpCertificatesB64: sp.spCertificates,
      expectedIssuer: sp.spEntityId,
      expectedDestination: sloDestination,
      ...(message.redirectSignature ? { redirectSignature: message.redirectSignature } : {}),
    })
    if (!verified.ok) throw new AppError('signature_invalid', { httpStatus: 401 })
    if (!sp.sloUrl) throw new AppError('connection_not_found', { httpStatus: 404 })
    const cert = await loadSigningCert(c, sp)
    const key = await importSamlSigningKey(cert, c.env.KEK)
    const responseInput = {
      issuer: idpEntityId(c, appId),
      destination: sp.sloUrl,
      inResponseTo: verified.value.requestId,
    }
    const consumeInput = {
      appId,
      requestId: verified.value.requestId,
      validUntil: verified.value.validUntil,
      sessionIndexes: verified.value.sessionIndexes,
      ...(verified.value.nameId ? { nameId: verified.value.nameId } : {}),
    }
    if (message.binding === 'redirect') {
      const built = buildLogoutResponseXml(responseInput)
      const param = await encodeRedirectBindingMessage(built.xml)
      const signed = await signRedirectBindingResponse(param, message.relayState, key)
      if (!signed.ok) throw new AppError('internal_error', { httpStatus: 500 })
      await consumeVerifiedOutboundLogoutRequest(c, consumeInput)
      const sep = sp.sloUrl.includes('?') ? '&' : '?'
      return c.redirect(`${sp.sloUrl}${sep}${signed.value.query}`)
    }

    const signed = await signLogoutResponse(responseInput, key)
    if (!signed.ok) throw new AppError('internal_error', { httpStatus: 500 })
    await consumeVerifiedOutboundLogoutRequest(c, consumeInput)
    return c.html(
      postBindingForm({
        destination: sp.sloUrl,
        samlMessage: signed.value.samlMessage,
        fieldName: 'SAMLResponse',
        relayState: message.relayState,
      }),
      200,
    )
  }

  const verified = await verifySamlLogoutResponse(decoded.value, {
    spCertificatesB64: sp.spCertificates,
    expectedIssuer: sp.spEntityId,
    expectedDestination: sloDestination,
    requireSignature: true,
    ...(message.redirectSignature ? { redirectSignature: message.redirectSignature } : {}),
  })
  if (!verified.ok) throw new AppError('signature_invalid', { httpStatus: 401 })
  if (message.relayState === null) throw new AppError('invalid_request', { httpStatus: 400 })
  const requestContext = await consumeOutboundLogoutRequestContext(
    c,
    appId,
    verified.value.inResponseTo,
    message.relayState,
  )
  if (!requestContext) throw new AppError('invalid_request', { httpStatus: 400 })
  if (message.relayState !== requestContext.relayState) {
    throw new AppError('invalid_request', { httpStatus: 400 })
  }
  const succeeded = verified.value.statusCode === STATUS_SUCCESS
  if (!succeeded) {
    await auditSloFailure(c, {
      appId,
      kind: 'logout_response',
      statusCode: verified.value.statusCode,
      inResponseTo: verified.value.inResponseTo,
    })
  }
  if (succeeded) {
    const bindingHit = await resolveOutboundSamlSessionIndex(c, appId, requestContext.sessionIndex)
    if (bindingHit) await revokeOutboundBinding(c, bindingHit)
  }
  const next = await prepareFirstAvailableLogoutAction(
    c,
    requestContext.remaining,
    safeLogoutReturnTo(c, requestContext.returnTo),
  )
  if (next) return renderOutboundLogoutAction(c, next)
  return c.redirect(safeLogoutReturnTo(c, requestContext.returnTo))
}
