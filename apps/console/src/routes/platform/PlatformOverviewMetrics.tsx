
import { Trans } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import { MetricsBand } from '@xid-kit/web-ui/ui'

export type PlatformStats = {
  organizationCount: number
  totalUsers: number
  dau: number
  mau: number
  loginSuccessRate: number
  activeOrgCount: number
}

export function PlatformMetricsBand({ data }: { data: PlatformStats }): ReactNode {
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
          label: <Trans>Login success rate</Trans>,
          value: `${(data.loginSuccessRate * 100).toFixed(1)}%`,
          size: 'md',
          tone: data.loginSuccessRate >= 0.95 ? 'good' : 'bad',
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
