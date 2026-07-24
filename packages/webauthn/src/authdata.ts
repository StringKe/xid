// authenticatorData 字节解析(W3C WebAuthn L3 §6.1)。见 docs/design/01-authentication.md authData 字节结构表。
// 固定头 37 字节:rpIdHash[0..32] + flags[32] + signCount[33..37](uint32 big-endian)。
// flags.AT=1 时跟 attestedCredentialData;flags.ED=1 时跟 extensions(CBOR map)。
// 纯字节解析(格式编解码自研);COSE 公钥解析委托 cose.ts。

import { parseCoseKeyAt } from './cose'
import type { ParsedCoseKey } from './cose'

const RP_ID_HASH_LEN = 32
const FLAGS_OFFSET = 32
const SIGN_COUNT_OFFSET = 33
const HEADER_LEN = 37
const AAGUID_LEN = 16
const CRED_ID_LEN_MAX = 1023

// flags 位定义(LSB=bit0,见 01 章 flags 位定义)。
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
  // 规范化后的 COSE public key 字节(注册原样持久化,见 01 章 step 9)。
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

// 解析 attestedCredentialData(从 authData 偏移 37 起):aaguid[16] + credIdLen[2] + credId[L] + COSE_Key。
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

// 解析 authenticatorData。注册需 attestedCredentialData(AT=1);认证通常无(37 字节 + 可选 extensions)。
export async function parseAuthData(authData: Uint8Array): Promise<ParsedAuthData> {
  if (authData.length < HEADER_LEN) throw new Error('authData: shorter than 37-byte header')
  const flags = parseFlags(authData[FLAGS_OFFSET]!)
  const view = new DataView(authData.buffer, authData.byteOffset, authData.byteLength)
  const signCount = view.getUint32(SIGN_COUNT_OFFSET, false)
  // 约束:BE=0 时 BS 必须为 0(见 01 章 flags 位定义)。
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

// BE/BS 派生:credentialDeviceType / credentialBackedUp(见 VerifiedPasskey 字段)。
export function deriveDeviceType(flags: AuthDataFlags): 'singleDevice' | 'multiDevice' {
  return flags.backupEligible ? 'multiDevice' : 'singleDevice'
}
