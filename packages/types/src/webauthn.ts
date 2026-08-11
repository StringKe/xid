// WebAuthn 四验证（challenge/origin/rpIdHash/signature）输入与产出；无跳过路径。

export const COSE_ALGS = [-7, -257, -8] as const
export type CoseAlg = (typeof COSE_ALGS)[number]

export const AUTHENTICATOR_TRANSPORTS = [
  'usb',
  'nfc',
  'ble',
  'internal',
  'hybrid',
  'smart-card',
] as const
export type AuthenticatorTransport = (typeof AUTHENTICATOR_TRANSPORTS)[number]

export const WEBAUTHN_CEREMONIES = ['registration', 'authentication'] as const
export type WebAuthnCeremony = (typeof WEBAUTHN_CEREMONIES)[number]

// 私钥永不入库，只存 COSE 公钥字节
export type StoredCredential = {
  credentialId: Uint8Array
  publicKey: Uint8Array
  coseAlg: CoseAlg
  signCount: number
  aaguid: Uint8Array
}

// client 只透传字节；rpId/origin/challenge 由 Worker 从 TenantContext + DO 注入，DO 不持租户配置
export type WebAuthnVerificationInput = {
  ceremony: WebAuthnCeremony
  expectedChallenge: Uint8Array
  expectedRpId: string
  expectedOrigins: readonly string[]
  clientDataJson: Uint8Array
  authenticatorData: Uint8Array
  signature?: Uint8Array
  storedCredential?: StoredCredential
  attestationObject?: Uint8Array
  userHandle?: Uint8Array
}

export type VerifiedPasskey = {
  credentialId: Uint8Array
  publicKey: Uint8Array
  coseAlg: CoseAlg
  aaguid: Uint8Array
  signCount: number
  // UV 必须为 true；缺失不得降级
  userVerified: boolean
  transports: readonly AuthenticatorTransport[]
  credentialDeviceType: 'singleDevice' | 'multiDevice'
  credentialBackedUp: boolean
  // 新 sign_count <= 历史非零值：标记异常触发风险审查，不直接拒绝
  signCountAnomaly: boolean
  attestationFmt?: string
  enterpriseAttestationVerified?: boolean
}
