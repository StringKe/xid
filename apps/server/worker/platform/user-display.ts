import type { GlobalUserStatus } from '@xid-kit/types'

// users.status 内部取值 -> 公开契约(active|inactive|banned);deleted/pending 等归 inactive,不泄露内部状态名。
export function toGlobalUserStatus(status: string): GlobalUserStatus {
  if (status === 'banned') return 'banned'
  if (status === 'active') return 'active'
  return 'inactive'
}

export function displayNameOf(row: {
  displayName: string | null
  firstName: string | null
  lastName: string | null
}): string | null {
  if (row.displayName) return row.displayName
  const joined = [row.firstName, row.lastName].filter(Boolean).join(' ').trim()
  return joined.length > 0 ? joined : null
}
