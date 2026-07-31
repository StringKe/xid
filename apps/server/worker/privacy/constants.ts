export const PRIVACY_EXPORT_TTL_MS = 48 * 60 * 60 * 1000
export const PRIVACY_DELETE_GRACE_MS = 30 * 24 * 60 * 60 * 1000
export const PRIVACY_PROCESSING_LEASE_MS = 10 * 60 * 1000
export const PRIVACY_PAGE_SIZE = 100

export type PrivacyRequestType = 'export' | 'delete'
export type PrivacyRequestStatus = 'pending' | 'processing' | 'completed' | 'canceled' | 'expired'

export type PrivacyRequestRow = {
  id: string
  tenantId: string
  userId: string
  requestType: PrivacyRequestType
  status: PrivacyRequestStatus
  storageKey: string | null
  contentType: string | null
  availableAt: number | null
  expiresAt: number | null
  scheduledFor: number | null
  processingStartedAt: number | null
  completedAt: number | null
  canceledAt: number | null
  errorCode: string | null
  createdAt: number
  updatedAt: number
}
