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
import { ConfirmDialog } from '@xid-kit/web-ui/ConfirmDialog'
import { useApiErrorMessage } from '@xid-kit/web-ui/api-error-message'
import { statusToneFor, useDirectoryStatusLabel } from '@xid-kit/web-ui/enum-labels'
import type { DataTableColumnDef as ColumnDef } from '@xid-kit/web-ui/ui/DataTable'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import type { XidError } from '@xid-kit/types'
import { CopyableValue } from './CopyableValue'
import {
  useCreateScimDirectory,
  useDeleteScimDirectory,
  useOrgScimDirectoriesQuery,
  useRotateScimToken,
} from './queries'
import type { ScimDirectory } from './types'
import { useOrgTarget } from './useOrgTarget'
import { scimProviderLabel } from './scim-provider-label'
import { formatDateTime } from '../../lib/date-format'

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
  actions: {
    display: 'flex',
    gap: '0.5rem',
    flexWrap: 'wrap',
  },
  mutedText: {
    color: tokens['--xid-muted-foreground'],
  },
})

type IssuedToken = {
  token: string
  previousTokenExpiresAt: string | null
}

function ScimStatus({ status }: { status: ScimDirectory['status'] }): ReactNode {
  const label = useDirectoryStatusLabel()
  return <Badge tone={statusToneFor(status)}>{label(status)}</Badge>
}

function LastSync({ lastSyncAt }: { lastSyncAt: string | null }): ReactNode {
  const { i18n } = useLingui()
  if (lastSyncAt) {
    return <>{formatDateTime(i18n, lastSyncAt)}</>
  }
  return (
    <span {...stylex.props(styles.mutedText)}>
      <Trans>Never</Trans>
    </span>
  )
}

function IssuedTokenNotice({ issued }: { issued: IssuedToken }): ReactNode {
  const { i18n } = useLingui()
  const expiresAt = formatDateTime(i18n, issued.previousTokenExpiresAt)
  return (
    <div {...stylex.props(styles.tokenSection)}>
      <Alert tone="success">
        <Trans>SCIM token generated. Store it now; it will not be shown again.</Trans>
      </Alert>
      <CopyableValue value={issued.token} />
      {expiresAt ? (
        <p {...stylex.props(styles.mutedText)}>
          <Trans>
            The previous token keeps working until {expiresAt}. Update your identity provider before
            then.
          </Trans>
        </p>
      ) : null}
    </div>
  )
}

export default function OrgScim(): ReactNode {
  const { t, i18n } = useLingui()
  const errorMessage = useApiErrorMessage()
  const { orgId } = useOrgTarget()
  const { data, isLoading, isError } = useOrgScimDirectoriesQuery(orgId)
  const createDirectory = useCreateScimDirectory(orgId)
  const rotateToken = useRotateScimToken(orgId)
  const deleteDirectory = useDeleteScimDirectory(orgId)
  const [provider, setProvider] = useState('okta')
  const [issued, setIssued] = useState<IssuedToken | null>(null)
  const [pendingDelete, setPendingDelete] = useState<ScimDirectory | null>(null)
  const directories = data ?? []
  const baseUrl = directories[0]?.scimBaseUrl ?? null

  const columns: ColumnDef<ScimDirectory>[] = [
    {
      id: 'provider',
      header: () => <Trans>Provider</Trans>,
      cell: ({ row }) => scimProviderLabel(i18n, row.original.provider),
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
        <div {...stylex.props(styles.actions)}>
          <Button
            variant="secondary"
            isLoading={rotateToken.isPending && rotateToken.variables === row.original.id}
            onClick={() => void handleRotate(row.original.id)}
          >
            <Trans>Rotate token</Trans>
          </Button>
          <Button variant="ghost" onClick={() => setPendingDelete(row.original)}>
            <Trans>Delete</Trans>
          </Button>
        </div>
      ),
      meta: { width: '220px' },
    },
  ]

  async function handleCreate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    const result = await createDirectory.mutateAsync({ provider: provider.trim() || 'generic' })
    setIssued({ token: result.scimToken, previousTokenExpiresAt: null })
  }

  async function handleRotate(directoryId: string): Promise<void> {
    const result = await rotateToken.mutateAsync(directoryId)
    setIssued({ token: result.scimToken, previousTokenExpiresAt: result.scimTokenPrevExpiresAt })
  }

  async function confirmDelete(): Promise<void> {
    if (!pendingDelete) return
    await deleteDirectory.mutateAsync(pendingDelete.id)
    setPendingDelete(null)
    setIssued(null)
  }

  if (!orgId) {
    return (
      <ConsolePage wide title={<Trans>Directory sync (SCIM)</Trans>}>
        <ConsolePageNotice>
          <Alert tone="info">
            <Trans>No organization selected.</Trans>
          </Alert>
        </ConsolePageNotice>
      </ConsolePage>
    )
  }

  const pendingDeleteName = pendingDelete ? scimProviderLabel(i18n, pendingDelete.name) : ''
  const actionError: XidError | null =
    createDirectory.error ?? rotateToken.error ?? deleteDirectory.error ?? null

  return (
    <ConsolePage
      wide
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
            <Alert tone="error">{errorMessage(actionError, { surface: 'general' })}</Alert>
          ) : null}
          {isError ? (
            <Alert tone="error">
              <Trans>Failed to load SCIM directories. Reload the page to try again.</Trans>
            </Alert>
          ) : null}
        </ConsolePageNotice>
      ) : null}

      <ConsolePageSection title={<Trans>Directories</Trans>}>
        <DataTable
          columns={columns}
          data={directories}
          getRowId={(row) => row.id}
          isLoading={isLoading}
          emptyMessage={<Trans>No SCIM directories configured.</Trans>}
        />
      </ConsolePageSection>

      {baseUrl ? (
        <ConsolePageSplitSection
          title={<Trans>SCIM base URL</Trans>}
          description={
            <Trans>
              Enter this URL as the SCIM connector base URL in your identity provider, together with
              the directory bearer token.
            </Trans>
          }
        >
          <CopyableValue value={baseUrl} />
        </ConsolePageSplitSection>
      ) : null}

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

        {issued ? <IssuedTokenNotice issued={issued} /> : null}
      </ConsolePageSplitSection>

      {pendingDelete ? (
        <ConfirmDialog
          title={<Trans>Delete SCIM directory?</Trans>}
          description={
            <Trans>
              {pendingDeleteName} stops accepting SCIM requests immediately, including the previous
              token. Users it already provisioned keep their accounts.
            </Trans>
          }
          confirmLabel={<Trans>Delete</Trans>}
          isLoading={deleteDirectory.isPending}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setPendingDelete(null)}
        />
      ) : null}
    </ConsolePage>
  )
}
