// org SCIM 目录同步页:目录列表(provider/状态/用户数/组数/最后同步)。
// 调 GET /v1/organizations/:orgId/directories(TanStack Query)。

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { FormEvent } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Alert, Badge, Button, Field, Input, Spinner } from '../../components/ui'
import { DataTable } from '../../components/ui/DataTable'
import type { ColumnDef } from '@tanstack/react-table'
import { page } from '../../styles/product-surface.stylex'
import { tokens } from '../../styles/tokens.stylex'
import { useCreateScimDirectory, useOrgScimDirectoriesQuery, useRotateScimToken } from './queries'
import type { ScimDirectory } from './types'
import { useOrgTarget } from './useOrgTarget'

// 全宽规范常量
const GUTTER = 'clamp(1rem, 2.5vw, 4rem)'
const SECTION_PAD = 'clamp(1.5rem, 1.6vw, 2.5rem)'
const CROSS_GAP = 'clamp(1.75rem, 2vw, 3.5rem)'

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
  messageZone: {
    paddingInline: GUTTER,
    paddingBlock: '1.5rem',
  },
  // DataTable 全宽节
  tableSection: {
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
    paddingInline: GUTTER,
    paddingBlock: SECTION_PAD,
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
  },
  // 创建区:5/7 双列
  createSection: {
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
    paddingInline: GUTTER,
    paddingBlock: SECTION_PAD,
    display: 'grid',
    gridTemplateColumns: {
      default: '1fr',
      '@media (min-width: 64rem)': 'minmax(0, 5fr) minmax(0, 7fr)',
    },
    gap: {
      default: '1.25rem',
      '@media (min-width: 64rem)': '0',
    },
  },
  sectionMeta: {
    paddingInlineEnd: {
      default: '0',
      '@media (min-width: 64rem)': CROSS_GAP,
    },
    display: 'flex',
    flexDirection: 'column',
    gap: '0.375rem',
  },
  sectionDesc: {
    margin: 0,
    fontSize: '0.8125rem',
    lineHeight: 1.55,
    color: tokens['--xid-muted-foreground'],
    fontFamily: tokens['--xid-font'],
    maxWidth: '28rem',
  },
  controlCol: {
    paddingInlineStart: {
      default: '0',
      '@media (min-width: 64rem)': CROSS_GAP,
    },
    borderInlineStartWidth: {
      default: '0',
      '@media (min-width: 64rem)': '1px',
    },
    borderInlineStartStyle: 'solid',
    borderInlineStartColor: tokens['--xid-border'],
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
    maxWidth: '36rem',
  },
  formRow: {
    display: 'flex',
    gap: '0.75rem',
    alignItems: 'flex-end',
    flexWrap: 'wrap',
  },
  inputWrap: {
    flex: '1 1 200px',
    minWidth: 0,
  },
  tokenSection: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
    paddingTop: '0.75rem',
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
  },
  tokenCode: {
    fontFamily: tokens['--xid-font-mono'],
    fontSize: '0.75rem',
    backgroundColor: tokens['--xid-muted'],
    paddingBlock: '0.375rem',
    paddingInline: '0.5rem',
    borderRadius: tokens['--xid-radius-sm'],
    wordBreak: 'break-all',
    color: tokens['--xid-fg'],
  },
  mutedText: {
    color: tokens['--xid-muted-foreground'],
  },
})

function ScimStatus({ status }: { status: ScimDirectory['status'] }): ReactNode {
  return <Badge tone={status === 'active' ? 'success' : 'neutral'}>{status}</Badge>
}

function LastSync({ lastSyncAt }: { lastSyncAt: string | null }): ReactNode {
  if (lastSyncAt) {
    return <>{new Date(lastSyncAt).toLocaleString()}</>
  }
  return (
    <span {...stylex.props(styles.mutedText)}>
      <Trans>Never</Trans>
    </span>
  )
}

