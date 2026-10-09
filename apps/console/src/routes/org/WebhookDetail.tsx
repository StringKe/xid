// Webhook 端点详情:投递记录(全部 / 失败 / 待重试,游标翻页)、签名 secret 轮换、订阅事件与近 7 天统计。
// 投递摘要只有主体显示名,句子按事件类型在前端拼出;payload 原文不经过 Console。

import type { I18n } from '@lingui/core'
import { Plural, Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { WEBHOOK_EVENT_TYPES } from '@xid-kit/types'
import { useManagementErrorMessage } from '@xid-kit/web-ui/api-error-message'
import { ConfirmDialog } from '@xid-kit/web-ui/ConfirmDialog'
import { leading, text, weight } from '@xid-kit/web-ui/styles/scale.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { Link, useNavigate } from '@xid-kit/web-ui/tanstack-router'
import {
  Alert,
  Badge,
  Button,
  CopyButton,
  Dialog,
  Dropdown,
  EmptyState,
  Field,
  Icon,
  OneTimeSecret,
  SegmentedControl,
  Skeleton,
  useToast,
} from '@xid-kit/web-ui/ui'
import type { BadgeTone } from '@xid-kit/web-ui/ui'
import { DataTable } from '@xid-kit/web-ui/ui/DataTable'
import type { DataTableColumnDef } from '@xid-kit/web-ui/ui/DataTable'
import { frame } from '../../components/page/PageFrame'
import { detail } from '../../components/page/detail-styles'
import { list } from '../../components/page/list-styles'
import { formatDate } from '../../lib/date-format'
import { ChoiceList } from './ChoiceList'
import type {
  WebhookDelivery,
  WebhookDeliveryFilter,
  WebhookDeliveryStatus,
  WebhookDetail as WebhookDetailRecord,
} from './integration-queries'
import {
  DELIVERY_PAGE_SIZE,
  useUpdateWebhook,
  useWebhookDeliveriesQuery,
  useWebhookDetailQuery,
} from './integration-queries'
import { useDeleteWebhook, useRotateWebhookSecret } from './queries'

const styles = stylex.create({
  layout: {
    display: 'grid',
    gridTemplateColumns: {
      default: 'minmax(0, 1fr)',
      '@media (min-width: 64rem)': 'minmax(0, 1fr) 22.5rem',
    },
    gap: { default: '1.5rem', '@media (min-width: 64rem)': '2.5rem' },
    alignItems: 'start',
  },
  main: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
    minWidth: 0,
    order: { default: 2, '@media (min-width: 64rem)': 1 },
  },
  aside: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1.5rem',
    minWidth: 0,
    order: { default: 1, '@media (min-width: 64rem)': 2 },
  },
  asideBlock: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
    paddingBottom: '1.5rem',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  asideHead: {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: '0.75rem',
  },
  asideTitle: {
    margin: 0,
    fontSize: text.md,
    lineHeight: leading.md,
    fontWeight: weight.display,
  },
  textAction: {
    appearance: 'none',
    padding: 0,
    borderWidth: 0,
    backgroundColor: 'transparent',
    color: tokens['--xid-accent'],
    fontFamily: tokens['--xid-font'],
    fontSize: text.sm,
    cursor: 'pointer',
  },
  secretCard: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.375rem',
    padding: '0.875rem',
    borderRadius: tokens['--xid-radius'],
    boxShadow: `inset 0 0 0 1px ${tokens['--xid-border']}`,
    fontSize: text.sm,
  },
  secretHead: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: '0.75rem',
    flexWrap: 'wrap',
  },
  strong: { fontWeight: weight.medium },
  muted: {
    margin: 0,
    fontSize: text.sm,
    lineHeight: leading.body,
    color: tokens['--xid-muted-foreground'],
  },
  eventList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.375rem',
    margin: 0,
    padding: 0,
    listStyle: 'none',
  },
  mono: { fontFamily: tokens['--xid-font-mono'], fontSize: text.sm, overflowWrap: 'anywhere' },
  facts: { display: 'flex', flexDirection: 'column', gap: '0.75rem', margin: 0 },
  fact: { display: 'flex', flexDirection: 'column', gap: '0.125rem' },
  factLabel: { fontSize: text.xs, color: tokens['--xid-muted-foreground'] },
  factValue: { margin: 0, fontSize: text.sm, overflowWrap: 'anywhere' },
  sectionHead: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: '0.75rem 1.5rem',
  },
  sectionText: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.25rem',
    flex: '1 1 18rem',
    minWidth: 0,
  },
  sectionTitle: {
    margin: 0,
    fontSize: { default: text.md, '@media (min-width: 48rem)': text.lg },
    lineHeight: { default: leading.md, '@media (min-width: 48rem)': leading.lg },
    fontWeight: weight.display,
    letterSpacing: tokens['--xid-tracking-title'],
  },
  cellStack: { display: 'flex', flexDirection: 'column', gap: '0.125rem', minWidth: 0 },
  pager: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '0.75rem',
  },
  pagerButtons: { display: 'flex', gap: '0.5rem' },
  urlRow: { display: 'inline-flex', alignItems: 'center', gap: '0.25rem', minWidth: 0 },
  form: { display: 'flex', flexDirection: 'column', gap: '1rem' },
})

