// authenticatorData 解析（W3C WebAuthn L3 §6.1）：37 字节固定头后按 AT/ED 位接 attestedCredentialData 与 extensions。

import { parseCoseKeyAt } from './cose'
import type { ParsedCoseKey } from './cose'

const RP_ID_HASH_LEN = 32
const FLAGS_OFFSET = 32
const SIGN_COUNT_OFFSET = 33
const HEADER_LEN = 37
const AAGUID_LEN = 16
const CRED_ID_LEN_MAX = 1023

const FLAG_UP = 0x01
const FLAG_UV = 0x04
const FLAG_BE = 0x08
const FLAG_BS = 0x10
const FLAG_AT = 0x40
const FLAG_ED = 0x80

export type AuthDataFlags = {
  userPresent: boolean
  userVerified: boolean
  backupEligible: boolean
  backupState: boolean
  attestedCredentialData: boolean
  extensionData: boolean
}

export type AttestedCredentialData = {
  aaguid: Uint8Array
  credentialId: Uint8Array
  coseKey: ParsedCoseKey
  // 注册时原样持久化的 COSE 字节，认证路径再 importKey，避免编码往返漂移。
  coseKeyBytes: Uint8Array
}

export type ParsedAuthData = {
  rpIdHash: Uint8Array
  flags: AuthDataFlags
  signCount: number
  attestedCredentialData?: AttestedCredentialData
}

function parseFlags(byte: number): AuthDataFlags {
  return {
    userPresent: (byte & FLAG_UP) !== 0,
    userVerified: (byte & FLAG_UV) !== 0,
    backupEligible: (byte & FLAG_BE) !== 0,
    backupState: (byte & FLAG_BS) !== 0,
    attestedCredentialData: (byte & FLAG_AT) !== 0,
    extensionData: (byte & FLAG_ED) !== 0,
  }
}

async function parseAttestedCredentialData(authData: Uint8Array): Promise<AttestedCredentialData> {
  if (authData.length < HEADER_LEN + AAGUID_LEN + 2) {
    throw new Error('authData: truncated attestedCredentialData header')
  }
  const aaguid = authData.slice(HEADER_LEN, HEADER_LEN + AAGUID_LEN)
  const lenOffset = HEADER_LEN + AAGUID_LEN
  const credIdLen = (authData[lenOffset]! << 8) | authData[lenOffset + 1]!
  if (credIdLen > CRED_ID_LEN_MAX) throw new Error('authData: credentialId length exceeds 1023')
  const credIdStart = lenOffset + 2
  if (credIdStart + credIdLen > authData.length) {
    throw new Error('authData: truncated credentialId')
  }
  const credentialId = authData.slice(credIdStart, credIdStart + credIdLen)
  const coseOffset = credIdStart + credIdLen
  const { parsed, coseBytes } = await parseCoseKeyAt(authData, coseOffset)
  return { aaguid, credentialId, coseKey: parsed, coseKeyBytes: coseBytes }
}

export async function parseAuthData(authData: Uint8Array): Promise<ParsedAuthData> {
  if (authData.length < HEADER_LEN) throw new Error('authData: shorter than 37-byte header')
  const flags = parseFlags(authData[FLAGS_OFFSET]!)
  const view = new DataView(authData.buffer, authData.byteOffset, authData.byteLength)
  const signCount = view.getUint32(SIGN_COUNT_OFFSET, false)
  // BE=0 时 BS 必须为 0（规范非法组合，拒绝而非静默忽略）。
  if (!flags.backupEligible && flags.backupState) {
    throw new Error('authData: BS set while BE clear (illegal backup state)')
  }
  const result: ParsedAuthData = {
    rpIdHash: authData.slice(0, RP_ID_HASH_LEN),
    flags,
    signCount,
  }
  if (flags.attestedCredentialData) {
    result.attestedCredentialData = await parseAttestedCredentialData(authData)
  }
  return result
}

export function deriveDeviceType(flags: AuthDataFlags): 'singleDevice' | 'multiDevice' {
  return flags.backupEligible ? 'multiDevice' : 'singleDevice'
}
