// client_secret 只在创建/轮换时一次性展示。

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import type { LegacyColumnDef as ColumnDef } from '@tanstack/react-table/legacy'
import { Alert, Badge, Button, Field, Input, Select } from '@xid-kit/web-ui/ui'
import type { BadgeTone } from '@xid-kit/web-ui/ui'
import {
  ConsolePage,
  ConsolePageNotice,
  ConsolePageSection,
  ConsolePageSplitSection,
} from '@xid-kit/web-ui/ui'
import { DataTable } from '@xid-kit/web-ui/ui/DataTable'
import { Pagination } from '@xid-kit/web-ui/ui/Pagination'
import { consoleShell } from '@xid-kit/web-ui/styles/product-surface.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { ConfirmDialog } from '@xid-kit/web-ui/ConfirmDialog'
import {
  useApplicationsQuery,
  useCreateApplication,
  useDeleteApplication,
  useRotateClientSecret,
} from './queries'
import type { OAuthApplication } from './types'
import { useOrgTarget } from './useOrgTarget'

const CLIENT_TYPE_TONE: Record<string, BadgeTone> = {
  confidential: 'info',
  public: 'neutral',
}

const styles = stylex.create({
  formRow: {
    display: 'flex',
    gap: '0.75rem',
    alignItems: 'flex-end',
    flexWrap: 'wrap',
  },
  formFieldGrow: {
    flex: '1 1 240px',
    minWidth: 0,
  },
  formFieldFixed: {
    flex: '0 0 180px',
  },
  secretStack: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
  },
  clientIdText: {
    fontFamily: tokens['--xid-font-mono'],
    fontSize: '0.8125rem',
    fontVariantNumeric: 'tabular-nums',
  },
})

function ClientTypeBadge({
  clientType,
}: {
  clientType: OAuthApplication['client_type']
}): ReactNode {
  return <Badge tone={CLIENT_TYPE_TONE[clientType] ?? 'neutral'}>{clientType}</Badge>
}

function usesSharedSecret(application: OAuthApplication): boolean {
  return (
    application.token_endpoint_auth_method === 'client_secret_basic' ||
    application.token_endpoint_auth_method === 'client_secret_post'
  )
}