export function endpointHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

export function WebhookStatusBadge({ status }: { status: string }): ReactNode {
  return status === 'active' ? (
    <Badge tone="success">
      <Trans>Enabled</Trans>
    </Badge>
  ) : (
    <Badge tone="neutral">
      <Trans>Disabled</Trans>
    </Badge>
  )
}

export function SigningSecretDialog({
  host,
  secret,
  rotated,
  onDone,
}: {
  host: string
  secret: string
  rotated: boolean
  onDone: () => void
}): ReactNode {
  const { t } = useLingui()
  return (
    <Dialog
      open
      dismissible={false}
      onOpenChange={() => undefined}
      title={
        rotated ? (
          <Trans>Copy the new signing secret</Trans>
        ) : (
          <Trans>Copy the signing secret</Trans>
        )
      }
      description={
        <Trans>
          This is the only time XID shows it. {host} needs it to verify that each request came from
          XID.
        </Trans>
      }
      position={{ narrow: 'fullscreen', regular: 'center' }}
      size="md"
    >
      <OneTimeSecret
        label={<Trans>Signing secret</Trans>}
        value={secret}
        subject={t`signing secret`}
        savedLabel={<Trans>I saved the secret somewhere safe</Trans>}
        onDone={onDone}
      />
    </Dialog>
  )
}

export function EventsField({
  selected,
  onChange,
  error,
}: {
  selected: readonly string[]
  onChange: (next: string[]) => void
  error?: string
}): ReactNode {
  const { t } = useLingui()
  return (
    <Field
      label={<Trans>Events</Trans>}
      error={error}
      hint={<Trans>Leave all unchecked to receive every event.</Trans>}
    >
      <ChoiceList
        options={WEBHOOK_EVENT_TYPES}
        selected={selected}
        onChange={onChange}
        label={t`Events`}
      />
    </Field>
  )
}

