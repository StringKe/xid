import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Alert, Badge, Button, Field, Input } from '@xid-kit/web-ui/ui'
import {
  ConsolePage,
  ConsolePageNotice,
  ConsolePageSection,
  ConsolePageSplitSection,
} from '@xid-kit/web-ui/ui'
import { DataTable } from '@xid-kit/web-ui/ui/DataTable'
import type { LegacyColumnDef as ColumnDef } from '@tanstack/react-table/legacy'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { useCreateScimDirectory, useOrgScimDirectoriesQuery, useRotateScimToken } from './queries'
import type { ScimDirectory } from './types'
import { useOrgTarget } from './useOrgTarget'

const styles = stylex.create({
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
      <ConsolePage title={<Trans>Directory sync (SCIM)</Trans>}>
        <ConsolePageNotice>
          <Alert tone="info">
            <Trans>No organization selected.</Trans>
          </Alert>
        </ConsolePageNotice>
      </ConsolePage>
    )
  }

  const actionError = createDirectory.isError || rotateToken.isError

  return (
    <ConsolePage
      title={<Trans>Directory sync (SCIM)</Trans>}
      lead={
        <Trans>
          Provision SCIM 2.0 directories to sync organization users and groups from an identity
          provider.
        </Trans>
      }
    >
      {actionError || isError ? (
        <ConsolePageNotice>
          {actionError ? (
            <Alert tone="error">
              <Trans>Failed to save SCIM directory changes. Try again.</Trans>
            </Alert>
          ) : null}
          {isError ? (
            <Alert tone="error">
              <Trans>Failed to load SCIM directories. Please try again.</Trans>
            </Alert>
          ) : null}
        </ConsolePageNotice>
      ) : null}

      <ConsolePageSection title={<Trans>Directories</Trans>}>
        <DataTable
          columns={columns}
          data={data ?? []}
          getRowId={(row) => row.id}
          isLoading={isLoading}
          emptyMessage={<Trans>No SCIM directories configured.</Trans>}
        />
      </ConsolePageSection>

      <ConsolePageSplitSection
        title={<Trans>Create directory</Trans>}
        description={
          <Trans>
            Provision a new SCIM 2.0 directory for identity provider integration. The bearer token
            is shown once — store it immediately.
          </Trans>
        }
      >
        <form onSubmit={(event) => void handleCreate(event)} noValidate>
          <div {...stylex.props(styles.formRow)}>
            <div {...stylex.props(styles.inputWrap)}>
              <Field label={<Trans>Provider</Trans>} required>
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

        {scimToken ? (
          <div {...stylex.props(styles.tokenSection)}>
            <Alert tone="success">
              <Trans>SCIM token generated. Store it now; it will not be shown again.</Trans>
            </Alert>
            <code {...stylex.props(styles.tokenCode)}>{scimToken}</code>
          </div>
        ) : null}
      </ConsolePageSplitSection>
    </ConsolePage>
  )
}
