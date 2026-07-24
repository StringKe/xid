// 第 4 组契约:instance/tenant 签名密钥材料 + 信封加密结构。
// 对照 docs/design/08-data-model.md 16.3 instance_signing_keys、signing-keys rule(KEK 信封加密,多 kid 四步轮换)。

// 签名算法(默认 ES256,对外兼容 RS256/PS256,见 signing-keys rule)
export const SIGNING_ALGS = ['ES256', 'RS256', 'PS256'] as const
export type SigningAlg = (typeof SIGNING_ALGS)[number]

// 密钥状态机:四步轮换(active 当前签名 / next 已发布未签名 / retiring 旧公钥待删,见 08 章 16.3)
export const SIGNING_KEY_STATUSES = ['active', 'next', 'retiring'] as const
export type SigningKeyStatus = (typeof SIGNING_KEY_STATUSES)[number]

// 信封加密的私钥密文(AES-256-GCM,KEK 存 Workers Secrets,iv/ciphertext/tag 拆字段,见 08 章 16.3 决策、signing-keys rule)。
// 私钥明文永不入库,仅在 isolate 内短暂存在。
export type EnvelopeEncryptedKey = {
  iv: Uint8Array
  ciphertext: Uint8Array
  tag: Uint8Array
  kekVersion: number
  kid: string
  alg: SigningAlg
}

// 单个签名密钥材料:公钥 JWK(JWKS 直出)+ 信封加密私钥 + 状态。
// JsonWebKey 来自 lib.dom.d.ts / workers-types 全局,描述 RFC7517 JWK 结构。
export type SigningKeyMaterial = {
  kid: string
  alg: SigningAlg
  status: SigningKeyStatus
  publicKeyJwk: JsonWebKey
  encryptedPrivateKey: EnvelopeEncryptedKey
}
