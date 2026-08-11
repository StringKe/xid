// instance 签名密钥材料与 KEK 信封加密结构（见 signing-keys rule）。

export const SIGNING_ALGS = ['ES256', 'RS256', 'PS256'] as const
export type SigningAlg = (typeof SIGNING_ALGS)[number]

// 四步轮换：active 当前签名 / next 已发布未签名 / retiring 旧公钥待删
export const SIGNING_KEY_STATUSES = ['active', 'next', 'retiring'] as const
export type SigningKeyStatus = (typeof SIGNING_KEY_STATUSES)[number]

// AES-256-GCM 密文分字段存 D1；私钥明文永不入库，仅 isolate 内短暂存在
export type EnvelopeEncryptedKey = {
  iv: Uint8Array
  ciphertext: Uint8Array
  tag: Uint8Array
  kekVersion: number
  kid: string
  alg: SigningAlg
}

export type SigningKeyMaterial = {
  kid: string
  alg: SigningAlg
  status: SigningKeyStatus
  publicKeyJwk: JsonWebKey
  encryptedPrivateKey: EnvelopeEncryptedKey
}
