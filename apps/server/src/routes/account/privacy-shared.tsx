// Data & privacy 与删除账户页共用:授权范围的人话描述、导出状态。

import { useLingui } from '@lingui/react/macro'
import type { PrivacyRequest } from './types'

const SEE_SCOPES = ['profile', 'email', 'phone', 'organization'] as const

export function useScopeSummary(): (scopes: readonly string[]) => string {
  const { t, i18n } = useLingui()
  const labels: Record<(typeof SEE_SCOPES)[number], string> = {
    profile: t`your name`,
    email: t`your email`,
    phone: t`your phone number`,
    organization: t`your organizations`,
  }
  return (scopes) => {
    const known = SEE_SCOPES.filter((scope) => scopes.includes(scope)).map((scope) => labels[scope])
    const custom = scopes.filter(
      (scope) =>
        !SEE_SCOPES.includes(scope as (typeof SEE_SCOPES)[number]) &&
        scope !== 'openid' &&
        scope !== 'offline_access',
    )
    const see = new Intl.ListFormat(i18n.locale, { type: 'conjunction' }).format([
      ...known,
      ...custom,
    ])
    const stays = scopes.includes('offline_access')
    if (see && stays) return t`Can see ${see}, and stay signed in`
    if (see) return t`Can see ${see}`
    if (stays) return t`Can stay signed in`
    return t`Can confirm who you are`
  }
}

export function latestExport(
  requests: readonly PrivacyRequest[] | undefined,
): PrivacyRequest | null {
  return requests?.find((request) => request.type === 'export') ?? null
}

export function isExportInProgress(request: PrivacyRequest | null): boolean {
  return request?.status === 'pending' || request?.status === 'processing'
}
