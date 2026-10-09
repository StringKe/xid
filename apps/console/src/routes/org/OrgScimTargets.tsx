// 出站 SCIM 目标列表;?targetId= 进入目标详情。

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { useLocation, useNavigate, useSearchParams } from '@xid-kit/web-ui/tanstack-router'
import { Badge, Button, EmptyState, Icon, IdentityCell } from '@xid-kit/web-ui/ui'
import { DataTable } from '@xid-kit/web-ui/ui/DataTable'
import type { DataTableColumnDef } from '@xid-kit/web-ui/ui/DataTable'
import { PageFrame } from '../../components/page/PageFrame'
import { list } from '../../components/page/list-styles'
import { formatDateTime } from '../../lib/date-format'
import { withOrgId } from '../users/UsersList'
import { useCreateScimTarget, useOrgScimTargetsQuery } from './queries'
import ScimTargetDetail, { EMPTY_TARGET_FORM, TargetDialog } from './ScimTargetDetail'
import { ScimTargetRunState } from './ScimTargetRunState'
import type { ScimTarget } from './types'
import { useOrgTarget } from './useOrgTarget'

const TARGETS_PATH = '/console/org/scim-targets'

export default function OrgScimTargets(): ReactNode {
  const [params] = useSearchParams()
  const location = useLocation()
  const targetId = params.get('targetId')
  if (targetId) {
    return (
      <ScimTargetDetail
        key={targetId}
        targetId={targetId}
        listPath={withOrgId(TARGETS_PATH, location.search)}
      />
    )
  }
  return <TargetsList />
}

function detailPath(search: string, targetId: string): string {
  const next = new URLSearchParams(search)
  next.set('targetId', targetId)
  return `${TARGETS_PATH}?${next.toString()}`
}

function TargetsList(): ReactNode {
  const { t, i18n } = useLingui()
  const location = useLocation()
  const navigate = useNavigate()
  const { orgId, orgName } = useOrgTarget()
  const targets = useOrgScimTargetsQuery(orgId)
  const create = useCreateScimTarget(orgId)
  const [adding, setAdding] = useState(false)
  const rows = targets.data ?? []
  const open = (row: Pick<ScimTarget, 'id'>) => navigate(detailPath(location.search, row.id))

  const columns: DataTableColumnDef<ScimTarget>[] = [
    {
      id: 'target',
      header: () => t`Target`,
      cell: ({ row }) => (
        <IdentityCell
          name={row.original.provider}
          secondary={row.original.baseUrl}
          secondaryIsCode
        />
      ),
      meta: { priority: 'primary', width: '40%' },
    },
    {
      id: 'lastRun',
      header: () => t`Last run`,
      cell: ({ row }) => <ScimTargetRunState target={row.original} />,
      meta: { priority: 'primary' },
    },
    {
      id: 'token',
      header: () => t`API token`,
      cell: ({ row }) =>
        row.original.hasToken ? (
          <Badge tone="success">
            <Trans>Configured</Trans>
          </Badge>
        ) : (
          <Badge tone="warning">
            <Trans>Missing</Trans>
          </Badge>
        ),
      meta: { hidden: { narrow: true, regular: false } },
    },
    {
      id: 'sync',
      header: () => t`Last successful sync`,
      cell: ({ row }) =>
        row.original.lastSyncAt ? (
          <span {...stylex.props(list.numeric)}>
            {formatDateTime(i18n, row.original.lastSyncAt)}
          </span>
        ) : (
          <span {...stylex.props(list.muted)}>{t`Never`}</span>
        ),
      meta: { align: 'end', hidden: { narrow: true, regular: true, sidebar: false } },
    },
  ]

  const isEmpty = targets.data !== undefined && rows.length === 0

  return (
    <PageFrame
      title={<Trans>Provisioning</Trans>}
      lead={
        <Trans>
          Push {orgName} members to the SCIM APIs of other services. Members who leave are
          deactivated there.
        </Trans>
      }
      actions={
        isEmpty || !targets.data ? null : (
          <Button onClick={() => setAdding(true)}>
            <Icon name="plus" size={16} />
            <Trans>Add target…</Trans>
          </Button>
        )
      }
    >
      {targets.isError && !targets.data ? (
        <EmptyState
          variant="load-failure"
          title={<Trans>Targets could not be loaded</Trans>}
          description={<Trans>Nothing changed. Check your connection and try again.</Trans>}
          action={
            <Button variant="secondary" onClick={() => void targets.refetch()}>
              <Trans>Try again</Trans>
            </Button>
          }
        />
      ) : isEmpty ? (
        <EmptyState
          variant="first-use"
          title={<Trans>No services receive {orgName} members yet</Trans>}
          description={
            <Trans>
              Add the SCIM endpoint and API token of a service such as Slack or Fleet Planner. XID
              pushes members after removals and deactivations, and at least once a day.
            </Trans>
          }
          action={
            <Button onClick={() => setAdding(true)}>
              <Icon name="plus" size={16} />
              <Trans>Add target…</Trans>
            </Button>
          }
        />
      ) : (
        <DataTable
          columns={columns}
          data={rows}
          getRowId={(row) => row.id}
          isLoading={targets.isLoading}
          onRowClick={open}
          density="comfortable"
          narrowMode="priority"
          caption={t`Provisioning targets`}
          captionDisplay="hidden"
          emptyMessage={<Trans>No targets.</Trans>}
        />
      )}
      {adding ? (
        <TargetDialog
          title={<Trans>Add target</Trans>}
          description={
            <Trans>XID stores the API token encrypted and never shows it again after saving.</Trans>
          }
          initial={EMPTY_TARGET_FORM}
          isEdit={false}
          isPending={create.isPending}
          error={create.error}
          submitLabel={<Trans>Add target</Trans>}
          onSubmit={(payload) =>
            create.mutate(payload, {
              onSuccess: (target) => {
                setAdding(false)
                open(target)
              },
            })
          }
          onClose={() => setAdding(false)}
        />
      ) : null}
    </PageFrame>
  )
}
