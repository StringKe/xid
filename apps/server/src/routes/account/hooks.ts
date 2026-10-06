// account portal /v1/me/* 实体类型契约;数据读写见 ./queries。

export type UserProfile = {
  id: string
  firstName: string | null
  lastName: string | null
  displayName: string | null
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
}

export type SocialConnection = {
  id: string
  provider: string
  providerAccountId: string
  email: string | null
  connectedAt: string
}

export type ActiveSession = {
  id: string
  deviceName: string | null
  deviceFingerprint: string | null
  ipAddress: string | null
  lastActiveAt: string
  expiresAt: string
  isCurrent: boolean
}

export type TrustedDevice = {
  id: string
  deviceName: string | null
  fingerprint: string
  trustedAt: string
  lastSeenAt: string
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
