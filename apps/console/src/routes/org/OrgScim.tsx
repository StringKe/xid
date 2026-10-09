// 入站 SCIM 目录列表;?directoryId= 进入目录详情。新目录的 bearer token 只在创建后显示一次。

import type { MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { useApiErrorMessage } from '@xid-kit/web-ui/api-error-message'
import { statusToneFor, useDirectoryStatusLabel } from '@xid-kit/web-ui/enum-labels'
import { leading, text, weight } from '@xid-kit/web-ui/styles/scale.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { useLocation, useNavigate, useSearchParams } from '@xid-kit/web-ui/tanstack-router'
import {
  Alert,
  Badge,
  Button,
  Dialog,
  EmptyState,
  Field,
  Icon,
  IdentityCell,
  Select,
} from '@xid-kit/web-ui/ui'
import { DataTable } from '@xid-kit/web-ui/ui/DataTable'
import type { DataTableColumnDef } from '@xid-kit/web-ui/ui/DataTable'
import { DOCS_URL } from '../../components/layout/ConsoleTopBar'
import { PageFrame } from '../../components/page/PageFrame'
import { list } from '../../components/page/list-styles'
import { formatDateTime } from '../../lib/date-format'
import { withOrgId } from '../users/UsersList'
import { useCreateScimDirectory, useOrgScimDirectoriesQuery } from './queries'
import ScimDirectoryDetail, { ScimTokenDialog } from './ScimDirectoryDetail'
import type { IssuedScimToken } from './ScimDirectoryDetail'
import { scimProviderLabel } from './scim-provider-label'
import type { ScimDirectory } from './types'
import { useOrgTarget } from './useOrgTarget'

const SCIM_PATH = '/console/org/scim'

const PROVIDERS = [
  'okta',
  'microsoft-entra',
  'google-workspace',
  'onelogin',
  'jumpcloud',
  'generic',
] as const

const SETUP_STEPS: readonly { step: MessageDescriptor; detail: MessageDescriptor }[] = [
  {
    step: msg`1. Create a connection`,
    detail: msg`XID gives you a SCIM base URL and a bearer token`,
  },
  {
    step: msg`2. Paste them into your IdP`,
    detail: msg`Okta, Microsoft Entra ID or any SCIM 2.0 client`,
  },
  {
    step: msg`3. Assign people in your IdP`,
    detail: msg`The first changes show up here within minutes`,
  },
]

const styles = stylex.create({
  empty: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: '0.75rem',
    maxWidth: '40rem',
    paddingTop: '1rem',
  },
  emptyTitle: {
    margin: 0,
    fontSize: text.lg,
    lineHeight: leading.lg,
    fontWeight: weight.display,
    letterSpacing: tokens['--xid-tracking-title'],
  },
  emptyLead: {
    margin: 0,
    fontSize: text.base,
    lineHeight: leading.body,
    color: tokens['--xid-muted-foreground'],
  },
  steps: {
    width: '100%',
    margin: 0,
    padding: 0,
    listStyle: 'none',
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
  },
  step: {
    display: 'grid',
    gridTemplateColumns: { default: '1fr', '@media (min-width: 48rem)': '14.75rem minmax(0, 1fr)' },
    gap: '0.125rem 1rem',
    paddingBlock: '0.625rem',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
    fontSize: text.sm,
  },
  stepName: { fontWeight: weight.medium },
  emptyActions: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '0.5rem 1rem',
    paddingTop: '0.5rem',
  },
  link: { color: tokens['--xid-accent'], fontSize: text.sm, textDecoration: 'none' },
})

export default function OrgScim(): ReactNode {
  const [params] = useSearchParams()
  const location = useLocation()
  const directoryId = params.get('directoryId')
  if (directoryId) {
    return (
      <ScimDirectoryDetail
        key={directoryId}
        directoryId={directoryId}
        listPath={withOrgId(SCIM_PATH, location.search)}
      />
    )
  }
  return <DirectoriesList />
}

function detailPath(search: string, directoryId: string): string {
  const next = new URLSearchParams(search)
  next.set('directoryId', directoryId)
  return `${SCIM_PATH}?${next.toString()}`
}

function DirectoryStatus({ status }: { status: ScimDirectory['status'] }): ReactNode {
  const label = useDirectoryStatusLabel()
  return <Badge tone={statusToneFor(status)}>{label(status)}</Badge>
}

