// per-tenant 签名密钥:生成 + 信封加密私钥 + 不可导出载入 + 四步轮换纯逻辑(见 signing-keys rule、08 章 16.3)。
// 算法默认 ES256,兼容 RS256/PS256。私钥明文只在 isolate 内短暂存在,永不入库(信封加密后即丢弃明文)。

import type {
  EnvelopeEncryptedKey,
  SigningAlg,
  SigningKeyMaterial,
  SigningKeyStatus,
} from '@xid-kit/types'

import { toBufferSource } from './buffer-source'
import { envelopeEncrypt, envelopeDecrypt, toEnvelopeEncryptedKey } from './envelope'

// SigningAlg -> Web Crypto generateKey/importKey 算法参数(workers-types SubtleCrypto*Algorithm)。
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
  // RS256 / PS256 共用 RSA 密钥;签名/验签算法在 jwt 模块按 alg 区分(RSASSA-PKCS1-v1_5 vs RSA-PSS)。
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

// 生成结果:落库材料(公钥 JWK + 信封加密私钥)+ isolate 内可直接签名的私钥句柄。
export type GeneratedSigningKey = {
  material: SigningKeyMaterial
  signingKey: CryptoKey
}

// 生成一对密钥,信封加密私钥后丢弃明文。extractable 生成 -> 导出 PKCS8 -> 信封加密 -> 重新以不可导出方式载入。
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

  // exportKey 返回 ArrayBuffer | JsonWebKey 联合(workers-types 无 format 字面量重载),按 format 收窄。
  const publicKeyJwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey
  const pkcs8 = new Uint8Array(
    (await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer,
  )

  const blob = await envelopeEncrypt(pkcs8, options.kekRaw, options.kekVersion)
  pkcs8.fill(0) // 立即清零明文私钥字节,不在内存久留

  const encryptedPrivateKey = toEnvelopeEncryptedKey(blob, options.kid, alg)
  // 以不可导出方式从信封密文重新载入,供本 isolate 内签名;extractable 生成句柄不外传,明文已清零。
  const signingKey = await loadSigningKey(encryptedPrivateKey, options.kekRaw)

  return {
    material: { kid: options.kid, alg, status, publicKeyJwk, encryptedPrivateKey },
    signingKey,
  }
}

// 从信封加密私钥载入为不可导出签名 CryptoKey(运行时取密文 -> KEK 解密 -> importKey,见 signing-keys rule)。
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
  pkcs8.fill(0) // 明文私钥字节清零
  return key
}

// 四步轮换纯状态逻辑(不碰 DB):给定当前密钥集与目标新 kid,产出每个 kid 的目标状态。
// 步骤(见 signing-keys rule):1 加新公钥(next) -> 2 等缓存 TTL -> 3 切签名(active) -> 4 旧公钥退役(retiring)删除。
export type RotationStep = 'publish_next' | 'promote_active' | 'retire_old'

export type RotationPlanEntry = {
  kid: string
  status: SigningKeyStatus
}

// 计算轮换后各 kid 的目标状态。promote_active:next -> active,原 active -> retiring。
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
  // retire_old:删除目标 retiring kid(旧 token 已过期)。
  return current.filter((k) => k.kid !== targetKid).map((k) => ({ kid: k.kid, status: k.status }))
}
