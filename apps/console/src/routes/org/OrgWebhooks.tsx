// Webhook 端点列表;?webhookId= 进入端点详情。签名 secret 只在创建与轮换时一次性展示。

import type { MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { errorTargetsField, useManagementErrorMessage } from '@xid-kit/web-ui/api-error-message'
import { ConfirmDialog } from '@xid-kit/web-ui/ConfirmDialog'
import { organizationDisplayName } from '@xid-kit/web-ui/display-names'
import { useAuth } from '@xid-kit/web-ui/session'
import { leading, text, weight } from '@xid-kit/web-ui/styles/scale.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { useLocation, useNavigate, useSearchParams } from '@xid-kit/web-ui/tanstack-router'
import {
  Alert,
  Button,
  Dialog,
  Dropdown,
  EmptyState,
  Field,
  Icon,
  IdentityCell,
  Input,
} from '@xid-kit/web-ui/ui'
import { DataTable } from '@xid-kit/web-ui/ui/DataTable'
import { LoadMore } from '@xid-kit/web-ui/ui/LoadMore'
import type { DataTableColumnDef } from '@xid-kit/web-ui/ui/DataTable'
import { DOCS_URL } from '../../components/layout/ConsoleTopBar'
import { PageFrame } from '../../components/page/PageFrame'
import { list } from '../../components/page/list-styles'
import { formatDate } from '../../lib/date-format'
import { withOrgId } from '../users/UsersList'
import { useUpdateWebhook } from './integration-queries'
import { useCreateWebhook, useDeleteWebhook, useWebhooksQuery } from './queries'
import { TenantScopeGate } from './TenantScopeGate'
import type { CreatedWebhookEndpoint, WebhookEndpoint } from './types'
import WebhookDetail, {
  EventsField,
  SigningSecretDialog,
  WebhookStatusBadge,
  endpointHost,
} from './WebhookDetail'

const WEBHOOKS_PATH = '/console/org/webhooks'

type StatusFilter = 'active' | 'disabled' | null

const STARTER_EVENTS: readonly { event: string; meaning: MessageDescriptor }[] = [
  { event: 'user.created', meaning: msg`Someone signs up or is invited` },
  { event: 'organizationMembership.created', meaning: msg`Someone joins an organization` },
  { event: 'user.deleted', meaning: msg`An account is deleted` },
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
  examples: {
    width: '100%',
    margin: 0,
    padding: 0,
    listStyle: 'none',
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
  },
  example: {
    display: 'grid',
    gridTemplateColumns: { default: '1fr', '@media (min-width: 48rem)': '17.5rem minmax(0, 1fr)' },
    gap: '0.125rem 1rem',
    paddingBlock: '0.625rem',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
    fontSize: text.sm,
  },
  code: { fontFamily: tokens['--xid-font-mono'], fontSize: text.sm, overflowWrap: 'anywhere' },
  emptyActions: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '0.5rem 1rem',
    paddingTop: '0.5rem',
  },
  link: { color: tokens['--xid-accent'], fontSize: text.sm, textDecoration: 'none' },
  form: { display: 'flex', flexDirection: 'column', gap: '1rem' },
})

export default function OrgWebhooks(): ReactNode {
  const [params] = useSearchParams()
  const location = useLocation()
  const webhookId = params.get('webhookId')
  return (
    <TenantScopeGate title={<Trans>Webhooks</Trans>}>
      {webhookId ? (
        <WebhookDetail
          key={webhookId}
          webhookId={webhookId}
          listPath={withOrgId(WEBHOOKS_PATH, location.search)}
        />
      ) : (
        <WebhooksList />
      )}
    </TenantScopeGate>
  )
}

function detailPath(search: string, webhookId: string): string {
  const next = new URLSearchParams(search)
  next.set('webhookId', webhookId)
  return `${WEBHOOKS_PATH}?${next.toString()}`
}

