// @xid-kit/webauthn:WebAuthn 验证编排(四验证,无跳过)。
// challenge/origin/rpIdHash/signature 四验证缺一不可;可信值由调用方从 DO + TenantContext 注入,本包只验证不碰存储。
// 见 docs/design/01-authentication.md 第 1 节、.claude/rules/webauthn.md。

export const PACKAGE = '@xid-kit/webauthn'

// CBOR / COSE 格式编解码(自研,非安全敏感)
export type { CborValue, CborMap } from './cbor'
export { cborDecode, cborDecodeFirst } from './cbor'
export type { ParsedCoseKey } from './cose'
export { parseCoseKey, parseCoseKeyAt } from './cose'

// authenticatorData 字节解析
export type { AuthDataFlags, AttestedCredentialData, ParsedAuthData } from './authdata'
export { parseAuthData, deriveDeviceType } from './authdata'

// clientDataJSON 解析与校验
export type { ClientData, ClientDataCheck, ClientDataReason } from './parse'
export { checkClientData, constantTimeEqual } from './parse'

// 验证编排
export type { AttestationConveyance, AttestationVerificationResult } from './attestation'
export { verifyEnterpriseAttestation, parseAttestationStatement } from './attestation'
export { verifyRegistration } from './verify-registration'
export type { RegistrationVerificationOptions } from './verify-registration'
export { verifyAuthentication, detectSignCountAnomaly } from './verify-authentication'
