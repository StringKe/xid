// 用户列表筛选写进 URL:每个条件可单独删除,刷新和后退都能还原。只透传已知键,orgId 保留。

export const USER_STATUS_OPTIONS = ['active', 'banned', 'deleted'] as const
export const SIGN_IN_METHOD_OPTIONS = ['password', 'passkey', 'social', 'sso', 'guest'] as const

export type UserStatusFilter = (typeof USER_STATUS_OPTIONS)[number]
export type SignInMethodFilter = (typeof SIGN_IN_METHOD_OPTIONS)[number]

export type UserFilters = {
  search: string
  status: UserStatusFilter | null
  signInMethod: SignInMethodFilter | null
  createdFrom: string | null
  createdTo: string | null
  lastSignInFrom: string | null
  lastSignInTo: string | null
}

export const EMPTY_USER_FILTERS: UserFilters = {
  search: '',
  status: null,
  signInMethod: null,
  createdFrom: null,
  createdTo: null,
  lastSignInFrom: null,
  lastSignInTo: null,
}

const PARAM: Record<Exclude<keyof UserFilters, 'search'>, string> = {
  status: 'status',
  signInMethod: 'sign_in_method',
  createdFrom: 'created_from',
  createdTo: 'created_to',
  lastSignInFrom: 'last_sign_in_from',
  lastSignInTo: 'last_sign_in_to',
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function pick<T extends string>(value: string | null, allowed: readonly T[]): T | null {
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : null
}

function date(value: string | null): string | null {
  return value !== null && ISO_DATE.test(value) ? value : null
}

export function readUserFilters(params: URLSearchParams): UserFilters {
  return {
    search: params.get('q') ?? '',
    status: pick(params.get(PARAM.status), USER_STATUS_OPTIONS),
    signInMethod: pick(params.get(PARAM.signInMethod), SIGN_IN_METHOD_OPTIONS),
    createdFrom: date(params.get(PARAM.createdFrom)),
    createdTo: date(params.get(PARAM.createdTo)),
    lastSignInFrom: date(params.get(PARAM.lastSignInFrom)),
    lastSignInTo: date(params.get(PARAM.lastSignInTo)),
  }
}

export function writeUserFilters(params: URLSearchParams, filters: UserFilters): string {
  const next = new URLSearchParams()
  const orgId = params.get('orgId')
  if (orgId) next.set('orgId', orgId)
  if (filters.search.trim()) next.set('q', filters.search.trim())
  for (const [key, param] of Object.entries(PARAM) as [keyof typeof PARAM, string][]) {
    const value = filters[key]
    if (value) next.set(param, value)
  }
  const text = next.toString()
  return text ? `?${text}` : ''
}

// 「至」日期包含当天:按 UTC 当天末尾传给后端。
function endOfDay(value: string): string {
  return `${value}T23:59:59.999Z`
}

export function userFilterQuery(filters: UserFilters): Record<string, string | undefined> {
  return {
    search: filters.search.trim() || undefined,
    status: filters.status ?? undefined,
    sign_in_method: filters.signInMethod ?? undefined,
    created_from: filters.createdFrom ?? undefined,
    created_to: filters.createdTo ? endOfDay(filters.createdTo) : undefined,
    last_sign_in_from: filters.lastSignInFrom ?? undefined,
    last_sign_in_to: filters.lastSignInTo ? endOfDay(filters.lastSignInTo) : undefined,
  }
}

export function activeFilterCount(filters: UserFilters): number {
  return (Object.keys(PARAM) as (keyof typeof PARAM)[]).filter((key) => filters[key] !== null)
    .length
}

export function exportHref(filters: UserFilters): string {
  const params = new URLSearchParams({ format: 'csv' })
  for (const [key, value] of Object.entries(userFilterQuery(filters))) {
    if (value) params.set(key, value)
  }
  return `/v1/users/export?${params.toString()}`
}

// 「最近 N 天」折算为 UTC 起始日期,与后端按 UTC 比较一致。
export function daysAgo(days: number, now: Date = new Date()): string {
  const start = new Date(now.getTime() - days * 86_400_000)
  return start.toISOString().slice(0, 10)
}