export default function OrgApplications(): ReactNode {
  const { t } = useLingui()
  const { orgId } = useOrgTarget()

  const [cursor, setCursor] = useState<string | undefined>()
  const { data, isLoading, isError } = useApplicationsQuery(cursor)

  const createApplication = useCreateApplication()
  const rotateSecret = useRotateClientSecret()
  const deleteApplication = useDeleteApplication()

  const [redirectUri, setRedirectUri] = useState('')
  const [clientType, setClientType] = useState<OAuthApplication['client_type']>('confidential')
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null)
  const [createdPublicClientId, setCreatedPublicClientId] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<OAuthApplication | null>(null)

  const columns: ColumnDef<OAuthApplication>[] = [
    {
      id: 'clientId',
      header: () => <Trans>Client ID</Trans>,
      cell: ({ row }) => (
        <span {...stylex.props(styles.clientIdText)}>{row.original.client_id}</span>
      ),
    },
    {
      id: 'type',
      header: () => <Trans>Type</Trans>,
      cell: ({ row }) => <ClientTypeBadge clientType={row.original.client_type} />,
      meta: { width: '120px' },
    },
    {
      id: 'redirects',
      header: () => <Trans>Redirect URIs</Trans>,
      cell: ({ row }) => row.original.redirect_uris.length,
      meta: { width: '120px' },
    },
    {
      id: 'created',
      header: () => <Trans>Created</Trans>,
      cell: ({ row }) => new Date(row.original.created_at).toLocaleDateString(),
      meta: { width: '120px' },
    },
    {
      id: 'actions',
      header: () => <Trans>Actions</Trans>,
      cell: ({ row }) => (
        <div {...stylex.props(consoleShell.actionGroup)}>
          {usesSharedSecret(row.original) ? (
            <Button
              variant="secondary"
              isLoading={rotateSecret.isPending && rotateSecret.variables === row.original.id}
              onClick={() => void handleRotate(row.original.id)}
              {...stylex.props(consoleShell.actionButton)}
            >
              <Trans>Rotate secret</Trans>
            </Button>
          ) : null}
          <Button
            variant="danger"
            onClick={() => setPendingDelete(row.original)}
            aria-label={t`Delete application ${row.original.client_id}`}
            {...stylex.props(consoleShell.actionButton)}
          >
            <Trans>Delete</Trans>
          </Button>
        </div>
      ),
      meta: { width: '220px' },
    },
  ]

  async function handleCreate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    setRevealedSecret(null)
    setCreatedPublicClientId(null)
    const result = await createApplication.mutateAsync({
      client_type: clientType,
      redirect_uris: redirectUri.trim() ? [redirectUri.trim()] : [],
    })
    if (result.client_secret) setRevealedSecret(result.client_secret)
    else setCreatedPublicClientId(result.client_id)
    setRedirectUri('')
  }

  async function handleRotate(appId: string): Promise<void> {
    setRevealedSecret(null)
    const result = await rotateSecret.mutateAsync(appId)
    setRevealedSecret(result.client_secret)
  }

  async function confirmDelete(): Promise<void> {
    if (!pendingDelete) return
    await deleteApplication.mutateAsync(pendingDelete.id)
    setPendingDelete(null)
  }

  if (!orgId) {
    return (
      <ConsolePage wide title={<Trans>OAuth applications</Trans>}>
        <ConsolePageNotice>
          <Alert tone="info">
            <Trans>No organization selected.</Trans>
          </Alert>
        </ConsolePageNotice>
      </ConsolePage>
    )
  }

  return (
    <ConsolePage
      wide
      title={<Trans>OAuth applications</Trans>}
      lead={<Trans>Register OAuth 2.0 clients and manage their credentials.</Trans>}
    >
      {isError || rotateSecret.isError || deleteApplication.isError ? (
        <ConsolePageNotice>
          {isError ? (
            <Alert tone="error">
              <Trans>Failed to load applications.</Trans>
            </Alert>
          ) : null}
          {rotateSecret.isError || deleteApplication.isError ? (
            <Alert tone="error">
              <Trans>Failed to save changes. Try again.</Trans>
            </Alert>
          ) : null}
        </ConsolePageNotice>
      ) : null}

      <ConsolePageSection title={<Trans>Applications</Trans>}>
        <DataTable
          columns={columns}
          data={data?.data ?? []}
          getRowId={(row) => row.id}
          isLoading={isLoading}
          emptyMessage={<Trans>No applications registered.</Trans>}
        />
        {data ? (
          <Pagination
            nextCursor={data.next_cursor}
            loadMoreLabel={<Trans>Load more applications</Trans>}
            onLoadMore={setCursor}
          />
        ) : null}
      </ConsolePageSection>

      <ConsolePageSplitSection
        title={<Trans>Register application</Trans>}
        description={
          clientType === 'public' ? (
            <Trans>Public clients use PKCE and do not receive a client secret.</Trans>
          ) : (
            <Trans>
              Create a confidential OAuth 2.0 client. Its secret is shown once; store it
              immediately.
            </Trans>
          )
        }
      >
        <form onSubmit={(event) => void handleCreate(event)} noValidate>
          <div {...stylex.props(styles.formRow)}>
            <div {...stylex.props(styles.formFieldGrow)}>
              <Field
                label={<Trans>Redirect URI</Trans>}
                error={
                  createApplication.error ? t`Failed to create application. Try again.` : undefined
                }
                hint={<Trans>Exact match, no wildcards. Optional at creation.</Trans>}
              >
                <Input
                  type="url"
                  value={redirectUri}
                  onChange={(event) => setRedirectUri(event.target.value)}
                  placeholder={t`https://app.example.com/callback`}
                />
              </Field>
            </div>
            <div {...stylex.props(styles.formFieldFixed)}>
              <Field label={<Trans>Client type</Trans>}>
                <Select
                  value={clientType}
                  onChange={(event) =>
                    setClientType(event.target.value as OAuthApplication['client_type'])
                  }
                  aria-label={t`Select client type`}
                >
                  <option value="confidential">{t`confidential`}</option>
                  <option value="public">{t`public`}</option>
                </Select>
              </Field>
            </div>
            <Button type="submit" isLoading={createApplication.isPending}>
              <Trans>Create application</Trans>
            </Button>
          </div>
        </form>
        {revealedSecret ? (
          <div {...stylex.props(styles.secretStack)}>
            <Alert tone="success">
              <Trans>Client secret generated. Store it now; it will not be shown again.</Trans>
            </Alert>
            <code {...stylex.props(consoleShell.codeBlock)}>{revealedSecret}</code>
          </div>
        ) : null}
        {createdPublicClientId ? (
          <Alert tone="success">
            <Trans>
              Public client {createdPublicClientId} created with PKCE. No client secret was
              generated.
            </Trans>
          </Alert>
        ) : null}
      </ConsolePageSplitSection>

      {pendingDelete ? (
        <ConfirmDialog
          title={<Trans>Delete application?</Trans>}
          description={
            <Trans>
              Client {pendingDelete.client_id} will be removed and can no longer obtain tokens.
            </Trans>
          }
          confirmLabel={<Trans>Delete</Trans>}
          isLoading={deleteApplication.isPending}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setPendingDelete(null)}
        />
      ) : null}
    </ConsolePage>
  )
}
