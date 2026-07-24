// clientDataJSON 解析与校验(W3C WebAuthn L3 §7.1/§7.2,见 01 章 clientDataJSON 校验)。
// type/challenge/origin/crossOrigin 校验,challenge 走 constant-time 等长字节比对(防 timing)。
// 可预期失败返回判别原因,由调用方映射 XidError;格式损坏 throw。

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

// 等长字节常量时间比对(见 01 章 challenge constant-time 比对)。不等长直接 false,避免泄露长度旁路。
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

// 按 01 章 1-5 顺序校验 clientDataJSON。verification 1(challenge)与 verification 2(origin)在此完成。
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

  // 1. type
  if (clientData.type !== CEREMONY_TYPE[input.ceremony]) {
    return { ok: false, reason: 'type_mismatch' }
  }

  // 2. challenge:base64url 解码后 constant-time 比对(verification 1)
  let challengeBytes: Uint8Array
  try {
    challengeBytes = base64UrlDecode(clientData.challenge)
  } catch {
    return { ok: false, reason: 'challenge_invalid' }
  }
  if (!constantTimeEqual(challengeBytes, input.expectedChallenge)) {
    return { ok: false, reason: 'challenge_invalid' }
  }

  // 3. origin:精确匹配集合(scheme+host+port 全等,verification 2)
  if (!input.expectedOrigins.includes(clientData.origin)) {
    return { ok: false, reason: 'origin_mismatch' }
  }

  // 4. crossOrigin:存在且为 true 拒绝(不允许跨源 iframe 内调用)
  if (clientData.crossOrigin === true) {
    return { ok: false, reason: 'origin_mismatch' }
  }

  return { ok: true, clientData }
}
