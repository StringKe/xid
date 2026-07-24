// COSE_Key(RFC 9052)解析为 CryptoKey。支持 EC2(ES256)/ RSA(RS256)/ OKP(EdDSA)。
// 密码学原语只用 Web Crypto importKey(见 crypto-boundary rule);CBOR/COSE 解码是格式编解码,自研无第三方。
// 见 docs/design/01-authentication.md "COSE_Key 解析为 CryptoKey"。

import { base64UrlEncode } from '@xid-kit/crypto'
import type { CoseAlg } from '@xid-kit/types'

import { cborDecode, cborDecodeFirst } from './cbor'
import type { CborMap, CborValue } from './cbor'

// COSE_Key 整数 label(RFC 9052 §7、RFC 9053)。
const LABEL_KTY = 1
const LABEL_ALG = 3
const LABEL_EC2_CRV = -1
const LABEL_EC2_X = -2
const LABEL_EC2_Y = -3
const LABEL_OKP_CRV = -1
const LABEL_OKP_X = -2
const LABEL_RSA_N = -1
const LABEL_RSA_E = -2

const KTY_OKP = 1
const KTY_EC2 = 2
const KTY_RSA = 3
const CRV_P256 = 1
const CRV_ED25519 = 6

const ALG_ES256: CoseAlg = -7
const ALG_RS256: CoseAlg = -257
const ALG_EDDSA: CoseAlg = -8

export type ParsedCoseKey = {
  alg: CoseAlg
  key: CryptoKey
}

function asInt(value: CborValue | undefined): number {
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  throw new Error('cose key: expected integer label value')
}

function asBytes(value: CborValue | undefined): Uint8Array {
  if (value instanceof Uint8Array) return value
  throw new Error('cose key: expected byte string')
}

function importEc2(map: CborMap): Promise<CryptoKey> {
  const crv = asInt(map.get(LABEL_EC2_CRV))
  if (crv !== CRV_P256) throw new Error('cose key: EC2 crv must be P-256')
  const x = asBytes(map.get(LABEL_EC2_X))
  const y = asBytes(map.get(LABEL_EC2_Y))
  if (x.length !== 32 || y.length !== 32) throw new Error('cose key: EC2 x/y must be 32 bytes')
  const jwk: JsonWebKey = {
    kty: 'EC',
    crv: 'P-256',
    x: base64UrlEncode(x),
    y: base64UrlEncode(y),
  }
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, [
    'verify',
  ])
}

function importOkp(map: CborMap): Promise<CryptoKey> {
  const crv = asInt(map.get(LABEL_OKP_CRV))
  if (crv !== CRV_ED25519) throw new Error('cose key: OKP crv must be Ed25519')
  const x = asBytes(map.get(LABEL_OKP_X))
  if (x.length !== 32) throw new Error('cose key: OKP x must be 32 bytes')
  const jwk: JsonWebKey = {
    kty: 'OKP',
    crv: 'Ed25519',
    x: base64UrlEncode(x),
  }
  return crypto.subtle.importKey('jwk', jwk, { name: 'Ed25519' }, false, ['verify'])
}

function importRsa(map: CborMap): Promise<CryptoKey> {
  const n = asBytes(map.get(LABEL_RSA_N))
  const e = asBytes(map.get(LABEL_RSA_E))
  const jwk: JsonWebKey = {
    kty: 'RSA',
    n: base64UrlEncode(n),
    e: base64UrlEncode(e),
  }
  return crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  )
}

async function importFromMap(map: CborMap): Promise<ParsedCoseKey> {
  const kty = asInt(map.get(LABEL_KTY))
  const alg = asInt(map.get(LABEL_ALG)) as CoseAlg

  if (kty === KTY_OKP) {
    if (alg !== ALG_EDDSA) throw new Error('cose key: OKP alg must be EdDSA')
    return { alg: ALG_EDDSA, key: await importOkp(map) }
  }
  if (kty === KTY_EC2) {
    if (alg !== ALG_ES256) throw new Error('cose key: EC2 alg must be ES256')
    return { alg: ALG_ES256, key: await importEc2(map) }
  }
  if (kty === KTY_RSA) {
    if (alg !== ALG_RS256) throw new Error('cose key: RSA alg must be RS256')
    return { alg: ALG_RS256, key: await importRsa(map) }
  }
  throw new Error(`cose key: unsupported kty ${kty}`)
}

// 解析完整 COSE_Key 字节(整个输入即一个 map)。注册时持久化的 publicKey 走此路径复用。
export async function parseCoseKey(coseBytes: Uint8Array): Promise<ParsedCoseKey> {
  const decoded = cborDecode(coseBytes)
  if (!(decoded instanceof Map)) throw new Error('cose key: expected CBOR map')
  return importFromMap(decoded)
}

// 从 authData 偏移处解析 COSE_Key,返回 key 与消费的字节数(credentialPublicKey 长度由 CBOR 决定)。
export async function parseCoseKeyAt(
  authData: Uint8Array,
  offset: number,
): Promise<{ parsed: ParsedCoseKey; bytesUsed: number; coseBytes: Uint8Array }> {
  const { value, bytesUsed } = cborDecodeFirst(authData.subarray(offset))
  if (!(value instanceof Map)) throw new Error('cose key: expected CBOR map')
  const parsed = await importFromMap(value)
  return { parsed, bytesUsed, coseBytes: authData.slice(offset, offset + bytesUsed) }
}
