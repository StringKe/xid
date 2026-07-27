// org 角色权限管理页:角色列表 + 权限详情。调 /v1/organizations/:orgId/roles。
// 全宽锚定版式:零 padding 壳,各节自持 gutter;表格横贯全宽;hairline 分节。
// 权限以 code tags 行内堆叠显示。

import { Trans } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import type { ColumnDef } from '@tanstack/react-table'
import { Alert, EmptyState, Spinner } from '@xid-kit/web-ui/ui'
import { DataTable } from '@xid-kit/web-ui/ui/DataTable'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { page } from '@xid-kit/web-ui/styles/product-surface.stylex'
import { useOrgRolesQuery } from './queries'
import type { OrgRole } from './types'
import { useOrgTarget } from './useOrgTarget'

const GUTTER = 'clamp(1rem, 2.5vw, 4rem)'
const SECTION_PAD = 'clamp(1.5rem, 1.6vw, 2.5rem)'

const styles = stylex.create({
  root: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    paddingBottom: 'clamp(2rem, 3vw, 4rem)',
  },
  headerZone: {
    paddingInline: GUTTER,
    paddingTop: 'clamp(1.75rem, 2vw, 3rem)',
    paddingBottom: 'clamp(1.25rem, 1.5vw, 2rem)',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  title: {
    margin: 0,
    fontSize: 'clamp(1.75rem, 1.05rem + 1.5vw, 2.75rem)',
    fontWeight: 620,
    lineHeight: 1.05,
    letterSpacing: '-0.03em',
    color: tokens['--xid-fg'],
    textWrap: 'balance',
  },
  section: {
    paddingInline: GUTTER,
    paddingBlock: SECTION_PAD,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  sectionLabelRow: {
    marginBottom: '1rem',
  },
  messageZone: {
    paddingInline: GUTTER,
    paddingBlock: '1.5rem',
  },
  loadingZone: {
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    paddingBlock: '3rem',
    paddingInline: GUTTER,
  },
  roleKey: {
    fontFamily: tokens['--xid-font-mono'],
    fontSize: '0.8125rem',
    background: tokens['--xid-muted'],
    paddingBlock: '0.125rem',
    paddingInline: '0.375rem',
    borderRadius: tokens['--xid-radius-sm'],
    color: tokens['--xid-muted-foreground'],
  },
  roleName: {
    fontSize: '0.875rem',
    fontWeight: 500,
    color: tokens['--xid-fg'],
    fontFamily: tokens['--xid-font'],
  },
  permList: {
    margin: 0,
    padding: 0,
    listStyle: 'none',
    display: 'flex',
    flexWrap: 'wrap',
    gap: '0.25rem',
  },
  permBadge: {
    fontFamily: tokens['--xid-font-mono'],
    fontSize: '0.75rem',
    background: tokens['--xid-muted'],
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: tokens['--xid-border'],
    paddingBlock: '0.0625rem',
    paddingInline: '0.3125rem',
    borderRadius: tokens['--xid-radius-sm'],
    color: tokens['--xid-fg'],
  },
  noPerms: {
    fontSize: '0.8125rem',
    color: tokens['--xid-muted-foreground'],
    fontFamily: tokens['--xid-font'],
  },
})

const columns: ColumnDef<OrgRole>[] = [
  {
    id: 'name',
    header: () => <Trans>Name</Trans>,
    cell: ({ row }) => <span {...stylex.props(styles.roleName)}>{row.original.displayName}</span>,
    meta: { width: '160px' },
  },
  {
    id: 'key',
    header: () => <Trans>Key</Trans>,
    cell: ({ row }) => <code {...stylex.props(styles.roleKey)}>{row.original.key}</code>,
    meta: { width: '160px' },
  },
  {
    id: 'group',
    header: () => <Trans>Group</Trans>,
    cell: ({ row }) => row.original.group ?? null,
    meta: { width: '120px' },
  },
  {
    id: 'permissions',
    header: () => <Trans>Permissions</Trans>,
    cell: ({ row }) =>
      row.original.permissions.length > 0 ? (
        <ul {...stylex.props(styles.permList)}>
          {row.original.permissions.map((perm) => (
            <li key={perm}>
              <code {...stylex.props(styles.permBadge)}>{perm}</code>
            </li>
          ))}
        </ul>
      ) : (
        <span {...stylex.props(styles.noPerms)}>
          <Trans>None</Trans>
        </span>
      ),
  },
]

export default function OrgRoles(): ReactNode {
  const { orgId } = useOrgTarget()
  const { data, isLoading, isError } = useOrgRolesQuery(orgId)

  if (!orgId) {
    return (
      <div {...stylex.props(styles.messageZone)}>
        <Alert tone="info">
          <Trans>No organization selected.</Trans>
        </Alert>
      </div>
    )
  }

  return (
    <div {...stylex.props(styles.root)}>
      <div {...stylex.props(styles.headerZone)}>
        <h1 {...stylex.props(styles.title)}>
          <Trans>Roles and permissions</Trans>
        </h1>
      </div>

      {isLoading ? (
        <div {...stylex.props(styles.loadingZone)}>
          <Spinner />
        </div>
      ) : isError ? (
        <div {...stylex.props(styles.messageZone)}>
          <Alert tone="error">
            <Trans>Failed to load roles. Please try again.</Trans>
          </Alert>
        </div>
      ) : !data || data.length === 0 ? (
        <div {...stylex.props(styles.messageZone)}>
          <EmptyState title={<Trans>No roles defined for this organization.</Trans>} />
        </div>
      ) : (
        <section aria-labelledby="roles-heading" {...stylex.props(styles.section)}>
          <h2 id="roles-heading" {...stylex.props(page.sectionLabel, styles.sectionLabelRow)}>
            <Trans>Roles</Trans>
          </h2>
          <DataTable
            columns={columns}
            data={data}
            getRowId={(row) => row.id}
            emptyMessage={<Trans>No roles defined for this organization.</Trans>}
          />
        </section>
      )}
    </div>
  )
}