function WebhooksList(): ReactNode {
  const { t, i18n } = useLingui()
  const { activeOrg } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const errorMessage = useManagementErrorMessage()
  const webhooks = useWebhooksQuery()
  const update = useUpdateWebhook()
  const remove = useDeleteWebhook()
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<StatusFilter>(null)
  const [adding, setAdding] = useState(false)
  const [created, setCreated] = useState<CreatedWebhookEndpoint | null>(null)
  const [pendingDelete, setPendingDelete] = useState<WebhookEndpoint | null>(null)
  const orgName = activeOrg ? organizationDisplayName(activeOrg) : ''
  const rows = webhooks.data?.data ?? []
  const needle = query.trim().toLowerCase()
  const shown = rows.filter(
    (row) =>
      (status === null || row.status === status) &&
      (needle === '' || row.url.toLowerCase().includes(needle)),
  )
  const statusLabels = { active: t`Enabled`, disabled: t`Disabled` }
  const open = (row: Pick<WebhookEndpoint, 'id'>) => navigate(detailPath(location.search, row.id))

  const columns: DataTableColumnDef<WebhookEndpoint>[] = [
    {
      id: 'endpoint',
      header: () => t`Endpoint`,
      cell: ({ row }) => (
        <IdentityCell
          name={endpointHost(row.original.url)}
          secondary={row.original.url}
          secondaryIsCode
        />
      ),
      meta: { priority: 'primary', width: '62%' },
    },
    {
      id: 'status',
      header: () => t`Status`,
      cell: ({ row }) => <WebhookStatusBadge status={row.original.status} />,
      meta: { priority: 'primary' },
    },
    {
      id: 'created',
      header: () => t`Created`,
      cell: ({ row }) => (
        <span {...stylex.props(list.numeric)}>{formatDate(i18n, row.original.created_at)}</span>
      ),
      meta: { align: 'end', hidden: { narrow: true, regular: false } },
    },
    {
      id: 'menu',
      header: () => t`Actions`,
      cell: ({ row }) => {
        const host = endpointHost(row.original.url)
        const enabled = row.original.status === 'active'
        return (
          <span {...stylex.props(list.rowMenu)} onClick={(event) => event.stopPropagation()}>
            <Dropdown
              ariaLabel={t`Actions for ${host}`}
              align="end"
              triggerStyle={list.iconButton}
              trigger={<Icon name="more-horizontal" size={16} />}
              items={[
                {
                  key: 'open',
                  label: <Trans>View deliveries</Trans>,
                  onSelect: () => open(row.original),
                },
                {
                  key: 'toggle',
                  label: enabled ? <Trans>Disable endpoint</Trans> : <Trans>Enable endpoint</Trans>,
                  onSelect: () =>
                    update.mutate({
                      webhookId: row.original.id,
                      status: enabled ? 'disabled' : 'active',
                    }),
                },
                {
                  key: 'delete',
                  label: <Trans>Delete endpoint…</Trans>,
                  tone: 'danger',
                  separatorBefore: true,
                  onSelect: () => setPendingDelete(row.original),
                },
              ]}
            />
          </span>
        )
      },
      meta: { priority: 'primary', align: 'end', width: '3rem' },
    },
  ]

  const isEmpty = webhooks.data !== undefined && rows.length === 0
  const actionError = update.error

  return (
    <PageFrame
      title={<Trans>Webhooks</Trans>}
      lead={
        <Trans>
          Send user and membership changes in {orgName} to your own services. Every request is
          signed so you can verify it came from XID.
        </Trans>
      }
    >
      {actionError ? <Alert tone="error">{errorMessage(actionError)}</Alert> : null}
      {webhooks.isError && !webhooks.data ? (
        <EmptyState
          variant="load-failure"
          title={<Trans>Webhooks could not be loaded</Trans>}
          description={<Trans>Nothing changed. Check your connection and try again.</Trans>}
          action={
            <Button variant="secondary" onClick={() => void webhooks.refetch()}>
              <Trans>Try again</Trans>
            </Button>
          }
        />
      ) : isEmpty ? (
        <section {...stylex.props(styles.empty)}>
          <h2 {...stylex.props(styles.emptyTitle)}>
            <Trans>{orgName} doesn't send webhooks yet</Trans>
          </h2>
          <p {...stylex.props(styles.emptyLead)}>
            <Trans>
              Add an endpoint and XID will POST each change to it within seconds. Most teams start
              with these three events:
            </Trans>
          </p>
          <ul {...stylex.props(styles.examples)}>
            {STARTER_EVENTS.map((item) => (
              <li key={item.event} {...stylex.props(styles.example)}>
                <span {...stylex.props(styles.code)}>{item.event}</span>
                <span {...stylex.props(list.muted)}>{i18n._(item.meaning)}</span>
              </li>
            ))}
          </ul>
          <div {...stylex.props(styles.emptyActions)}>
            <Button onClick={() => setAdding(true)}>
              <Icon name="plus" size={16} />
              <Trans>Add endpoint</Trans>
            </Button>
            <a
              href={`${DOCS_URL}/webhooks`}
              target="_blank"
              rel="noreferrer"
              {...stylex.props(styles.link)}
            >
              <Trans>Read the signature guide</Trans>
            </a>
          </div>
        </section>
      ) : (
        <>
          <div {...stylex.props(list.bar)}>
            <label {...stylex.props(list.search)}>
              <span aria-hidden="true" {...stylex.props(list.searchIcon)}>
                <Icon name="search" size={16} />
              </span>
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
                placeholder={t`Endpoint URL`}
                aria-label={t`Search endpoints`}
                {...stylex.props(list.searchInput)}
              />
            </label>
            <Dropdown
              ariaLabel={t`Status`}
              align="start"
              triggerStyle={list.filterButton}
              trigger={
                <>
                  <span>{t`Status`}</span>
                  {status ? (
                    <span {...stylex.props(list.filterValue)}>{statusLabels[status]}</span>
                  ) : null}
                  <Icon name="caret-down" size={12} />
                </>
              }
              items={[
                {
                  key: 'any',
                  label: t`Any`,
                  checked: status === null,
                  onSelect: () => setStatus(null),
                },
                ...(['active', 'disabled'] as const).map((option) => ({
                  key: option,
                  label: statusLabels[option],
                  checked: status === option,
                  onSelect: () => setStatus(option),
                })),
              ]}
            />
            <div {...stylex.props(list.barEnd)}>
              <Button onClick={() => setAdding(true)}>
                <Icon name="plus" size={16} />
                <Trans>Add endpoint</Trans>
              </Button>
            </div>
          </div>
          <DataTable
            columns={columns}
            data={shown}
            getRowId={(row) => row.id}
            isLoading={webhooks.isLoading}
            onRowClick={open}
            density="comfortable"
            narrowMode="priority"
            caption={t`Webhook endpoints`}
            captionDisplay="hidden"
            emptyMessage={<Trans>No endpoints match these filters.</Trans>}
          />
          <LoadMore query={webhooks} loadMoreLabel={<Trans>Load more endpoints</Trans>} />
        </>
      )}
      {adding ? (
        <AddEndpointDialog
          onClose={() => setAdding(false)}
          onCreated={(endpoint) => {
            setAdding(false)
            setCreated(endpoint)
          }}
        />
      ) : null}
      {created ? (
        <SigningSecretDialog
          host={endpointHost(created.url)}
          secret={created.signing_secret}
          rotated={false}
          onDone={() => {
            const endpoint = created
            setCreated(null)
            open(endpoint)
          }}
        />
      ) : null}
      {pendingDelete ? (
        <DeleteEndpointDialog
          endpoint={pendingDelete}
          isLoading={remove.isPending}
          error={errorMessage(remove.error)}
          onConfirm={() =>
            remove.mutate(pendingDelete.id, { onSuccess: () => setPendingDelete(null) })
          }
          onCancel={() => setPendingDelete(null)}
        />
      ) : null}
    </PageFrame>
  )
}

