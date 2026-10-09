// 入站 SLO 的 binding 读写:解析 POST / Redirect 的 LogoutRequest,输出自动提交的 LogoutResponse 表单。

import type { Context } from 'hono'
import { AppError } from '../lib/errors'
import type { XidHonoEnv } from '../lib/types'
import { readUniqueSamlFormField, readUniqueSamlQueryParameter } from './saml-binding-input'
import { RELAY_STATE_MAX, parseShape, sloPostFormSchema, sloRedirectQuerySchema } from './saml-form'

function htmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function sloPostForm(input: {
  destination: string
  samlResponse: string
  relayState: string | null
}): string {
  const relay =
    input.relayState !== null
      ? `<input type="hidden" name="RelayState" value="${htmlEscape(input.relayState)}">`
      : ''
  return [
    `<!doctype html>`,
    `<html><body>`,
    `<form method="post" action="${htmlEscape(input.destination)}">`,
    `<input type="hidden" name="SAMLResponse" value="${htmlEscape(input.samlResponse)}">`,
    relay,
    `</form>`,
    `<script>document.forms[0].submit()</script>`,
    `</body></html>`,
  ].join('')
}

export async function readSloRequest(c: Context<XidHonoEnv>): Promise<{
  encoded: string
  binding: 'post' | 'redirect'
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
}> {
  const readRelayState = (value: string | undefined): string | null => {
    if (value === undefined) return null
    if (value.length > RELAY_STATE_MAX) {
      throw new AppError('malformed_request', { httpStatus: 400 })
    }
    return value
  }
  if (c.req.method === 'POST') {
    const form = await c.req.formData()
    const parsed = parseShape(sloPostFormSchema, {
      SAMLRequest: readUniqueSamlFormField(form, 'SAMLRequest'),
      RelayState: readUniqueSamlFormField(form, 'RelayState'),
    })
    return {
      encoded: parsed.SAMLRequest,
      binding: 'post',
      relayState: readRelayState(parsed.RelayState),
    }
  }
  const requestParameter = readUniqueSamlQueryParameter(c.req.url, 'SAMLRequest')
  const relayStateParameter = readUniqueSamlQueryParameter(c.req.url, 'RelayState')
  const signatureParameter = readUniqueSamlQueryParameter(c.req.url, 'Signature')
  const sigAlgParameter = readUniqueSamlQueryParameter(c.req.url, 'SigAlg')
  const parsed = parseShape(sloRedirectQuerySchema, {
    SAMLRequest: requestParameter?.value,
    RelayState: relayStateParameter?.value,
    Signature: signatureParameter?.value,
    SigAlg: sigAlgParameter?.value,
  })
  const relayState = readRelayState(parsed.RelayState)
  if (!parsed.Signature || !parsed.SigAlg) {
    throw new AppError('malformed_request', { httpStatus: 400 })
  }
  return {
    encoded: parsed.SAMLRequest,
    binding: 'redirect',
    relayState,
    redirectSignature: {
      samlRequestEncoded: parsed.SAMLRequest,
      relayState,
      signature: parsed.Signature,
      sigAlg: parsed.SigAlg,
      wireEncoded: {
        samlMessage: requestParameter!.wireValue,
        relayState: relayStateParameter?.wireValue ?? null,
        sigAlg: sigAlgParameter!.wireValue,
      },
    },
  }
}
