// org webhook 端点管理页:端点列表 + 创建(URL + 订阅事件)+ 查看签名密钥 + 删除。
// 签名密钥只在创建/轮换时一次性展示(参照 OrgScim token 展示模式)。
// 后端无重放/投递状态 endpoint(worker/v1/webhooks.ts 仅 CRUD + rotate-secret),故不提供该入口。
// 调 /v1/webhooks(扁平租户级 Management API)。

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import type { ColumnDef } from '@tanstack/react-table'
import { Alert, Badge, Button, Field, Input } from '@xid-kit/web-ui/ui'
import { DataTable } from '@xid-kit/web-ui/ui/DataTable'
import { Pagination } from '@xid-kit/web-ui/ui/Pagination'
import { page } from '@xid-kit/web-ui/styles/product-surface.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { ConfirmDialog } from '@xid-kit/web-ui/ConfirmDialog'
import {
  useCreateWebhook,
  useDeleteWebhook,
  useRotateWebhookSecret,
  useWebhooksQuery,
} from './queries'
import type { WebhookEndpoint } from './types'
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
  urlText: {
    fontFamily: tokens['--xid-font-mono'],
    fontSize: '0.8125rem',
    wordBreak: 'break-all',
  },
  eventList: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '0.25rem',
  },
  secretReveal: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
  },
  secretCode: {
    fontFamily: tokens['--xid-font-mono'],
    fontSize: '0.75rem',
    background: tokens['--xid-muted'],
    paddingBlock: '0.375rem',
    paddingInline: '0.5rem',
    borderRadius: tokens['--xid-radius-sm'],
    wordBreak: 'break-all',
  },
  actionBtn: {
    minHeight: '1.75rem',
    paddingBlock: 0,
    paddingInline: '0.625rem',
    fontSize: '0.75rem',
  },
  actionGroup: {
    display: 'flex',
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
      cell: ({ row }) => <span {...stylex.props(styles.urlText)}>{row.original.url}</span>,
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
        <div {...stylex.props(styles.actionGroup)}>
          <Button
            variant="secondary"
            isLoading={rotateSecret.isPending && rotateSecret.variables === row.original.id}
            onClick={() => void handleRotate(row.original.id)}
            {...stylex.props(styles.actionBtn)}
          >
            <Trans>Reveal secret</Trans>
          </Button>
          <Button
            variant="danger"
            onClick={() => setPendingDelete(row.original)}
            aria-label={t`Delete webhook ${row.original.url}`}
            {...stylex.props(styles.actionBtn)}
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
          <Trans>Webhooks</Trans>
        </h1>
      </div>

      {isError ? (
        <div {...stylex.props(styles.messageZone)}>
          <Alert tone="error">
            <Trans>Failed to load webhooks. Please try again.</Trans>
          </Alert>
        </div>
      ) : (
        <section aria-labelledby="webhook-list-heading" {...stylex.props(styles.tableSection)}>
          <h2 id="webhook-list-heading" {...stylex.props(page.visuallyHidden)}>
            <Trans>Webhook endpoint list</Trans>
          </h2>
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
        </section>
      )}

      <section aria-labelledby="webhook-create-heading" {...stylex.props(styles.createSection)}>
        <div {...stylex.props(styles.sectionMeta)}>
          <h2 id="webhook-create-heading" {...stylex.props(page.sectionLabel)}>
            <Trans>Add endpoint</Trans>
          </h2>
          <p {...stylex.props(styles.sectionDesc)}>
            <Trans>
              Deliveries are signed with HMAC-SHA256. The signing secret is shown once on creation —
              store it immediately.
            </Trans>
          </p>
        </div>
        <div {...stylex.props(styles.controlCol)}>
          <form onSubmit={(event) => void handleCreate(event)} noValidate>
            <div {...stylex.props(page.gridForm)}>
              <Field
                label={<Trans>Endpoint URL</Trans>}
                error={createWebhook.error?.message ?? undefined}
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
          {rotateSecret.error ? <Alert tone="error">{rotateSecret.error.message}</Alert> : null}
          {deleteWebhook.error ? <Alert tone="error">{deleteWebhook.error.message}</Alert> : null}
          {revealedSecret ? (
            <div {...stylex.props(styles.secretReveal)}>
              <Alert tone="success">
                <Trans>Signing secret generated. Store it now; it will not be shown again.</Trans>
              </Alert>
              <code {...stylex.props(styles.secretCode)}>{revealedSecret}</code>
            </div>
          ) : null}
        </div>
      </section>

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
    </div>
  )
}
