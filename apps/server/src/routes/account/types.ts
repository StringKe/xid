// /v1/me/* account portal 响应契约(camelCase);数据读取统一走 ./queries 的 react-query hook。

export type UserProfile = {
  id: string
  firstName: string | null
  lastName: string | null
  displayName: string | null
  username: string | null
  email: string
  emailVerified: boolean
  imageUrl: string | null
  locale: string | null
  timezone: string | null
}

export type UpdateProfilePayload = {
  firstName?: string | null
  lastName?: string | null
  displayName?: string | null
  locale?: string | null
  timezone?: string | null
}

export type TotpFactor = {
  id: string
  type: 'totp'
  createdAt: string
}

export type BackupCodeFactor = {
  id: string
  type: 'backup_codes'
  remaining: number
  createdAt: string
}

export type SmsFactor = {
  id: string
  type: 'sms'
  createdAt: string
}

export type PasskeyFactor = {
  id: string
  type: 'passkey'
  deviceName: string | null
  createdAt: string
}

export type MfaFactor = TotpFactor | BackupCodeFactor | SmsFactor | PasskeyFactor

export type SmsFactorOption = {
  enrollable: boolean
  phoneLast4: string | null
}

export type TotpSetupResponse = {
  factorId: string
  secret: string
  otpauthUri: string
}

export type BackupCodesResponse = {
  batchId: string
  codes: string[]
}

export type PasskeyCredential = {
  id: string
  deviceName: string | null
  createdAt: string
  lastUsedAt: string | null
  transports: readonly string[]
  backedUp: boolean
  deviceType: 'singleDevice' | 'multiDevice'
  // 早期在实例主域登记:仍可在组织地址登录,建议在当前地址重新创建
  earlier?: boolean
}

export type PasskeyList = {
  data: PasskeyCredential[]
  limit: number
}

export type PasskeySignalData = {
  rpId: string
  userId: string
  name: string
  displayName: string
  allAcceptedCredentialIds: string[]
}

export type SocialConnection = {
  id: string
  provider: string
  providerAccountId: string
  email: string | null
  connectedAt: string
}

export type Impersonator = {
  userId: string
  displayName: string | null
  email: string | null
}

export type ActiveSession = {
  id: string
  deviceName: string | null
  deviceFingerprint: string | null
  ipAddress: string | null
  userAgent: string | null
  location: string | null
  amr: readonly string[]
  signedInAt: string
  lastActiveAt: string
  expiresAt: string
  isCurrent: boolean
  isImpersonation: boolean
  impersonator: Impersonator | null
}

export type EmailAddress = {
  id: string
  email: string
  verified: boolean
  isPrimary: boolean
  pending: boolean
  expiresAt: string | null
  createdAt: string | null
}

export type PhoneNumber = {
  id: string
  phone: string
  verified: boolean
  isPrimary: boolean
  pending: boolean
  expiresAt: string | null
  createdAt: string | null
}

export type PhoneList = {
  data: PhoneNumber[]
  canAdd: boolean
}

export type PasswordStatus = {
  hasPassword: boolean
  updatedAt: string | null
  breached: boolean
}

export type AuthorizedApp = {
  clientId: string
  name: string
  logoUrl: string | null
  redirectOrigin: string | null
  grantedScopes: string[]
  createdAt: string
  updatedAt: string
}

export type PrivacyRequest = {
  id: string
  type: 'export' | 'delete'
  status: 'pending' | 'processing' | 'completed' | 'canceled' | 'expired'
  availableAt: string | null
  expiresAt: string | null
  scheduledFor: string | null
  completedAt: string | null
  canceledAt: string | null
  errorCode: string | null
  downloadUrl: string | null
  createdAt: string
  updatedAt: string
}