function EditEventsDialog({
  webhook,
  onClose,
}: {
  webhook: WebhookDetailRecord
  onClose: () => void
}): ReactNode {
  const errorMessage = useManagementErrorMessage()
  const update = useUpdateWebhook()
  const [selected, setSelected] = useState<string[]>(webhook.event_types)
  return (
    <Dialog
      open
      onOpenChange={(next) => (next || update.isPending ? undefined : onClose())}
      title={<Trans>Edit events</Trans>}
      description={<Trans>Only the events you pick are sent to this endpoint.</Trans>}
      size="lg"
      footer={
        <>
          <Button variant="secondary" disabled={update.isPending} onClick={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button
            isLoading={update.isPending}
            onClick={() =>
              update.mutate(
                { webhookId: webhook.id, event_types: selected },
                { onSuccess: onClose },
              )
            }
          >
            <Trans>Save events</Trans>
          </Button>
        </>
      }
    >
      <EventsField
        selected={selected}
        onChange={setSelected}
        error={update.error ? (errorMessage(update.error) ?? undefined) : undefined}
      />
    </Dialog>
  )
}

const STATUS_TONE: Record<WebhookDeliveryStatus, BadgeTone> = {
  delivered: 'success',
  failed: 'danger',
  pending: 'warning',
}

function DeliveryStatus({ status }: { status: WebhookDeliveryStatus }): ReactNode {
  return (
    <Badge tone={STATUS_TONE[status]}>
      {status === 'delivered' ? <Trans>Delivered</Trans> : null}
      {status === 'failed' ? <Trans>Failed</Trans> : null}
      {status === 'pending' ? <Trans>Pending</Trans> : null}
    </Badge>
  )
}

function shortDateTime(i18n: I18n, value: string): string {
  return i18n.date(new Date(value), {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function DeliveryResponse({ delivery }: { delivery: WebhookDelivery }): ReactNode {
  const { i18n } = useLingui()
  const tries = delivery.attemptCount
  const httpStatus = delivery.responseStatus ?? 0
  const ms = delivery.responseMs ?? 0
  if (delivery.status === 'delivered')
    return (
      <Trans>
        {httpStatus} in {ms} ms
      </Trans>
    )
  if (delivery.status === 'pending') {
    if (!delivery.nextRetryAt) return <Trans>Sending</Trans>
    const next = tries + 1
    const max = delivery.maxAttempts
    const at = i18n.date(new Date(delivery.nextRetryAt), { hour: '2-digit', minute: '2-digit' })
    return (
      <Trans>
        Try {next} of {max} at {at}
      </Trans>
    )
  }
  if (delivery.lastError === 'timeout') {
    return <Plural value={tries} one="Timeout, # try" other="Timeout, # tries" />
  }
  if (delivery.lastError === 'network') {
    return <Plural value={tries} one="No connection, # try" other="No connection, # tries" />
  }
  return (
    <Trans>
      {httpStatus} after <Plural value={tries} one="# try" other="# tries" />
    </Trans>
  )
}

function DeliverySummary({ delivery }: { delivery: WebhookDelivery }): ReactNode {
  const user = delivery.summary.userName ?? delivery.summary.userId ?? ''
  const org = delivery.summary.organizationName ?? delivery.summary.organizationId ?? ''
  const [object, action] = delivery.eventType.split(/\.(?=[^.]+$)/)
  if (object === 'user' && user) {
    if (action === 'created') return <Trans>{user} was created</Trans>
    if (action === 'deleted') return <Trans>{user} was deleted</Trans>
    if (action === 'restored') return <Trans>{user} was restored</Trans>
    if (action === 'banned') return <Trans>{user} was suspended</Trans>
    if (action === 'unbanned') return <Trans>{user} was unsuspended</Trans>
    if (action === 'deactivated') return <Trans>{user} was deactivated</Trans>
    return <Trans>{user} was updated</Trans>
  }
  if (object === 'organizationMembership' && org) {
    if (action === 'created' && user)
      return (
        <Trans>
          {user} joined {org}
        </Trans>
      )
    if (action === 'deleted' && user)
      return (
        <Trans>
          {user} left {org}
        </Trans>
      )
    if (user)
      return (
        <Trans>
          {user}'s membership in {org} changed
        </Trans>
      )
    return <Trans>A membership in {org} changed</Trans>
  }
  if (object === 'organizationInvitation' && org) {
    if (action === 'accepted') return <Trans>An invitation to {org} was accepted</Trans>
    if (action === 'revoked') return <Trans>An invitation to {org} was revoked</Trans>
    return <Trans>Someone was invited to {org}</Trans>
  }
  if (org) return <Trans>{org} changed</Trans>
  return user ? <>{user}</> : null
}

function Deliveries({ webhookId }: { webhookId: string }): ReactNode {
  const { t, i18n } = useLingui()
  const [filter, setFilter] = useState<WebhookDeliveryFilter>('all')
  const [cursors, setCursors] = useState<(string | null)[]>([null])
  const cursor = cursors[cursors.length - 1] ?? null
  const deliveries = useWebhookDeliveriesQuery(webhookId, filter, cursor)
  const page = deliveries.data
  const pageSize = DELIVERY_PAGE_SIZE
  const columns: DataTableColumnDef<WebhookDelivery>[] = [
    {
      id: 'event',
      header: () => t`Event`,
      cell: ({ row }) => (
        <span {...stylex.props(styles.cellStack)}>
          <span {...stylex.props(styles.mono)}>{row.original.eventType}</span>
          <span {...stylex.props(list.cellSub)}>
            <DeliverySummary delivery={row.original} />
          </span>
        </span>
      ),
      meta: { priority: 'primary', width: '46%' },
    },
    {
      id: 'status',
      header: () => t`Status`,
      cell: ({ row }) => <DeliveryStatus status={row.original.status} />,
      meta: { priority: 'primary' },
    },
    {
      id: 'response',
      header: () => t`Response`,
      cell: ({ row }) => <DeliveryResponse delivery={row.original} />,
      meta: { hidden: { narrow: true, regular: false } },
    },
    {
      id: 'sent',
      header: () => t`Sent`,
      cell: ({ row }) => (
        <span {...stylex.props(list.numeric)}>{shortDateTime(i18n, row.original.createdAt)}</span>
      ),
      meta: { align: 'end' },
    },
  ]

  function selectFilter(value: string): void {
    setFilter(value as WebhookDeliveryFilter)
    setCursors([null])
  }

  return (
    <section {...stylex.props(styles.main)}>
      <div {...stylex.props(styles.sectionHead)}>
        <div {...stylex.props(styles.sectionText)}>
          <h2 {...stylex.props(styles.sectionTitle)}>
            <Trans>Deliveries</Trans>
          </h2>
          <p {...stylex.props(styles.muted)}>
            <Trans>
              XID retries a failed delivery up to 5 times with growing pauses, then marks it failed.
              Failed deliveries are not sent again.
            </Trans>
          </p>
        </div>
        <SegmentedControl
          ariaLabel={t`Delivery status`}
          value={filter}
          onValueChange={selectFilter}
          options={[
            { value: 'all', label: t`All` },
            { value: 'failed', label: t`Failed` },
            { value: 'pending', label: t`Pending` },
          ]}
        />
      </div>
      {deliveries.isError && !page ? (
        <EmptyState
          variant="load-failure"
          title={<Trans>Deliveries could not be loaded</Trans>}
          action={
            <Button variant="secondary" onClick={() => void deliveries.refetch()}>
              <Trans>Try again</Trans>
            </Button>
          }
        />
      ) : (
        <DataTable
          columns={columns}
          data={page?.data ?? []}
          getRowId={(row) => row.id}
          isLoading={deliveries.isLoading}
          density="comfortable"
          narrowMode="scroll"
          caption={t`Deliveries`}
          captionDisplay="hidden"
          emptyMessage={
            filter === 'all' ? (
              <Trans>No deliveries yet. XID sends one as soon as a subscribed event happens.</Trans>
            ) : filter === 'failed' ? (
              <Trans>No failed deliveries.</Trans>
            ) : (
              <Trans>No deliveries are waiting for a retry.</Trans>
            )
          }
        />
      )}
      <div {...stylex.props(styles.pager)}>
        <span {...stylex.props(list.muted)}>
          <Trans>Newest first, {pageSize} per page.</Trans>
        </span>
        <span {...stylex.props(styles.pagerButtons)}>
          <Button
            variant="secondary"
            disabled={cursors.length <= 1}
            onClick={() => setCursors((current) => current.slice(0, -1))}
          >
            <Trans>Previous</Trans>
          </Button>
          <Button
            variant="secondary"
            disabled={!page?.next_cursor}
            onClick={() => {
              const next = page?.next_cursor
              if (next) setCursors((current) => [...current, next])
            }}
          >
            <Trans>Next</Trans>
          </Button>
        </span>
      </div>
    </section>
  )
}

function WebhookAside({
  webhook,
  onRotate,
  onEditEvents,
}: {
  webhook: WebhookDetailRecord
  onRotate: () => void
  onEditEvents: () => void
}): ReactNode {
  const { i18n } = useLingui()
  const host = endpointHost(webhook.url)
  const rotatedAt = formatDate(i18n, webhook.secretRotatedAt) ?? ''
  const created = formatDate(i18n, webhook.created_at) ?? ''
  const creator = webhook.createdBy ? (webhook.createdBy.displayName ?? webhook.createdBy.id) : null
  const subscribed = webhook.event_types.length
  const total = WEBHOOK_EVENT_TYPES.length
  const { sent, delivered, failed, pending } = webhook.stats7d
  return (
    <aside {...stylex.props(styles.aside)}>
      <section {...stylex.props(styles.asideBlock)}>
        <div {...stylex.props(styles.asideHead)}>
          <h2 {...stylex.props(styles.asideTitle)}>
            <Trans>Signing secret</Trans>
          </h2>
          <button type="button" onClick={onRotate} {...stylex.props(styles.textAction)}>
            <Trans>Rotate secret…</Trans>
          </button>
        </div>
        <div {...stylex.props(styles.secretCard)}>
          <div {...stylex.props(styles.secretHead)}>
            <span {...stylex.props(styles.strong)}>
              <Trans>Current</Trans>
            </span>
            <span {...stylex.props(list.muted)}>
              <Trans>Updated {rotatedAt}</Trans>
            </span>
          </div>
          <p {...stylex.props(styles.muted)}>
            <Trans>Shown once, when the endpoint was created or the secret was last rotated.</Trans>
          </p>
        </div>
        <p {...stylex.props(styles.muted)}>
          <Trans>
            Rotating creates a new secret. The current secret stops working immediately, so update{' '}
            {host} right after.
          </Trans>
        </p>
      </section>
      <section {...stylex.props(styles.asideBlock)}>
        <div {...stylex.props(styles.asideHead)}>
          <h2 {...stylex.props(styles.asideTitle)}>
            <Trans>Events</Trans>
          </h2>
          <button type="button" onClick={onEditEvents} {...stylex.props(styles.textAction)}>
            <Trans>Edit events…</Trans>
          </button>
        </div>
        <p {...stylex.props(styles.muted)}>
          {subscribed === 0 ? (
            <Trans>Subscribed to every event, including ones added later.</Trans>
          ) : (
            <Trans>
              Subscribed to {subscribed} of {total} events
            </Trans>
          )}
        </p>
        {subscribed > 0 ? (
          <ul {...stylex.props(styles.eventList)}>
            {webhook.event_types.map((event) => (
              <li key={event} {...stylex.props(styles.mono)}>
                {event}
              </li>
            ))}
          </ul>
        ) : null}
      </section>
      <section {...stylex.props(styles.asideBlock)}>
        <h2 {...stylex.props(styles.asideTitle)}>
          <Trans>Details</Trans>
        </h2>
        <dl {...stylex.props(styles.facts)}>
          <div {...stylex.props(styles.fact)}>
            <dt {...stylex.props(styles.factLabel)}>
              <Trans>Endpoint ID</Trans>
            </dt>
            <dd {...stylex.props(styles.factValue, styles.mono)}>{webhook.id}</dd>
          </div>
          <div {...stylex.props(styles.fact)}>
            <dt {...stylex.props(styles.factLabel)}>
              <Trans>Created</Trans>
            </dt>
            <dd {...stylex.props(styles.factValue)}>
              {creator ? (
                <Trans>
                  {created} by {creator}
                </Trans>
              ) : (
                created
              )}
            </dd>
          </div>
          <div {...stylex.props(styles.fact)}>
            <dt {...stylex.props(styles.factLabel)}>
              <Trans>Last 7 days</Trans>
            </dt>
            <dd {...stylex.props(styles.factValue)}>
              <Trans>
                {sent} sent, {delivered} delivered, {failed} failed, {pending} pending
              </Trans>
            </dd>
          </div>
        </dl>
      </section>
    </aside>
  )
}

export default function WebhookDetail({
  webhookId,
  listPath,
}: {
  webhookId: string
  listPath: string
}): ReactNode {
  const { t } = useLingui()
  const { notify } = useToast()
  const navigate = useNavigate()
  const errorMessage = useManagementErrorMessage()
  const webhook = useWebhookDetailQuery(webhookId)
  const update = useUpdateWebhook()
  const rotate = useRotateWebhookSecret()
  const remove = useDeleteWebhook()
  const [confirmRotate, setConfirmRotate] = useState(false)
  const [secret, setSecret] = useState<string | null>(null)
  const [editingEvents, setEditingEvents] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const record = webhook.data
  const host = record ? endpointHost(record.url) : ''
  const breadcrumb = (
    <ol {...stylex.props(frame.crumbs)}>
      <li>
        <Link to={listPath} {...stylex.props(frame.crumbLink)}>
          <Trans>Webhooks</Trans>
        </Link>
      </li>
      <li aria-hidden="true" {...stylex.props(frame.crumbSep)}>
        /
      </li>
      <li aria-current="page">{record ? host : <Skeleton width="6rem" height="0.75rem" />}</li>
    </ol>
  )

  if (webhook.isError && !record) {
    const missing = webhook.error.httpStatus === 404
    return (
      <div {...stylex.props(frame.root)}>
        {breadcrumb}
        <EmptyState
          variant="load-failure"
          title={
            missing ? (
              <Trans>Endpoint not found</Trans>
            ) : (
              <Trans>Endpoint could not be loaded</Trans>
            )
          }
          action={
            missing ? null : (
              <Button variant="secondary" onClick={() => void webhook.refetch()}>
                <Trans>Try again</Trans>
              </Button>
            )
          }
        />
      </div>
    )
  }
  if (!record) {
    return (
      <div {...stylex.props(frame.root)}>
        {breadcrumb}
        <Skeleton width="16rem" height="2rem" />
      </div>
    )
  }

  const enabled = record.status === 'active'
  const actionError = update.error ?? rotate.error

  return (
    <div {...stylex.props(frame.root)}>
      {breadcrumb}
      <div {...stylex.props(detail.header)}>
        <div {...stylex.props(detail.titleBlock)}>
          <div {...stylex.props(detail.titleRow)}>
            <h1 {...stylex.props(detail.title)}>{host}</h1>
            <WebhookStatusBadge status={record.status} />
          </div>
          <span {...stylex.props(styles.urlRow)}>
            <span {...stylex.props(detail.mono)}>{record.url}</span>
            <CopyButton value={record.url} subject={t`endpoint URL`} />
          </span>
        </div>
        <Dropdown
          ariaLabel={t`Actions for ${host}`}
          align="end"
          triggerStyle={list.filterButton}
          trigger={({ open }) => (
            <>
              <Trans>Actions</Trans>
              <Icon name={open ? 'caret-up' : 'caret-down'} size={12} />
            </>
          )}
          items={[
            {
              key: 'events',
              label: <Trans>Edit events…</Trans>,
              onSelect: () => setEditingEvents(true),
            },
            {
              key: 'rotate',
              label: <Trans>Rotate secret…</Trans>,
              onSelect: () => setConfirmRotate(true),
            },
            {
              key: 'toggle',
              label: enabled ? <Trans>Disable endpoint</Trans> : <Trans>Enable endpoint</Trans>,
              onSelect: () =>
                update.mutate({ webhookId: record.id, status: enabled ? 'disabled' : 'active' }),
            },
            {
              key: 'delete',
              label: <Trans>Delete endpoint…</Trans>,
              tone: 'danger' as const,
              separatorBefore: true,
              onSelect: () => setDeleting(true),
            },
          ]}
        />
      </div>
      {actionError ? <Alert tone="error">{errorMessage(actionError)}</Alert> : null}
      {enabled ? null : (
        <Alert tone="info">
          <Trans>
            This endpoint is disabled. XID records no new deliveries until you enable it.
          </Trans>
        </Alert>
      )}
      <div {...stylex.props(styles.layout)}>
        <Deliveries webhookId={record.id} />
        <WebhookAside
          webhook={record}
          onRotate={() => setConfirmRotate(true)}
          onEditEvents={() => setEditingEvents(true)}
        />
      </div>
      {confirmRotate ? (
        <ConfirmDialog
          title={<Trans>Rotate the signing secret?</Trans>}
          description={
            <Trans>
              The current secret stops working right away. Requests to {host} fail verification
              until you deploy the new secret.
            </Trans>
          }
          confirmLabel={<Trans>Rotate secret</Trans>}
          isLoading={rotate.isPending}
          onConfirm={() =>
            rotate.mutate(record.id, {
              onSuccess: (result) => setSecret(result.signing_secret),
              onSettled: () => setConfirmRotate(false),
            })
          }
          onCancel={() => setConfirmRotate(false)}
        />
      ) : null}
      {secret ? (
        <SigningSecretDialog host={host} secret={secret} rotated onDone={() => setSecret(null)} />
      ) : null}
      {editingEvents ? (
        <EditEventsDialog webhook={record} onClose={() => setEditingEvents(false)} />
      ) : null}
      {deleting ? (
        <ConfirmDialog
          title={<Trans>Delete the {host} endpoint?</Trans>}
          description={<Trans>XID stops sending events to {host} right away.</Trans>}
          confirmLabel={<Trans>Delete endpoint</Trans>}
          isLoading={remove.isPending}
          error={errorMessage(remove.error)}
          onConfirm={() =>
            remove.mutate(record.id, {
              onSuccess: () => {
                notify({ title: t`The ${host} endpoint was deleted` })
                navigate(listPath)
              },
            })
          }
          onCancel={() => setDeleting(false)}
        />
      ) : null}
    </div>
  )
}
