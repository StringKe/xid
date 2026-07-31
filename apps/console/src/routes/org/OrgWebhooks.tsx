// org webhook 端点管理页:端点列表 + 创建(URL + 订阅事件)+ 轮换签名密钥 + 删除。
// 签名密钥只在创建/轮换时一次性展示(参照 OrgScim token 展示模式)。
// 后端无重放/投递状态 endpoint(worker/v1/webhooks.ts 仅 CRUD + rotate-secret),故不提供该入口。
// 调 /v1/webhooks(扁平租户级 Management API)。
// 版式走 ConsolePage 骨架(web-ui):display 页头 + hairline 分节;创建表单 5/7 双列(SplitSection)。

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import type { ColumnDef } from '@tanstack/react-table'
import { Alert, Badge, Button, Field, Input } from '@xid-kit/web-ui/ui'
import {
  ConsolePage,
  ConsolePageNotice,
  ConsolePageSection,
  ConsolePageSplitSection,
} from '@xid-kit/web-ui/ui'
import { DataTable } from '@xid-kit/web-ui/ui/DataTable'
import { Pagination } from '@xid-kit/web-ui/ui/Pagination'
import { consoleShell, page } from '@xid-kit/web-ui/styles/product-surface.stylex'
import { ConfirmDialog } from '@xid-kit/web-ui/ConfirmDialog'
import {
  useCreateWebhook,
  useDeleteWebhook,
  useRotateWebhookSecret,
  useWebhooksQuery,
} from './queries'
import type { WebhookEndpoint } from './types'
import { useOrgTarget } from './useOrgTarget'

const styles = stylex.create({
  eventList: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '0.25rem',
  },
  // 一次性 secret 展示:成功 Alert + mono 代码块
  secretStack: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
  },
})

function EventTypes({ eventTypes }: { eventTypes: string[] }): ReactNode {
  if (eventTypes.length === 0) {
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

function parseEventTypes(raw: string): string[] {
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

export default function OrgWebhooks(): ReactNode {
  const { t } = useLingui()
  const { orgId } = useOrgTarget()

  const [cursor, setCursor] = useState<string | undefined>()
  const { data, isLoading, isError } = useWebhooksQuery(cursor)

  const createWebhook = useCreateWebhook()
  const rotateSecret = useRotateWebhookSecret()
  const deleteWebhook = useDeleteWebhook()

  const [url, setUrl] = useState('')
  const [eventsRaw, setEventsRaw] = useState('')
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<WebhookEndpoint | null>(null)

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
            onClick={() => void handleRotate(row.original.id)}
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

  async function handleCreate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!url.trim()) return
    setRevealedSecret(null)
    const result = await createWebhook.mutateAsync({
      url: url.trim(),
      event_types: parseEventTypes(eventsRaw),
    })
    setRevealedSecret(result.signing_secret)
    setUrl('')
    setEventsRaw('')
  }

  async function handleRotate(webhookId: string): Promise<void> {
    setRevealedSecret(null)
    const result = await rotateSecret.mutateAsync(webhookId)
    setRevealedSecret(result.signing_secret)
  }

  async function confirmDelete(): Promise<void> {
    if (!pendingDelete) return
    await deleteWebhook.mutateAsync(pendingDelete.id)
    setPendingDelete(null)
  }

  if (!orgId) {
    return (
      <ConsolePage title={<Trans>Webhooks</Trans>}>
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
      title={<Trans>Webhooks</Trans>}
      lead={<Trans>Deliver signed event notifications to your HTTPS endpoints.</Trans>}
    >
      {isError || rotateSecret.isError || deleteWebhook.isError ? (
        <ConsolePageNotice>
          {isError ? (
            <Alert tone="error">
              <Trans>Failed to load webhooks.</Trans>
            </Alert>
          ) : null}
          {rotateSecret.isError || deleteWebhook.isError ? (
            <Alert tone="error">
              <Trans>Failed to save changes. Try again.</Trans>
            </Alert>
          ) : null}
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
        {data ? (
          <Pagination
            nextCursor={data.next_cursor}
            loadMoreLabel={<Trans>Load more webhooks</Trans>}
            onLoadMore={setCursor}
          />
        ) : null}
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
        <form onSubmit={(event) => void handleCreate(event)} noValidate>
          <div {...stylex.props(page.gridForm)}>
            <Field
              label={<Trans>Endpoint URL</Trans>}
              error={createWebhook.error ? t`Failed to create webhook. Try again.` : undefined}
              hint={<Trans>Must be an HTTPS URL.</Trans>}
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
              hint={
                <Trans>
                  Comma-separated event names (for example user.created, session.revoked). Leave
                  blank to receive all events.
                </Trans>
              }
            >
              <Input
                value={eventsRaw}
                onChange={(event) => setEventsRaw(event.target.value)}
                placeholder={t`user.created, organization.updated`}
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
          onConfirm={() => void confirmDelete()}
          onCancel={() => setPendingDelete(null)}
        />
      ) : null}
    </ConsolePage>
  )
}
