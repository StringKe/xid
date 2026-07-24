// @xid-kit/crypto:信封加密 + per-tenant 签名密钥 + JWT 签验 + JWKS(Web Crypto)。
// 密码学原语只用 Web Crypto,禁止自研/禁第三方密码学库(见 crypto-boundary / signing-keys rule)。

export const PACKAGE = '@xid-kit/crypto'

// SHA-256 摘要 + HMAC-SHA256(Web Crypto 原语)
export { sha256Hex, sha256HexBytes, hmacSha256Base64, hmacSha256Verify } from './digest'

// Web Crypto BufferSource 归一化(TS 5.7 Uint8Array 泛型兼容)
export { toBufferSource } from './buffer-source'

// base64url 格式编解码(自研,无第三方)
export {
  base64UrlEncode,
  base64UrlEncodeString,
  base64UrlDecode,
  base64UrlDecodeToString,
} from './base64url'

// 信封加密(AES-256-GCM,iv/ciphertext/tag 三段)
export type { EnvelopeBlob } from './envelope'
export { envelopeEncrypt, envelopeDecrypt, toEnvelopeEncryptedKey } from './envelope'

// per-tenant 签名密钥生成/载入/四步轮换纯逻辑
export type { GeneratedSigningKey, RotationStep, RotationPlanEntry } from './signing-key'
export { generateTenantSigningKey, loadSigningKey, planRotation } from './signing-key'

// JWT 签发/校验(ES256/RS256/PS256)
export type {
  JwtHeader,
  JwtClaims,
  VerifyKey,
  VerifyKeySet,
  VerifyOptions,
  VerifiedJwt,
  JwtVerifyError,
} from './jwt'
export { signJwt, verifyJwt } from './jwt'

// ECDSA 签名 DER <-> P1363 转换(互操作用)
export { p1363ToDer, derToP1363 } from './ecdsa-sig'

// JWKS 构建与公钥 JWK 导出/导入
export type { PublicJwk, Jwks } from './jwks'
export { exportPublicJwk, buildJwks, importJwkForVerify } from './jwks'
