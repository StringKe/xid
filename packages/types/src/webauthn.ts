// 第 5 组契约:WebAuthn 四验证输入 + 验证产出。
// 对照 docs/design/01-authentication.md 第 1 节字节级流程(四验证:challenge/origin/rpIdHash/signature 无跳过路径)、webauthn rule。

// COSE 算法 label(RFC8152:ES256=-7 / RS256=-257 / EdDSA=-8)
export const COSE_ALGS = [-7, -257, -8] as const
export type CoseAlg = (typeof COSE_ALGS)[number]

// transports(navigator.credentials 上报,存 PasskeyCredential)
export const AUTHENTICATOR_TRANSPORTS = [
  'usb',
  'nfc',
  'ble',
  'internal',
  'hybrid',
  'smart-card',
] as const
export type AuthenticatorTransport = (typeof AUTHENTICATOR_TRANSPORTS)[number]

// 验证场景:注册(create)与认证(get),clientDataJSON.type 对应(见 01 章 clientDataJSON 校验)
export const WEBAUTHN_CEREMONIES = ['registration', 'authentication'] as const
export type WebAuthnCeremony = (typeof WEBAUTHN_CEREMONIES)[number]

// 已注册凭证(认证时从存储取出验签,见 01 章 9 认证流程 step 6)。私钥永不入库,只存 COSE 公钥字节。
export type StoredCredential = {
  credentialId: Uint8Array
  publicKey: Uint8Array
  coseAlg: CoseAlg
  signCount: number
  aaguid: Uint8Array
}

// 四验证输入。client 只透传 base64url 编码的字节,server 解码 + 验签(见 01 章 line 42)。
// 可信值(rpId / 允许 origin / challenge)由 Worker 从 TenantContext + DO 传入,DO 不持租户配置。
export type WebAuthnVerificationInput = {
  ceremony: WebAuthnCeremony
  // 来自匿名 session 绑定的 DO challenge(constant-time 比对,验证后销毁,见 01 章 challenge DO 边界)
  expectedChallenge: Uint8Array
  // rpIdHash = SHA-256(rpId),rpId 来自 TenantContext.rpId(verification 3)
  expectedRpId: string
  // origin 精确匹配集合(scheme+host+port),来自 TenantContext(verification 2)
  expectedOrigins: readonly string[]
  // client 透传(解码后字节)
  clientDataJson: Uint8Array
  authenticatorData: Uint8Array
  // 认证时存在:验签 signature 与对应的已注册凭证(verification 4)
  signature?: Uint8Array
  storedCredential?: StoredCredential
  // 注册时存在:attestationObject(解析 attestedCredentialData)
  attestationObject?: Uint8Array
  userHandle?: Uint8Array
}

// 验证产出:四验证全通过后的规范化凭证(注册落 PasskeyCredential,认证更新 sign_count)。
// 见 01 章 step 9(注册持久化)、step 7-8(认证 sign_count 克隆检测)。
export type VerifiedPasskey = {
  credentialId: Uint8Array
  publicKey: Uint8Array
  coseAlg: CoseAlg
  aaguid: Uint8Array
  // authData.signCount(注册通常 0,认证为本次新值)
  signCount: number
  // flags.UV(userVerification:required,必须为 1)
  userVerified: boolean
  transports: readonly AuthenticatorTransport[]
  // BE 派生:平台同步 passkey 为 true(见 01 章 flags 位定义)
  credentialDeviceType: 'singleDevice' | 'multiDevice'
  // BS 派生:已备份(见 01 章)
  credentialBackedUp: boolean
  // sign_count 克隆检测异常标记(新值 <= 历史非零值,触发风险审查而非拒绝,见 01 章 step 7)
  signCountAnomaly: boolean
  // 注册 attestation 格式与 enterprise 链验证结果(仅注册路径)
  attestationFmt?: string
  enterpriseAttestationVerified?: boolean
}
