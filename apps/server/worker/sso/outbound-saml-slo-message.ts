// 出站 SAML IdP 的 SLO 消息读取:SAMLRequest 与 SAMLResponse 严格二选一。HTTP-Redirect 必须携带
// detached Signature/SigAlg，HTTP-POST 的签名位于 XML 内。
// 形状失败按 malformed_request 400(协议错误格式),不走 validation_failed,故用 safeParse 自映射。

import type { Context } from 'hono'
import * as v from 'valibot'
import { AppError } from '../lib/errors'
import type { XidHonoEnv } from '../lib/types'
import { readUniqueSamlFormField, readUniqueSamlQueryParameter } from './saml-binding-input'
import type { SamlQueryParameter } from './saml-binding-input'
import {
  RELAY_STATE_MAX_LENGTH,
  SAML_XML_BASE64_MAX_LENGTH,
  readRelayState,
} from './outbound-saml-shared'

const outboundSloMessageSchema = v.pipe(
  v.object({
    SAMLRequest: v.optional(
      v.pipe(v.string(), v.minLength(1), v.maxLength(SAML_XML_BASE64_MAX_LENGTH)),
    ),
    SAMLResponse: v.optional(
      v.pipe(v.string(), v.minLength(1), v.maxLength(SAML_XML_BASE64_MAX_LENGTH)),
    ),
    RelayState: v.optional(v.pipe(v.string(), v.maxLength(RELAY_STATE_MAX_LENGTH))),
    Signature: v.optional(v.pipe(v.string(), v.minLength(1))),
    SigAlg: v.optional(v.pipe(v.string(), v.minLength(1))),
  }),
  v.check(
    (input) => (input.SAMLRequest === undefined) !== (input.SAMLResponse === undefined),
    'exactly one of SAMLRequest or SAMLResponse is required',
  ),
)

type WireEncodedSignature = {
  samlMessage: string
  relayState: string | null
  sigAlg: string
}

export type OutboundSloMessage =
  | {
      kind: 'request'
      encoded: string
      binding: 'post' | 'redirect'
      relayState: string | null
      redirectSignature?: {
        samlRequestEncoded: string
        relayState?: string | null
        signature: string
        sigAlg: string
        wireEncoded: WireEncodedSignature
      }
    }
  | {
      kind: 'response'
      encoded: string
      binding: 'post' | 'redirect'
      relayState: string | null
      redirectSignature?: {
        samlResponseEncoded: string
        relayState?: string | null
        signature: string
        sigAlg: string
        wireEncoded: WireEncodedSignature
      }
    }

export async function readOutboundSloMessage(c: Context<XidHonoEnv>): Promise<OutboundSloMessage> {
  const isPost = c.req.method === 'POST'
  // FormData 值可能是 File,交给 schema 拒绝,故输入按 unknown 收集。
  let input: Record<string, unknown>
  let requestParameter: SamlQueryParameter | undefined
  let responseParameter: SamlQueryParameter | undefined
  let relayStateParameter: SamlQueryParameter | undefined
  let signatureParameter: SamlQueryParameter | undefined
  let sigAlgParameter: SamlQueryParameter | undefined
  if (isPost) {
    const form = await c.req.formData()
    input = {
      SAMLRequest: readUniqueSamlFormField(form, 'SAMLRequest'),
      SAMLResponse: readUniqueSamlFormField(form, 'SAMLResponse'),
      RelayState: readUniqueSamlFormField(form, 'RelayState'),
    }
  } else {
    requestParameter = readUniqueSamlQueryParameter(c.req.url, 'SAMLRequest')
    responseParameter = readUniqueSamlQueryParameter(c.req.url, 'SAMLResponse')
    relayStateParameter = readUniqueSamlQueryParameter(c.req.url, 'RelayState')
    signatureParameter = readUniqueSamlQueryParameter(c.req.url, 'Signature')
    sigAlgParameter = readUniqueSamlQueryParameter(c.req.url, 'SigAlg')
    input = {
      SAMLRequest: requestParameter?.value,
      SAMLResponse: responseParameter?.value,
      RelayState: relayStateParameter?.value,
      Signature: signatureParameter?.value,
      SigAlg: sigAlgParameter?.value,
    }
  }
  const result = v.safeParse(outboundSloMessageSchema, input)
  if (!result.success) throw new AppError('malformed_request', { httpStatus: 400 })
  const parsed = result.output
  const binding = isPost ? ('post' as const) : ('redirect' as const)
  const relayState = readRelayState(parsed.RelayState)
  if (binding === 'redirect' && (!parsed.Signature || !parsed.SigAlg)) {
    throw new AppError('malformed_request', { httpStatus: 400 })
  }
  if (parsed.SAMLRequest !== undefined) {
    return {
      kind: 'request',
      encoded: parsed.SAMLRequest,
      binding,
      relayState,
      ...(binding === 'redirect'
        ? {
            redirectSignature: {
              samlRequestEncoded: parsed.SAMLRequest,
              relayState,
              signature: parsed.Signature!,
              sigAlg: parsed.SigAlg!,
              wireEncoded: {
                samlMessage: requestParameter!.wireValue,
                relayState: relayStateParameter?.wireValue ?? null,
                sigAlg: sigAlgParameter!.wireValue,
              },
            },
          }
        : {}),
    }
  }
  if (parsed.SAMLResponse === undefined) {
    throw new AppError('malformed_request', { httpStatus: 400 })
  }
  return {
    kind: 'response',
    encoded: parsed.SAMLResponse,
    binding,
    relayState,
    ...(binding === 'redirect'
      ? {
          redirectSignature: {
            samlResponseEncoded: parsed.SAMLResponse,
            relayState,
            signature: parsed.Signature!,
            sigAlg: parsed.SigAlg!,
            wireEncoded: {
              samlMessage: responseParameter!.wireValue,
              relayState: relayStateParameter?.wireValue ?? null,
              sigAlg: sigAlgParameter!.wireValue,
            },
          },
        }
      : {}),
  }
}
