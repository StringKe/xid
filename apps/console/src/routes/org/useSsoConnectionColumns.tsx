import { Trans, useLingui } from '@lingui/react/macro'
import * as stylex from '@stylexjs/stylex'
import { Badge } from '@xid-kit/web-ui/ui'
import type { DataTableColumnDef as ColumnDef } from '@xid-kit/web-ui/ui/DataTable'
import { statusToneFor, useConnectionStatusLabel } from '@xid-kit/web-ui/enum-labels'
import { list } from '../../components/page/list-styles'
import { formatDate } from '../../lib/date-format'
import { connectionHost } from './sso-connection-form'
import type { SsoConnection } from './types'

const styles = stylex.create({
  protocolCode: {
    fontVariantNumeric: 'tabular-nums',
    fontSize: '0.8125rem',
  },
})

export function useSsoConnectionColumns(): ColumnDef<SsoConnection>[] {
  const { i18n } = useLingui()
  const statusLabel = useConnectionStatusLabel()
  return [
    {
      id: 'name',
      header: () => <Trans>Name</Trans>,
      cell: ({ row }) => row.original.name,
    },
    {
      id: 'type',
      header: () => <Trans>Type</Trans>,
      cell: ({ row }) => (
        <code {...stylex.props(styles.protocolCode)}>{row.original.type.toUpperCase()}</code>
      ),
      meta: { width: '80px' },
    },
    {
      id: 'host',
      header: () => <Trans>Identity provider</Trans>,
      cell: ({ row }) => (
        <span {...stylex.props(list.breakable)}>{connectionHost(row.original)}</span>
      ),
    },
    {
      id: 'jit',
      header: () => <Trans>JIT</Trans>,
      cell: ({ row }) =>
        row.original.jit_enabled ? <Trans>Enabled</Trans> : <Trans>Disabled</Trans>,
      meta: { width: '90px' },
    },
    {
      id: 'status',
      header: () => <Trans>Status</Trans>,
      cell: ({ row }) => (
        <Badge tone={statusToneFor(row.original.status)}>{statusLabel(row.original.status)}</Badge>
      ),
      meta: { width: '100px' },
    },
    {
      id: 'created',
      header: () => <Trans>Created</Trans>,
      cell: ({ row }) => (
        <span {...stylex.props(list.numeric)}>{formatDate(i18n, row.original.createdAt)}</span>
      ),
      meta: { width: '120px' },
    },
  ]
}
