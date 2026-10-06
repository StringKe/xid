// 后端无重放/投递状态 API,UI 不提供该入口;签名密钥只在创建/轮换时一次性展示。

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import type { DataTableColumnDef as ColumnDef } from '@xid-kit/web-ui/ui/DataTable'
import { WEBHOOK_EVENT_TYPES } from '@xid-kit/types'
import { Alert, Badge, Button, Field, Input } from '@xid-kit/web-ui/ui'
import {
  ConsolePage,
  ConsolePageNotice,
  ConsolePageSection,
  ConsolePageSplitSection,
} from '@xid-kit/web-ui/ui'
import { DataTable } from '@xid-kit/web-ui/ui/DataTable'
import { LoadMore } from '@xid-kit/web-ui/ui/LoadMore'
import { consoleShell, page } from '@xid-kit/web-ui/styles/product-surface.stylex'
import { ConfirmDialog } from '@xid-kit/web-ui/ConfirmDialog'
import { errorTargetsField, useManagementErrorMessage } from '@xid-kit/web-ui/api-error-message'
import { ChoiceList } from './ChoiceList'
import {
  useCreateWebhook,
  useDeleteWebhook,
  useRotateWebhookSecret,
  useWebhooksQuery,
} from './queries'
import { TenantScopeGate } from './TenantScopeGate'
import type { WebhookEndpoint } from './types'

const styles = stylex.create({
  eventList: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '0.25rem',
  },
  secretStack: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
  },
})

function EventTypes({ eventTypes }: { eventTypes: string[] }): ReactNode {
  if (eventTypes.length === 0 || eventTypes.includes('*')) {
    return (
      <Badge tone="neutral">
        <Trans>all events</Trans>
      </Badge>
    )
  }
  return (
    <div {...stylex.props(styles.eventList)}>
      {eventTypes.map((event) => (
        <Badge key={event} tone="info">
          {event}
        </Badge>
      ))}
    </div>
  )
}

export default function OrgWebhooks(): ReactNode {
  return (
    <TenantScopeGate title={<Trans>Webhooks</Trans>}>
      <WebhooksPage />
    </TenantScopeGate>
  )
}

function WebhooksPage(): ReactNode {
  const { t } = useLingui()
  const errorMessage = useManagementErrorMessage()
  const webhooks = useWebhooksQuery()
  const { data, isLoading, error } = webhooks

  const createWebhook = useCreateWebhook()
  const rotateSecret = useRotateWebhookSecret()
  const deleteWebhook = useDeleteWebhook()

  const [url, setUrl] = useState('')
  const [eventTypes, setEventTypes] = useState<string[]>([])
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<WebhookEndpoint | null>(null)
  const actionError = rotateSecret.error ?? deleteWebhook.error

  const columns: ColumnDef<WebhookEndpoint>[] = [
    {
      id: 'url',
      header: () => <Trans>Endpoint URL</Trans>,
      cell: ({ row }) => <span {...stylex.props(consoleShell.mono)}>{row.original.url}</span>,
    },
    {
      id: 'events',
      header: () => <Trans>Subscribed events</Trans>,
      cell: ({ row }) => <EventTypes eventTypes={row.original.event_types} />,
      meta: { width: '260px' },
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
            isLoading={rotateSecret.isPending && rotateSecret.variables === row.original.id}
            onClick={() => handleRotate(row.original.id)}
            aria-label={t`Rotate signing secret for ${row.original.url}`}
            {...stylex.props(consoleShell.actionButton)}
          >
            <Trans>Rotate secret</Trans>
          </Button>
          <Button
            variant="danger"
            onClick={() => setPendingDelete(row.original)}
            aria-label={t`Delete webhook ${row.original.url}`}
            {...stylex.props(consoleShell.actionButton)}
          >
            <Trans>Delete</Trans>
          </Button>
        </div>
      ),
      meta: { width: '220px' },
    },
  ]

  function handleCreate(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (!url.trim()) return
    setRevealedSecret(null)
    createWebhook.mutate(
      { url: url.trim(), event_types: eventTypes },
      {
        onSuccess: (result) => {
          setRevealedSecret(result.signing_secret)
          setUrl('')
          setEventTypes([])
        },
      },
    )
  }

  function handleRotate(webhookId: string): void {
    setRevealedSecret(null)
    rotateSecret.mutate(webhookId, {
      onSuccess: (result) => setRevealedSecret(result.signing_secret),
    })
  }

  function confirmDelete(): void {
    if (!pendingDelete) return
    deleteWebhook.mutate(pendingDelete.id, { onSettled: () => setPendingDelete(null) })
  }

  return (
    <ConsolePage
      wide
      title={<Trans>Webhooks</Trans>}
      lead={
        <Trans>
          Deliver signed event notifications to your HTTPS endpoints. Webhooks are shared by every
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

      <ConsolePageSection title={<Trans>Endpoints</Trans>}>
        <DataTable
          columns={columns}
          data={data?.data ?? []}
          getRowId={(row) => row.id}
          isLoading={isLoading}
          emptyMessage={<Trans>No webhook endpoints configured.</Trans>}
        />
        <LoadMore query={webhooks} loadMoreLabel={<Trans>Load more webhooks</Trans>} />
      </ConsolePageSection>

      <ConsolePageSplitSection
        title={<Trans>Add endpoint</Trans>}
        description={
          <Trans>
            Deliveries are signed with HMAC-SHA256. The signing secret is shown once on creation;
            store it immediately.
          </Trans>
        }
      >
        <form onSubmit={handleCreate} noValidate>
          <div {...stylex.props(page.gridForm)}>
            <Field
              label={<Trans>Endpoint URL</Trans>}
              error={
                createWebhook.error && !errorTargetsField(createWebhook.error, 'event_types')
                  ? errorMessage(createWebhook.error)
                  : undefined
              }
              hint={<Trans>Must be a public HTTPS URL.</Trans>}
              required
            >
              <Input
                type="url"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder={t`https://example.com/webhooks/xid`}
                required
              />
            </Field>
            <Field
              label={<Trans>Subscribed events</Trans>}
              error={
                errorTargetsField(createWebhook.error, 'event_types')
                  ? errorMessage(createWebhook.error)
                  : undefined
              }
              hint={
                <Trans>
                  Select the events to deliver. Leave all unchecked to receive every event.
                </Trans>
              }
            >
              <ChoiceList
                options={WEBHOOK_EVENT_TYPES}
                selected={eventTypes}
                onChange={setEventTypes}
                label={t`Subscribed events`}
              />
            </Field>
            <Button type="submit" isLoading={createWebhook.isPending}>
              <Trans>Create webhook</Trans>
            </Button>
          </div>
        </form>
        {revealedSecret ? (
          <div {...stylex.props(styles.secretStack)}>
            <Alert tone="success">
              <Trans>Signing secret generated. Store it now; it will not be shown again.</Trans>
            </Alert>
            <code {...stylex.props(consoleShell.codeBlock)}>{revealedSecret}</code>
          </div>
        ) : null}
      </ConsolePageSplitSection>

      {pendingDelete ? (
        <ConfirmDialog
          title={<Trans>Delete webhook?</Trans>}
          description={
            <Trans>
              The endpoint {pendingDelete.url} will stop receiving event deliveries immediately.
            </Trans>
          }
          confirmLabel={<Trans>Delete</Trans>}
          isLoading={deleteWebhook.isPending}
          onConfirm={confirmDelete}
          onCancel={() => setPendingDelete(null)}
        />
      ) : null}
    </ConsolePage>
  )
}
