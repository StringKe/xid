// org 概览页的指标与次要计数(全宽锚定版式):
// OrgStats -> 共享 ui/MetricsBand(全宽指标带:活跃数 lg / 安全率 md)的数据映射层;
// 成员/邀请次要计数从带尾移出,作 SecondaryCounts ledger 列(mono microlabel + clamp 数值,
// 行间 1px hairline),由 OrgOverview 编排进 7fr/5fr 双列的次列。

import { Trans } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { MetricsBand as MetricsBandShell } from '@xid-kit/web-ui/ui'
import { page } from '@xid-kit/web-ui/styles/product-surface.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'

export type OrgStats = {
  dau: number
  mau: number
  loginSuccessRate: number
  mfaAdoptionRate: number
  activeMemberCount: number
  pendingInvitationCount: number
}

const countStyles = stylex.create({
  list: {
    margin: 0,
    display: 'flex',
    flexDirection: 'column',
  },
  row: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
  },
  // 首行零顶距:microlabel 顶线与相邻 Trends 区头同 y 对齐(跨竖分隔的签名行)。
  // hairline 邻接 >= 1.25rem:行文本与行间分隔线各保 >= 1.25rem(clamp 下限对齐口径)。
  rowLead: {
    paddingBottom: 'clamp(1.25rem, 1.2vw, 1.75rem)',
  },
  rowTail: {
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
    paddingTop: 'clamp(1.25rem, 1.2vw, 1.75rem)',
  },
  value: {
    margin: 0,
    fontSize: 'clamp(1.5rem, 1.05rem + 0.7vw, 2rem)',
    fontWeight: 470,
    fontVariantNumeric: 'tabular-nums',
    lineHeight: 1.05,
    letterSpacing: '-0.02em',
    color: tokens['--xid-fg'],
  },
})

export function MetricsBand({ data }: { data: OrgStats }): ReactNode {
  return (
    <MetricsBandShell
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
          label: <Trans>MFA adoption</Trans>,
          value: `${(data.mfaAdoptionRate * 100).toFixed(1)}%`,
          size: 'md',
          tone: data.mfaAdoptionRate >= 0.5 ? 'good' : undefined,
        },
      ]}
    />
  )
}

export function SecondaryCounts({ data }: { data: OrgStats }): ReactNode {
  return (
    <dl {...stylex.props(countStyles.list)}>
      <div {...stylex.props(countStyles.row, countStyles.rowLead)}>
        <dt {...stylex.props(page.sectionLabel)}>
          <Trans>Active members</Trans>
        </dt>
        <dd {...stylex.props(countStyles.value)}>{data.activeMemberCount.toLocaleString()}</dd>
      </div>
      <div {...stylex.props(countStyles.row, countStyles.rowTail)}>
        <dt {...stylex.props(page.sectionLabel)}>
          <Trans>Pending invitations</Trans>
        </dt>
        <dd {...stylex.props(countStyles.value)}>{data.pendingInvitationCount.toLocaleString()}</dd>
      </div>
    </dl>
  )
}
