// 出站 SAML IdP 的 /sso 请求读取与 AuthnRequest 校验。

import { decodeSamlBindingPayload, verifySamlAuthnRequest } from '@xid-kit/saml'
import type { Context } from 'hono'
import { AppError } from '../lib/errors'
import type { XidHonoEnv } from '../lib/types'
import {
  OUTBOUND_AUTHN_REQUEST_SIGNATURE_REQUIRED,
  SAML_XML_BASE64_MAX_LENGTH,
  idpSsoUrl,
  readRelayState,
} from './outbound-saml-shared'
import type { SamlServiceProvider } from './outbound-saml-shared'
import type { OutboundSsoRequest } from './outbound-sso-continuation'
import { readUniqueSamlFormField, readUniqueSamlQueryParameter } from './saml-binding-input'

type OutboundSsoMessage = {
  requestXml: string | null
  relayState: string | null
  redirectSignature?: {
    samlRequestEncoded: string
    relayState?: string | null
    signature: string
    sigAlg: string
    wireEncoded: {
      samlMessage: string
      relayState: string | null
      sigAlg: string
    }
  }
}

async function readOutboundSsoMessage(c: Context<XidHonoEnv>): Promise<OutboundSsoMessage> {
  if (c.req.method === 'POST') {
    const form = await c.req.formData()
    const request = readUniqueSamlFormField(form, 'SAMLRequest')
    const relay = readUniqueSamlFormField(form, 'RelayState')
    if (request !== undefined && typeof request !== 'string') {
      throw new AppError('malformed_request', { httpStatus: 400 })
    }
    const relayState = readRelayState(typeof relay === 'string' ? relay : undefined)
    if (request === undefined) return { requestXml: null, relayState }
    if (request.length === 0) throw new AppError('malformed_request', { httpStatus: 400 })
    const decoded = await decodeSamlBindingPayload(request, 'post')
    if (!decoded.ok) throw new AppError('malformed_request', { httpStatus: 400 })
    return { requestXml: decoded.value, relayState }
  }

  const requestParameter = readUniqueSamlQueryParameter(c.req.url, 'SAMLRequest')
  const standardRelayParameter = readUniqueSamlQueryParameter(c.req.url, 'RelayState')
  const legacyRelayParameter = readUniqueSamlQueryParameter(c.req.url, 'relay_state')
  if (standardRelayParameter !== undefined && legacyRelayParameter !== undefined) {
    throw new AppError('malformed_request', { httpStatus: 400 })
  }
  const relayParameter = standardRelayParameter ?? legacyRelayParameter
  const signatureParameter = readUniqueSamlQueryParameter(c.req.url, 'Signature')
  const sigAlgParameter = readUniqueSamlQueryParameter(c.req.url, 'SigAlg')
  const request = requestParameter?.value
  const relay = relayParameter?.value
  const signature = signatureParameter?.value
  const sigAlg = sigAlgParameter?.value
  const relayState = readRelayState(relay)
  if (request === undefined) {
    if (signature !== undefined || sigAlg !== undefined) {
      throw new AppError('malformed_request', { httpStatus: 400 })
    }
    return { requestXml: null, relayState }
  }
  if (request.length === 0) throw new AppError('malformed_request', { httpStatus: 400 })
  if (request.length > SAML_XML_BASE64_MAX_LENGTH) {
    throw new AppError('malformed_request', { httpStatus: 400 })
  }
  if ((signature === undefined) !== (sigAlg === undefined) || signature === '' || sigAlg === '') {
    throw new AppError('malformed_request', { httpStatus: 400 })
  }
  const decoded = await decodeSamlBindingPayload(request, 'redirect')
  if (!decoded.ok) throw new AppError('malformed_request', { httpStatus: 400 })
  return {
    requestXml: decoded.value,
    relayState,
    ...(signature && sigAlg
      ? {
          redirectSignature: {
            samlRequestEncoded: request,
            relayState,
            signature,
            sigAlg,
            wireEncoded: {
              samlMessage: requestParameter!.wireValue,
              relayState: relayParameter?.wireValue ?? null,
              sigAlg: sigAlgParameter!.wireValue,
            },
          },
        }
      : {}),
  }
}

function throwOutboundAuthnRequestError(code: string): never {
  if (code === 'signature_required' || code === 'signature_invalid' || code === 'weak_algorithm') {
    throw new AppError('signature_invalid', { httpStatus: 401 })
  }
  throw new AppError('malformed_request', { httpStatus: 400 })
}

export async function readVerifiedOutboundSsoRequest(
  c: Context<XidHonoEnv>,
  input: { appId: string; sp: SamlServiceProvider },
): Promise<OutboundSsoRequest> {
  const message = await readOutboundSsoMessage(c)
  const requestedAt = Date.now()
  if (!message.requestXml) {
    return {
      inResponseTo: undefined,
      relayState: message.relayState,
      forceAuthn: false,
      isPassive: false,
      nameIdFormat: undefined,
      requestedAuthnContext: null,
      authnContextAttempted: false,
      requestedAt,
    }
  }
  const verified = await verifySamlAuthnRequest(message.requestXml, {
    expectedIssuer: input.sp.spEntityId,
    expectedDestination: idpSsoUrl(c, input.appId),
    expectedAcsUrl: input.sp.acsUrl,
    spCertificatesB64: input.sp.spCertificates,
    requireSignature: OUTBOUND_AUTHN_REQUEST_SIGNATURE_REQUIRED,
    ...(message.redirectSignature ? { redirectSignature: message.redirectSignature } : {}),
  })
  if (!verified.ok) throwOutboundAuthnRequestError(verified.error.code)
  return {
    inResponseTo: verified.value.requestId,
    relayState: message.relayState,
    forceAuthn: verified.value.forceAuthn,
    isPassive: verified.value.isPassive,
    nameIdFormat: verified.value.nameIdPolicy?.format,
    requestedAuthnContext: verified.value.requestedAuthnContext,
    authnContextAttempted: false,
    requestedAt,
  }
}
