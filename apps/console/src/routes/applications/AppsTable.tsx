// 应用表:应用(名称 + client ID)、类型与客户端说明、项目、同意页、更新时间。列表页与项目详情共用。

import { useLingui } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { IdentityCell } from '@xid-kit/web-ui/ui'
import type { DataTableColumnDef } from '@xid-kit/web-ui/ui/DataTable'
import { DataTable } from '@xid-kit/web-ui/ui/DataTable'
import { list } from '../../components/page/list-styles'
import { formatDate } from '../users/user-format'
import type { AppRecord } from './app-api'
import { clientSummary, consentSummary, kindLabel } from './app-format'

export function AppsTable({
  apps,
  isLoading,
  projectNames,
  showProject,
  onOpen,
  emptyMessage,
}: {
  apps: readonly AppRecord[]
  isLoading: boolean
  projectNames: ReadonlyMap<string, string>
  showProject: boolean
  onOpen: (app: AppRecord) => void
  emptyMessage: ReactNode
}): ReactNode {
  const { t, i18n } = useLingui()
  const columns: DataTableColumnDef<AppRecord>[] = [
    {
      id: 'app',
      header: () => t`Application`,
      cell: ({ row }) => (
        <IdentityCell name={row.original.name} secondary={row.original.client_id} secondaryIsCode />
      ),
      meta: { priority: 'primary', width: '30%' },
    },
    {
      id: 'type',
      header: () => t`Type`,
      cell: ({ row }) => (
        <span {...stylex.props(list.cellStack)}>
          <span>{kindLabel(i18n, row.original)}</span>
          <span {...stylex.props(list.cellSub)}>{clientSummary(i18n, row.original)}</span>
        </span>
      ),
      meta: { priority: 'primary' },
    },
    ...(showProject
      ? [
          {
            id: 'project',
            header: () => t`Project`,
            cell: ({ row }: { row: { original: AppRecord } }) =>
              row.original.project_id ? (
                (projectNames.get(row.original.project_id) ?? (
                  <span {...stylex.props(list.mono)}>{row.original.project_id}</span>
                ))
              ) : (
                <span {...stylex.props(list.muted)}>{t`No project`}</span>
              ),
            meta: { hidden: { narrow: true, regular: false } },
          } satisfies DataTableColumnDef<AppRecord>,
        ]
      : []),
    {
      id: 'consent',
      header: () => t`Consent screen`,
      cell: ({ row }) => consentSummary(i18n, row.original),
      meta: { hidden: { narrow: true, regular: true, sidebar: false } },
    },
    {
      id: 'updated',
      header: () => t`Updated`,
      cell: ({ row }) => (
        <span {...stylex.props(list.numeric)}>{formatDate(i18n, row.original.updated_at)}</span>
      ),
      meta: { align: 'end', hidden: { narrow: true, regular: false } },
    },
  ]
  return (
    <DataTable
      columns={columns}
      data={[...apps]}
      getRowId={(row) => row.id}
      isLoading={isLoading}
      onRowClick={onOpen}
      density="comfortable"
      narrowMode="priority"
      caption={t`Applications`}
      captionDisplay="hidden"
      emptyMessage={emptyMessage}
    />
  )
}
