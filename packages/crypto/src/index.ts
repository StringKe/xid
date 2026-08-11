// 密码学原语只用 Web Crypto;协议与业务逻辑自研,不引入第三方密码学库。

export const PACKAGE = '@xid-kit/crypto'

export { sha256Hex, sha256HexBytes, hmacSha256Base64, hmacSha256Verify } from './digest'

export { toBufferSource } from './buffer-source'

export {
  base64UrlEncode,
  base64UrlEncodeString,
  base64UrlDecode,
  base64UrlDecodeToString,
} from './base64url'

export type { RandomValues } from './random'
export { randomString } from './random'

export type { EnvelopeBlob } from './envelope'
export { envelopeEncrypt, envelopeDecrypt, toEnvelopeEncryptedKey } from './envelope'

export type { GeneratedSigningKey, RotationStep, RotationPlanEntry } from './signing-key'
export { generateTenantSigningKey, loadSigningKey, planRotation } from './signing-key'

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

export { p1363ToDer, derToP1363 } from './ecdsa-sig'

export type { PublicJwk, Jwks } from './jwks'
export { exportPublicJwk, buildJwks, importJwkForVerify } from './jwks'