export default function OrgScim(): ReactNode {
  const { t } = useLingui()
  const { orgId } = useOrgTarget()
  const { data, isLoading, isError } = useOrgScimDirectoriesQuery(orgId)
  const createDirectory = useCreateScimDirectory(orgId)
  const rotateToken = useRotateScimToken(orgId)
  const [provider, setProvider] = useState('okta')
  const [scimToken, setScimToken] = useState<string | null>(null)

  const columns: ColumnDef<ScimDirectory>[] = [
    {
      id: 'name',
      header: () => <Trans>Name</Trans>,
      cell: ({ row }) => row.original.name,
    },
    {
      id: 'provider',
      header: () => <Trans>Provider</Trans>,
      cell: ({ row }) => row.original.provider,
      meta: { width: '140px' },
    },
    {
      id: 'status',
      header: () => <Trans>Status</Trans>,
      cell: ({ row }) => <ScimStatus status={row.original.status} />,
      meta: { width: '100px' },
    },
    {
      id: 'users',
      header: () => <Trans>Users</Trans>,
      cell: ({ row }) => row.original.userCount.toLocaleString(),
      meta: { width: '80px' },
    },
    {
      id: 'groups',
      header: () => <Trans>Groups</Trans>,
      cell: ({ row }) => row.original.groupCount.toLocaleString(),
      meta: { width: '80px' },
    },
    {
      id: 'lastSync',
      header: () => <Trans>Last sync</Trans>,
      cell: ({ row }) => <LastSync lastSyncAt={row.original.lastSyncAt} />,
      meta: { width: '160px' },
    },
    {
      id: 'actions',
      header: () => <Trans>Actions</Trans>,
      cell: ({ row }) => (
        <Button
          variant="secondary"
          isLoading={rotateToken.isPending}
          onClick={() => void handleRotate(row.original.id)}
        >
          <Trans>Rotate token</Trans>
        </Button>
      ),
      meta: { width: '140px' },
    },
  ]

  async function handleCreate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    const result = await createDirectory.mutateAsync({ provider: provider.trim() || 'generic' })
    setScimToken(result.scimToken)
  }

  async function handleRotate(directoryId: string): Promise<void> {
    const result = await rotateToken.mutateAsync(directoryId)
    setScimToken(result.scimToken)
  }

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
          <Trans>Directory sync (SCIM)</Trans>
        </h1>
      </div>

      {/* Directory list */}
      <section aria-labelledby="directories-heading" {...stylex.props(styles.tableSection)}>
        <h2 id="directories-heading" {...stylex.props(page.sectionLabel)}>
          <Trans>Directories</Trans>
        </h2>
        {isLoading ? (
          <div {...stylex.props(page.loadingCenter)}>
            <Spinner />
          </div>
        ) : isError ? (
          <Alert tone="error">
            <Trans>Failed to load SCIM directories. Please try again.</Trans>
          </Alert>
        ) : (
          <DataTable
            columns={columns}
            data={data ?? []}
            getRowId={(row) => row.id}
            emptyMessage={<Trans>No SCIM directories configured.</Trans>}
          />
        )}
      </section>

      {/* Create directory */}
      <section aria-labelledby="create-directory-heading" {...stylex.props(styles.createSection)}>
        <div {...stylex.props(styles.sectionMeta)}>
          <h2 id="create-directory-heading" {...stylex.props(page.sectionLabel)}>
            <Trans>Create directory</Trans>
          </h2>
          <p {...stylex.props(styles.sectionDesc)}>
            <Trans>
              Provision a new SCIM 2.0 directory for identity provider integration. The bearer token
              is shown once — store it immediately.
            </Trans>
          </p>
        </div>
        <div {...stylex.props(styles.controlCol)}>
          <form onSubmit={(event) => void handleCreate(event)} noValidate>
            <div {...stylex.props(styles.formRow)}>
              <div {...stylex.props(styles.inputWrap)}>
                <Field
                  label={<Trans>Provider</Trans>}
                  error={createDirectory.error?.message ?? undefined}
                  required
                >
                  <Input
                    value={provider}
                    onChange={(event) => setProvider(event.target.value)}
                    placeholder={t`okta`}
                    required
                  />
                </Field>
              </div>
              <Button type="submit" isLoading={createDirectory.isPending}>
                <Trans>Create directory</Trans>
              </Button>
            </div>
          </form>

          {rotateToken.error ? <Alert tone="error">{rotateToken.error.message}</Alert> : null}

          {scimToken ? (
            <div {...stylex.props(styles.tokenSection)}>
              <Alert tone="success">
                <Trans>SCIM token generated. Store it now; it will not be shown again.</Trans>
              </Alert>
              <code {...stylex.props(styles.tokenCode)}>{scimToken}</code>
            </div>
          ) : null}
        </div>
      </section>
    </div>
  )
}
