// clientDataJSON 校验：challenge 等长 constant-time 比对；可预期失败回判别原因，格式损坏 throw。

import { base64UrlDecode } from '@xid-kit/crypto'
import type { WebAuthnCeremony } from '@xid-kit/types'

export type ClientData = {
  type: string
  challenge: string
  origin: string
  crossOrigin?: boolean
  tokenBinding?: { status?: string; id?: string }
}

export type ClientDataReason =
  | 'malformed'
  | 'type_mismatch'
  | 'challenge_invalid'
  | 'origin_mismatch'

export type ClientDataCheck =
  | { ok: true; clientData: ClientData }
  | { ok: false; reason: ClientDataReason }

const CEREMONY_TYPE: Record<WebAuthnCeremony, string> = {
  registration: 'webauthn.create',
  authentication: 'webauthn.get',
}

// 等长字节 constant-time 比对；长度不等直接 false，避免长度旁路。
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a[i]! ^ b[i]!
  }
  return diff === 0
}

function parseClientDataJson(bytes: Uint8Array): ClientData {
  const text = new TextDecoder().decode(bytes)
  const parsed = JSON.parse(text) as unknown
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('clientDataJSON: not an object')
  }
  const obj = parsed as Record<string, unknown>
  if (
    typeof obj.type !== 'string' ||
    typeof obj.challenge !== 'string' ||
    typeof obj.origin !== 'string'
  ) {
    throw new Error('clientDataJSON: missing required string fields')
  }
  const result: ClientData = { type: obj.type, challenge: obj.challenge, origin: obj.origin }
  if (typeof obj.crossOrigin === 'boolean') result.crossOrigin = obj.crossOrigin
  const tb = obj.tokenBinding
  if (typeof tb === 'object' && tb !== null) {
    const tbObj = tb as Record<string, unknown>
    result.tokenBinding = {
      status: typeof tbObj.status === 'string' ? tbObj.status : undefined,
      id: typeof tbObj.id === 'string' ? tbObj.id : undefined,
    }
  }
  return result
}

export function checkClientData(input: {
  clientDataJson: Uint8Array
  ceremony: WebAuthnCeremony
  expectedChallenge: Uint8Array
  expectedOrigins: readonly string[]
}): ClientDataCheck {
  let clientData: ClientData
  try {
    clientData = parseClientDataJson(input.clientDataJson)
  } catch {
    return { ok: false, reason: 'malformed' }
  }

  if (clientData.type !== CEREMONY_TYPE[input.ceremony]) {
    return { ok: false, reason: 'type_mismatch' }
  }

  let challengeBytes: Uint8Array
  try {
    challengeBytes = base64UrlDecode(clientData.challenge)
  } catch {
    return { ok: false, reason: 'challenge_invalid' }
  }
  if (!constantTimeEqual(challengeBytes, input.expectedChallenge)) {
    return { ok: false, reason: 'challenge_invalid' }
  }

  if (!input.expectedOrigins.includes(clientData.origin)) {
    return { ok: false, reason: 'origin_mismatch' }
  }

  // 禁止跨源 iframe 内发起仪式（crossOrigin=true 映射为 origin 失败）。
  if (clientData.crossOrigin === true) {
    return { ok: false, reason: 'origin_mismatch' }
  }

  return { ok: true, clientData }
}
