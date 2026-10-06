// client_secret 只在创建/轮换时一次性展示。

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import type { DataTableColumnDef as ColumnDef } from '@xid-kit/web-ui/ui/DataTable'
import { Alert, Badge, Button, Field, Select, Textarea } from '@xid-kit/web-ui/ui'
import type { BadgeTone } from '@xid-kit/web-ui/ui'
import {
  ConsolePage,
  ConsolePageNotice,
  ConsolePageSection,
  ConsolePageSplitSection,
} from '@xid-kit/web-ui/ui'
import { DataTable } from '@xid-kit/web-ui/ui/DataTable'
import { LoadMore } from '@xid-kit/web-ui/ui/LoadMore'
import { consoleShell } from '@xid-kit/web-ui/styles/product-surface.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { ConfirmDialog } from '@xid-kit/web-ui/ConfirmDialog'
import { errorTargetsField, useManagementErrorMessage } from '@xid-kit/web-ui/api-error-message'
import { ApplicationEditor } from './ApplicationEditor'
import { isWebRedirectUri, parseLines } from './application-uris'
import {
  useApplicationsQuery,
  useCreateApplication,
  useDeleteApplication,
  useRotateClientSecret,
} from './queries'
import { TenantScopeGate } from './TenantScopeGate'
import type { OAuthApplication } from './types'

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
  return (
    <TenantScopeGate title={<Trans>OAuth applications</Trans>}>
      <ApplicationsPage />
    </TenantScopeGate>
  )
}

function ApplicationsPage(): ReactNode {
  const { t } = useLingui()
  const errorMessage = useManagementErrorMessage()
  const applications = useApplicationsQuery()
  const { data, isLoading, error } = applications

  const createApplication = useCreateApplication()
  const rotateSecret = useRotateClientSecret()
  const deleteApplication = useDeleteApplication()

  const [redirects, setRedirects] = useState('')
  const [redirectsInvalid, setRedirectsInvalid] = useState(false)
  const [clientType, setClientType] = useState<OAuthApplication['client_type']>('confidential')
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null)
  const [createdPublicClientId, setCreatedPublicClientId] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<OAuthApplication | null>(null)
  const [editing, setEditing] = useState<OAuthApplication | null>(null)
  const actionError = rotateSecret.error ?? deleteApplication.error

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
          <Button
            variant="secondary"
            onClick={() => setEditing(row.original)}
            aria-label={t`Edit application ${row.original.client_id}`}
            {...stylex.props(consoleShell.actionButton)}
          >
            <Trans>Edit</Trans>
          </Button>
          {usesSharedSecret(row.original) ? (
            <Button
              variant="secondary"
              isLoading={rotateSecret.isPending && rotateSecret.variables === row.original.id}
              onClick={() => handleRotate(row.original.id)}
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
      meta: { width: '300px' },
    },
  ]

  function handleCreate(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    const redirectUris = parseLines(redirects)
    const invalid = redirectUris.length === 0 || !redirectUris.every(isWebRedirectUri)
    setRedirectsInvalid(invalid)
    if (invalid) return
    setRevealedSecret(null)
    setCreatedPublicClientId(null)
    createApplication.mutate(
      { client_type: clientType, redirect_uris: redirectUris, post_logout_redirect_uris: [] },
      {
        onSuccess: (result) => {
          if (result.client_secret) setRevealedSecret(result.client_secret)
          else setCreatedPublicClientId(result.client_id)
          setRedirects('')
        },
      },
    )
  }

  function handleRotate(appId: string): void {
    setRevealedSecret(null)
    rotateSecret.mutate(appId, { onSuccess: (result) => setRevealedSecret(result.client_secret) })
  }

  function confirmDelete(): void {
    if (!pendingDelete) return
    deleteApplication.mutate(pendingDelete.id, { onSettled: () => setPendingDelete(null) })
  }

  const createError = createApplication.error
  const redirectError = redirectsInvalid
    ? t`Enter at least one absolute HTTPS URL without a fragment, one per line.`
    : errorTargetsField(createError, 'redirect_uris')
      ? errorMessage(createError)
      : undefined
  const formError =
    createError && !errorTargetsField(createError, 'redirect_uris')
      ? errorMessage(createError)
      : undefined

  return (
    <ConsolePage
      wide
      title={<Trans>OAuth applications</Trans>}
      lead={
        <Trans>
          Register OAuth 2.0 clients and manage their credentials. Applications are shared by every
          organization in the tenant.
        </Trans>
      }
    >
      {error || actionError ? (
        <ConsolePageNotice>
          {error ? <Alert tone="error">{errorMessage(error)}</Alert> : null}
          {actionError ? <Alert tone="error">{errorMessage(actionError)}</Alert> : null}
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
        <LoadMore query={applications} loadMoreLabel={<Trans>Load more applications</Trans>} />
      </ConsolePageSection>

      {editing ? (
        <ApplicationEditor
          key={editing.id}
          application={editing}
          onClose={() => setEditing(null)}
        />
      ) : null}

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
        <form onSubmit={handleCreate} noValidate>
          {formError ? <Alert tone="error">{formError}</Alert> : null}
          <div {...stylex.props(styles.formRow)}>
            <div {...stylex.props(styles.formFieldGrow)}>
              <Field
                label={<Trans>Redirect URIs</Trans>}
                error={redirectError}
                hint={<Trans>Exact match, no wildcards. One HTTPS URI per line.</Trans>}
                required
              >
                <Textarea
                  value={redirects}
                  onChange={(event) => setRedirects(event.target.value)}
                  placeholder={t`https://app.example.com/callback`}
                  required
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
          onConfirm={confirmDelete}
          onCancel={() => setPendingDelete(null)}
        />
      ) : null}
    </ConsolePage>
  )
}