function DeleteEndpointDialog({
  endpoint,
  isLoading,
  error,
  onConfirm,
  onCancel,
}: {
  endpoint: WebhookEndpoint
  isLoading: boolean
  error: string | undefined
  onConfirm: () => void
  onCancel: () => void
}): ReactNode {
  const host = endpointHost(endpoint.url)
  return (
    <ConfirmDialog
      title={<Trans>Delete the {host} endpoint?</Trans>}
      description={<Trans>XID stops sending events to {host} right away.</Trans>}
      confirmLabel={<Trans>Delete endpoint</Trans>}
      isLoading={isLoading}
      error={error}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  )
}

function AddEndpointDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: (endpoint: CreatedWebhookEndpoint) => void
}): ReactNode {
  const { t } = useLingui()
  const errorMessage = useManagementErrorMessage()
  const create = useCreateWebhook()
  const [url, setUrl] = useState('')
  const [events, setEvents] = useState<string[]>([])
  const eventsError = errorTargetsField(create.error, 'event_types')
  const urlError = create.error && !eventsError ? errorMessage(create.error) : null

  function submit(event: FormEvent): void {
    event.preventDefault()
    if (!url.trim()) return
    create.mutate({ url: url.trim(), event_types: events }, { onSuccess: onCreated })
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => (next || create.isPending ? undefined : onClose())}
      title={<Trans>Add endpoint</Trans>}
      description={
        <Trans>
          XID signs every request. You'll see the signing secret once, right after you add it.
        </Trans>
      }
      position={{ narrow: 'fullscreen', regular: 'center' }}
      size="lg"
      footer={
        <>
          <Button variant="secondary" disabled={create.isPending} onClick={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button type="submit" form="add-webhook-endpoint" isLoading={create.isPending}>
            <Trans>Add endpoint</Trans>
          </Button>
        </>
      }
    >
      <form id="add-webhook-endpoint" onSubmit={submit} noValidate {...stylex.props(styles.form)}>
        <Field
          label={<Trans>Endpoint URL</Trans>}
          hint={<Trans>A public HTTPS URL.</Trans>}
          error={urlError ?? undefined}
          required
        >
          <Input
            type="url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder={t`https://example.com/webhooks/xid`}
            autoFocus
          />
        </Field>
        <EventsField
          selected={events}
          onChange={setEvents}
          error={eventsError ? (errorMessage(create.error) ?? undefined) : undefined}
        />
      </form>
    </Dialog>
  )
}
