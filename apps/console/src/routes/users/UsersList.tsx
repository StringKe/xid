// 租户用户目录:筛选写进 URL,每个条件可单独删除;游标分页只有上一页 / 下一页。
// 状态:加载(骨架 200ms 后出现)、加载失败(固定文案 + 重试,不显示空状态)、首次为空、筛选无结果。

import { Plural, Trans, useLingui } from '@lingui/react/macro'
import { useCallback, useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { useAuth } from '@xid-kit/web-ui/session'
import { organizationDisplayName } from '@xid-kit/web-ui/display-names'
import { useLocation, useNavigate, useSearchParams } from '@xid-kit/web-ui/tanstack-router'
import { Button, EmptyState } from '@xid-kit/web-ui/ui'
import { DataTable } from '@xid-kit/web-ui/ui/DataTable'
import { PageFrame } from '../../components/page/PageFrame'
import { list } from '../../components/page/list-styles'
import { ORG_USERS_PATH } from '../../nav'
import { CreateUserDialog } from './CreateUserDialog'
import { UserActionDialogs, useUserActionState } from './UserActions'
import { UserFilterBar, UserFilterChips } from './UserFilterBar'
import { useUserList } from './user-api'
import type { UserListRow } from './user-api'
import { useUserColumns } from './user-columns'
import { activeFilterCount, readUserFilters, writeUserFilters } from './user-filters'
import type { UserFilters } from './user-filters'
import { isGuestUser, userDisplayName } from './user-format'

export function withOrgId(path: string, search: string): string {
  const orgId = new URLSearchParams(search).get('orgId')
  return orgId ? `${path}?orgId=${encodeURIComponent(orgId)}` : path
}

export default function UsersList(): ReactNode {
  const { t, i18n } = useLingui()
  const { activeOrg } = useAuth()
  const [params] = useSearchParams()
  const location = useLocation()
  const navigate = useNavigate()
  const filters = readUserFilters(params)
  const [cursors, setCursors] = useState<(string | null)[]>([null])
  const cursor = cursors[cursors.length - 1] ?? null
  const users = useUserList(filters, cursor)
  const actions = useUserActionState()
  const [creating, setCreating] = useState(false)

  const updateFilters = useCallback(
    (next: UserFilters) => {
      setCursors([null])
      navigate(`${location.pathname}${writeUserFilters(params, next)}`, { replace: true })
    },
    [location.pathname, navigate, params],
  )
  const openUser = (row: { id: string }) =>
    navigate(withOrgId(`${ORG_USERS_PATH}/${row.id}`, location.search))
  const columns = useUserColumns((row: UserListRow, action) =>
    actions.open(
      {
        id: row.id,
        name: userDisplayName(i18n, row, isGuestUser(row)),
        email: row.primaryEmail,
        status: row.status,
      },
      action,
    ),
  )

  const page = users.data
  const filtered = activeFilterCount(filters) > 0 || filters.search.trim() !== ''
  const orgName = activeOrg ? organizationDisplayName(activeOrg) : ''
  const shownCount = i18n.number(page?.total ?? 0)
  const allCount = i18n.number(page ? page.counts.active + page.counts.banned : 0)
  const firstUse = page !== undefined && !filtered && page.total === 0

  return (
    <PageFrame
      title={<Trans>Users</Trans>}
      lead={
        <Trans>
          Everyone who can sign in to {orgName}, including guests and people who belong to no
          organization yet.
        </Trans>
      }
    >
      <UserFilterBar
        filters={filters}
        counts={page?.counts}
        onChange={updateFilters}
        onCreate={() => setCreating(true)}
      />
      {page ? (
        <div {...stylex.props(list.summaryRow)}>
          <span {...stylex.props(list.summary)}>
            {filtered ? (
              <Trans>
                {shownCount} of {allCount} users
              </Trans>
            ) : (
              <Plural value={page.total} one="# user" other="# users" />
            )}
          </span>
          <UserFilterChips filters={filters} onChange={updateFilters} />
        </div>
      ) : null}
      {users.isError && !page ? (
        <EmptyState
          variant="load-failure"
          title={<Trans>Users could not be loaded</Trans>}
          description={<Trans>Nothing changed. Check your connection and try again.</Trans>}
          action={
            <Button variant="secondary" onClick={() => void users.refetch()}>
              <Trans>Try again</Trans>
            </Button>
          }
        />
      ) : firstUse ? (
        <EmptyState
          variant="first-use"
          title={<Trans>No users yet</Trans>}
          description={
            <Trans>
              People appear here after they sign up, accept an invitation, arrive through directory
              sync, or you create them.
            </Trans>
          }
          action={
            <Button onClick={() => setCreating(true)}>
              <Trans>Create user…</Trans>
            </Button>
          }
        />
      ) : (
        <>
          <DataTable
            columns={columns}
            data={page?.data ?? []}
            getRowId={(row) => row.id}
            isLoading={users.isLoading}
            onRowClick={openUser}
            density="comfortable"
            narrowMode="priority"
            caption={t`Users`}
            emptyMessage={
              <span {...stylex.props(list.footnote)}>
                <Trans>No users match these filters.</Trans>{' '}
                <button
                  type="button"
                  onClick={() => updateFilters(readUserFilters(new URLSearchParams()))}
                  {...stylex.props(list.textButton)}
                >
                  <Trans>Clear filters</Trans>
                </button>
              </span>
            }
          />
          {page && (cursors.length > 1 || page.has_more) ? (
            <div {...stylex.props(list.footer)}>
              <p {...stylex.props(list.footnote)}>
                <Trans>Showing 50 per page, newest first</Trans>
              </p>
              <div {...stylex.props(list.pager)}>
                <Button
                  variant="secondary"
                  disabled={cursors.length <= 1 || users.isFetching}
                  onClick={() => setCursors(cursors.slice(0, -1))}
                  {...stylex.props(list.pagerButton)}
                >
                  <Trans>Previous</Trans>
                </Button>
                <Button
                  variant="secondary"
                  disabled={!page.has_more || users.isFetching}
                  onClick={() => setCursors([...cursors, page.next_cursor])}
                  {...stylex.props(list.pagerButton)}
                >
                  <Trans>Next</Trans>
                </Button>
              </div>
            </div>
          ) : null}
        </>
      )}
      <UserActionDialogs action={actions.action} target={actions.target} onClose={actions.close} />
      <CreateUserDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(userId) => {
          setCreating(false)
          openUser({ id: userId })
        }}
      />
    </PageFrame>
  )
}
