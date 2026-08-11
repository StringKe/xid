// challenge/origin/rpIdHash/signature 四验证无跳过；可信值由调用方注入，本包只验证不碰存储。

export const PACKAGE = '@xid-kit/webauthn'

export type { CborValue, CborMap } from './cbor'
export { cborDecode, cborDecodeFirst } from './cbor'
export type { ParsedCoseKey } from './cose'
export { parseCoseKey, parseCoseKeyAt } from './cose'

export type { AuthDataFlags, AttestedCredentialData, ParsedAuthData } from './authdata'
export { parseAuthData, deriveDeviceType } from './authdata'

export type { ClientData, ClientDataCheck, ClientDataReason } from './parse'
export { checkClientData, constantTimeEqual } from './parse'

export type { AttestationConveyance, AttestationVerificationResult } from './attestation'
export { verifyEnterpriseAttestation, parseAttestationStatement } from './attestation'
export { verifyRegistration } from './verify-registration'
export type { RegistrationVerificationOptions } from './verify-registration'
export { verifyAuthentication, detectSignCountAnomaly } from './verify-authentication'