function DirectoriesList(): ReactNode {
  const { t, i18n } = useLingui()
  const location = useLocation()
  const navigate = useNavigate()
  const { orgId, orgName } = useOrgTarget()
  const directories = useOrgScimDirectoriesQuery(orgId)
  const [connecting, setConnecting] = useState(false)
  const [created, setCreated] = useState<{
    directory: ScimDirectory
    issued: IssuedScimToken
  } | null>(null)
  const rows = directories.data ?? []
  const open = (row: Pick<ScimDirectory, 'id'>) => navigate(detailPath(location.search, row.id))

  const columns: DataTableColumnDef<ScimDirectory>[] = [
    {
      id: 'directory',
      header: () => t`Directory`,
      cell: ({ row }) => (
        <IdentityCell
          name={scimProviderLabel(i18n, row.original.provider)}
          secondary={row.original.id}
          secondaryIsCode
        />
      ),
      meta: { priority: 'primary', width: '36%' },
    },
    {
      id: 'status',
      header: () => t`Status`,
      cell: ({ row }) => <DirectoryStatus status={row.original.status} />,
      meta: { priority: 'primary' },
    },
    {
      id: 'users',
      header: () => t`Users`,
      cell: ({ row }) => (
        <span {...stylex.props(list.numeric)}>{i18n.number(row.original.userCount)}</span>
      ),
      meta: { align: 'end', hidden: { narrow: true, regular: false } },
    },
    {
      id: 'groups',
      header: () => t`Groups`,
      cell: ({ row }) => (
        <span {...stylex.props(list.numeric)}>{i18n.number(row.original.groupCount)}</span>
      ),
      meta: { align: 'end', hidden: { narrow: true, regular: false } },
    },
    {
      id: 'lastSync',
      header: () => t`Last sync`,
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

  const isEmpty = directories.data !== undefined && rows.length === 0

  return (
    <PageFrame
      title={<Trans>Directory sync</Trans>}
      lead={
        <Trans>
          Let your identity provider create, update and deactivate {orgName} users over SCIM 2.0.
        </Trans>
      }
      actions={
        isEmpty || !directories.data ? null : (
          <Button onClick={() => setConnecting(true)}>
            <Icon name="plus" size={16} />
            <Trans>Connect a directory</Trans>
          </Button>
        )
      }
    >
      {directories.isError && !directories.data ? (
        <EmptyState
          variant="load-failure"
          title={<Trans>Directories could not be loaded</Trans>}
          description={<Trans>Nothing changed. Check your connection and try again.</Trans>}
          action={
            <Button variant="secondary" onClick={() => void directories.refetch()}>
              <Trans>Try again</Trans>
            </Button>
          }
        />
      ) : isEmpty ? (
        <section {...stylex.props(styles.empty)}>
          <h2 {...stylex.props(styles.emptyTitle)}>
            <Trans>No directory is connected to {orgName} yet</Trans>
          </h2>
          <p {...stylex.props(styles.emptyLead)}>
            <Trans>
              People you add in Okta or Microsoft Entra ID get an account here, and people you
              remove there lose access here within minutes. Setup takes three steps:
            </Trans>
          </p>
          <ol {...stylex.props(styles.steps)}>
            {SETUP_STEPS.map((item, index) => (
              <li key={index} {...stylex.props(styles.step)}>
                <span {...stylex.props(styles.stepName)}>{i18n._(item.step)}</span>
                <span {...stylex.props(list.muted)}>{i18n._(item.detail)}</span>
              </li>
            ))}
          </ol>
          <div {...stylex.props(styles.emptyActions)}>
            <Button onClick={() => setConnecting(true)}>
              <Icon name="plus" size={16} />
              <Trans>Connect a directory</Trans>
            </Button>
            <a
              href={`${DOCS_URL}/scim`}
              target="_blank"
              rel="noreferrer"
              {...stylex.props(styles.link)}
            >
              <Trans>Read the SCIM setup guide</Trans>
            </a>
          </div>
        </section>
      ) : (
        <DataTable
          columns={columns}
          data={rows}
          getRowId={(row) => row.id}
          isLoading={directories.isLoading}
          onRowClick={open}
          density="comfortable"
          narrowMode="priority"
          caption={t`Directories`}
          captionDisplay="hidden"
          emptyMessage={<Trans>No directories.</Trans>}
        />
      )}
      {connecting ? (
        <ConnectDirectoryDialog
          orgId={orgId}
          onClose={() => setConnecting(false)}
          onCreated={(directory, token) => {
            setConnecting(false)
            setCreated({ directory, issued: { token, previousTokenExpiresAt: null } })
          }}
        />
      ) : null}
      {created ? (
        <ScimTokenDialog
          issued={created.issued}
          providerName={scimProviderLabel(i18n, created.directory.provider)}
          onDone={() => {
            const directory = created.directory
            setCreated(null)
            open(directory)
          }}
        />
      ) : null}
    </PageFrame>
  )
}

function ConnectDirectoryDialog({
  orgId,
  onClose,
  onCreated,
}: {
  orgId: string
  onClose: () => void
  onCreated: (directory: ScimDirectory, token: string) => void
}): ReactNode {
  const { i18n } = useLingui()
  const errorMessage = useApiErrorMessage()
  const create = useCreateScimDirectory(orgId)
  const [provider, setProvider] = useState<string>('okta')

  function submit(event: FormEvent): void {
    event.preventDefault()
    create.mutate({ provider }, { onSuccess: (result) => onCreated(result, result.scimToken) })
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => (next || create.isPending ? undefined : onClose())}
      title={<Trans>Connect a directory</Trans>}
      description={
        <Trans>XID creates a SCIM base URL and a bearer token. You'll see the token once.</Trans>
      }
      size="md"
      footer={
        <>
          <Button variant="secondary" disabled={create.isPending} onClick={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button type="submit" form="connect-directory" isLoading={create.isPending}>
            <Trans>Create connection</Trans>
          </Button>
        </>
      }
    >
      <form id="connect-directory" onSubmit={submit} noValidate>
        <Field label={<Trans>Identity provider</Trans>}>
          <Select value={provider} onChange={(event) => setProvider(event.target.value)}>
            {PROVIDERS.map((option) => (
              <option key={option} value={option}>
                {scimProviderLabel(i18n, option)}
              </option>
            ))}
          </Select>
        </Field>
      </form>
      {create.error ? (
        <Alert tone="error">{errorMessage(create.error, { surface: 'general' })}</Alert>
      ) : null}
    </Dialog>
  )
}
