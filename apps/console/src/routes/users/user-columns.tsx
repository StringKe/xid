// 用户表的列:标识列(头像 + 姓名 + 邮箱或手机或 ID)、状态、登录方式、组织、创建与最后登录、行尾菜单。
// 平板隐藏登录方式与创建时间,手机只留标识、状态与菜单。

import { useLingui } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import type { DataTableColumnDef } from '@xid-kit/web-ui/ui/DataTable'
import { Badge, IdentityCell } from '@xid-kit/web-ui/ui'
import { page } from '@xid-kit/web-ui/styles/product-surface.stylex'
import { list } from '../../components/page/list-styles'
import type { UserAction, UserListRow } from './user-api'
import {
  formatRelative,
  isGuestUser,
  organizationNameText,
  signInMethodsText,
  statusBadge,
  userDisplayName,
} from './user-format'
import { UserRowMenu } from './UserActions'
import { formatDate } from '../../lib/date-format'

function stop(event: { stopPropagation: () => void }): void {
  event.stopPropagation()
}

function Organizations({ row }: { row: UserListRow }): ReactNode {
  const { i18n } = useLingui()
  if (row.organizations.length === 0) {
    return <span {...stylex.props(list.muted)}>{i18n._(msg`No organization`)}</span>
  }
  const labels = row.organizations.map((org) => organizationNameText(i18n, org.name))
  const [names, ...rest] = labels
  if (names !== undefined && rest.length > 1) {
    // 多于两个时只列第一个:连词列表再接「and N more」会在 de/es/ko 等语言里出现两次连词。
    const more = rest.length
    return <>{i18n._(msg`${names} and ${more} more`)}</>
  }
  return <>{new Intl.ListFormat(i18n.locale, { type: 'conjunction' }).format(labels)}</>
}

export function useUserColumns(
  onAction: (row: UserListRow, action: UserAction) => void,
): DataTableColumnDef<UserListRow>[] {
  const { t, i18n } = useLingui()
  return [
    {
      id: 'user',
      header: () => t`User`,
      cell: ({ row }) => {
        const guest = isGuestUser(row.original)
        const name = userDisplayName(i18n, row.original, guest)
        const secondary = row.original.primaryEmail ?? row.original.primaryPhone ?? row.original.id
        return (
          <IdentityCell
            name={name}
            secondary={secondary}
            secondaryIsCode={secondary === row.original.id}
            avatarName={name}
          />
        )
      },
      meta: { priority: 'primary', width: '28%' },
    },
    {
      id: 'status',
      header: () => t`Status`,
      cell: ({ row }) => {
        const badge = statusBadge(i18n, row.original.status, isGuestUser(row.original))
        return <Badge tone={badge.tone}>{badge.label}</Badge>
      },
      meta: { priority: 'primary', width: '8rem' },
    },
    {
      id: 'methods',
      header: () => t`Sign-in methods`,
      cell: ({ row }) =>
        signInMethodsText(i18n, row.original.signInMethods) ?? (
          <span {...stylex.props(list.muted)}>{t`None set`}</span>
        ),
      meta: { hidden: { narrow: true, regular: true, sidebar: false } },
    },
    {
      id: 'organizations',
      header: () => t`Organizations`,
      cell: ({ row }) => <Organizations row={row.original} />,
      meta: { hidden: { narrow: true, regular: false } },
    },
    {
      id: 'created',
      header: () => t`Created`,
      cell: ({ row }) => (
        <span {...stylex.props(list.numeric)}>{formatDate(i18n, row.original.createdAt)}</span>
      ),
      meta: { align: 'end', hidden: { narrow: true, regular: true, sidebar: false } },
    },
    {
      id: 'last',
      header: () => t`Last sign-in`,
      cell: ({ row }) => (
        <span {...stylex.props(list.numeric)}>
          {formatRelative(i18n, row.original.lastLoginAt) ?? (
            <span {...stylex.props(list.muted)}>{t`Never`}</span>
          )}
        </span>
      ),
      meta: { align: 'end', hidden: { narrow: true, regular: false } },
    },
    {
      id: 'menu',
      header: () => <span {...stylex.props(page.visuallyHidden)}>{t`Actions`}</span>,
      cell: ({ row }) => {
        const guest = isGuestUser(row.original)
        return (
          <span onClick={stop} onKeyDown={stop} {...stylex.props(list.rowMenu)}>
            <UserRowMenu
              target={{
                id: row.original.id,
                name: userDisplayName(i18n, row.original, guest),
                email: row.original.primaryEmail,
                status: row.original.status,
              }}
              onSelect={(action) => onAction(row.original, action)}
            />
          </span>
        )
      },
      meta: { priority: 'primary', width: '3rem', align: 'end' },
    },
  ]
}
