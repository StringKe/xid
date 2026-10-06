import { Trans, useLingui } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import type { PlatformStats } from '@xid-kit/types'
import { MetricsBand } from '@xid-kit/web-ui/ui'

export function formatLoginSuccessRate(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`
}

export function PlatformMetricsBand({ data }: { data: PlatformStats }): ReactNode {
  const { t } = useLingui()
  const rate = data.loginSuccessRate
  return (
    <MetricsBand
      items={[
        { label: <Trans>Daily active users</Trans>, value: data.dau.toLocaleString(), size: 'lg' },
        {
          label: <Trans>Monthly active users</Trans>,
          value: data.mau.toLocaleString(),
          size: 'lg',
        },
        {
          label: <Trans>Login success rate (30 days)</Trans>,
          value: rate === null ? t`No data` : formatLoginSuccessRate(rate),
          size: 'md',
          ...(rate === null ? {} : { tone: rate >= 0.95 ? ('good' as const) : ('bad' as const) }),
        },
        {
          label: <Trans>Active organizations</Trans>,
          value: data.activeOrgCount.toLocaleString(),
          size: 'md',
        },
      ]}
      side={[
        {
          term: <Trans>Total organizations</Trans>,
          value: data.organizationCount.toLocaleString(),
        },
        { term: <Trans>Total users</Trans>, value: data.totalUsers.toLocaleString() },
      ]}
    />
  )
}
