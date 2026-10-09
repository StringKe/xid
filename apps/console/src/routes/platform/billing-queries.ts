// MAU 上报对账的数据契约与 hook,对应 /v1/platform/billing/meter-reports。

import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query'
import type { PlatformPage, XidError } from '@xid-kit/types'
import { queryKeyPrefixes, useApiMutation, useApiQuery } from '@xid-kit/web-ui/queries'

export type MeterReconciliationAction = 'mark_reported' | 'report_again'

export type MeterReconciliation = {
  tenantId: string
  organizationName: string | null
  period: string
  identifier: string
  value: number
  reportedValue: number
  targetValue: number
  customerId: string
  eventTimestamp: string
  sentAt: string | null
  reconciliationRequiredAt: string
}

export type MeterReconciliationResolve = {
  tenantId: string
  period: string
  identifier: string
  action: MeterReconciliationAction
}

const meterReconciliationKey = ['platform', 'billing', 'meter-reports'] as const

export function useMeterReconciliations(
  enabled: boolean,
): UseQueryResult<PlatformPage<MeterReconciliation>, XidError> {
  return useApiQuery<PlatformPage<MeterReconciliation>>(
    meterReconciliationKey,
    '/v1/platform/billing/meter-reports',
    { enabled, query: { limit: 100 } },
  )
}

export function useResolveMeterReconciliation(): UseMutationResult<
  { resolved: true; identifier: string | null },
  XidError,
  MeterReconciliationResolve
> {
  return useApiMutation(
    (api, body) =>
      api.post<{ resolved: true; identifier: string | null }>(
        '/v1/platform/billing/meter-reports/resolve',
        body,
      ),
    { invalidate: [meterReconciliationKey, queryKeyPrefixes.platformUsage] },
  )
}
