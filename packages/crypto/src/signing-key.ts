// 签名密钥:私钥信封加密后落库,明文仅在 isolate 短暂存在并清零;算法默认 ES256。

import type {
  EnvelopeEncryptedKey,
  SigningAlg,
  SigningKeyMaterial,
  SigningKeyStatus,
} from '@xid-kit/types'

import { toBufferSource } from './buffer-source'
import { envelopeEncrypt, envelopeDecrypt, toEnvelopeEncryptedKey } from './envelope'

type AlgParams = {
  generate: SubtleCryptoGenerateKeyAlgorithm
  importPrivate: SubtleCryptoImportKeyAlgorithm
}

const RSA_MODULUS_LENGTH = 2048
const RSA_PUBLIC_EXPONENT = new Uint8Array([0x01, 0x00, 0x01])

function algParams(alg: SigningAlg): AlgParams {
  if (alg === 'ES256') {
    return {
      generate: { name: 'ECDSA', namedCurve: 'P-256' },
      importPrivate: { name: 'ECDSA', namedCurve: 'P-256' },
    }
  }
  // RS256/PS256 共用 RSA 密钥材料,签名算法在 jwt 按 alg 区分。
  const hash = 'SHA-256'
  const rsaName = alg === 'RS256' ? 'RSASSA-PKCS1-v1_5' : 'RSA-PSS'
  return {
    generate: {
      name: rsaName,
      modulusLength: RSA_MODULUS_LENGTH,
      publicExponent: RSA_PUBLIC_EXPONENT,
      hash,
    },
    importPrivate: { name: rsaName, hash },
  }
}

export type GeneratedSigningKey = {
  material: SigningKeyMaterial
  signingKey: CryptoKey
}

// extractable 生成 -> 导出 PKCS8 -> 信封加密 -> 以不可导出方式重载,避免 extractable 句柄外传。
export async function generateTenantSigningKey(options: {
  kid: string
  kekRaw: Uint8Array
  kekVersion: number
  alg?: SigningAlg
  status?: SigningKeyStatus
}): Promise<GeneratedSigningKey> {
  const alg = options.alg ?? 'ES256'
  const status = options.status ?? 'next'
  const params = algParams(alg)

  const pair = (await crypto.subtle.generateKey(params.generate, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair

  // workers-types exportKey 返回联合类型,按 format 收窄。
  const publicKeyJwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey
  const pkcs8 = new Uint8Array(
    (await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer,
  )

  const blob = await envelopeEncrypt(pkcs8, options.kekRaw, options.kekVersion)
  pkcs8.fill(0) // 清零明文私钥

  const encryptedPrivateKey = toEnvelopeEncryptedKey(blob, options.kid, alg)
  const signingKey = await loadSigningKey(encryptedPrivateKey, options.kekRaw)

  return {
    material: { kid: options.kid, alg, status, publicKeyJwk, encryptedPrivateKey },
    signingKey,
  }
}

export async function loadSigningKey(
  encrypted: EnvelopeEncryptedKey,
  kekRaw: Uint8Array,
): Promise<CryptoKey> {
  const pkcs8 = await envelopeDecrypt(encrypted, kekRaw)
  const params = algParams(encrypted.alg)
  const key = await crypto.subtle.importKey(
    'pkcs8',
    toBufferSource(pkcs8),
    params.importPrivate,
    false,
    ['sign'],
  )
  pkcs8.fill(0) // 清零明文私钥
  return key
}

// 四步轮换纯状态机(不碰 DB):publish_next -> promote_active -> retire_old。
export type RotationStep = 'publish_next' | 'promote_active' | 'retire_old'

export type RotationPlanEntry = {
  kid: string
  status: SigningKeyStatus
}

export function planRotation(
  current: readonly { kid: string; status: SigningKeyStatus }[],
  step: RotationStep,
  targetKid: string,
): RotationPlanEntry[] {
  if (step === 'publish_next') {
    return [
      ...current.map((k) => ({ kid: k.kid, status: k.status })),
      { kid: targetKid, status: 'next' as const },
    ]
  }
  if (step === 'promote_active') {
    return current.map((k) => {
      if (k.kid === targetKid) return { kid: k.kid, status: 'active' as const }
      if (k.status === 'active') return { kid: k.kid, status: 'retiring' as const }
      return { kid: k.kid, status: k.status }
    })
  }
  return current.filter((k) => k.kid !== targetKid).map((k) => ({ kid: k.kid, status: k.status }))
}
