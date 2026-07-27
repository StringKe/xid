// org OAuth client 管理页:application 列表 + 创建 + 查看 client_id + 轮换 secret + 删除。
// client_secret 只在创建/轮换时一次性展示(参照 OrgScim token 展示模式)。
// 调 /v1/applications(扁平租户级 Management API,需要 sk_* 或具备权限的会话)。

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import type { ColumnDef } from '@tanstack/react-table'
import { Alert, Badge, Button, Field, Input } from '@xid-kit/web-ui/ui'
import type { BadgeTone } from '@xid-kit/web-ui/ui'
import { DataTable } from '@xid-kit/web-ui/ui/DataTable'
import { Pagination } from '@xid-kit/web-ui/ui/Pagination'
import { page } from '@xid-kit/web-ui/styles/product-surface.stylex'
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
  select: {
    width: '100%',
    minHeight: '2.5rem',
    paddingBlock: 0,
    paddingInline: '0.75rem',
    borderRadius: tokens['--xid-radius'],
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: tokens['--xid-border'],
    background: tokens['--xid-bg'],
    color: tokens['--xid-fg'],
    fontFamily: tokens['--xid-font'],
    fontSize: '0.875rem',
  },
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
  clientIdText: {
    fontFamily: tokens['--xid-font-mono'],
    fontSize: '0.8125rem',
    fontVariantNumeric: 'tabular-nums',
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

function ClientTypeBadge({
  clientType,
}: {
  clientType: OAuthApplication['client_type']
}): ReactNode {
  return <Badge tone={CLIENT_TYPE_TONE[clientType] ?? 'neutral'}>{clientType}</Badge>
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
        <div {...stylex.props(styles.actionGroup)}>
          <Button
            variant="secondary"
            isLoading={rotateSecret.isPending && rotateSecret.variables === row.original.id}
            onClick={() => void handleRotate(row.original.id)}
            {...stylex.props(styles.actionBtn)}
          >
            <Trans>Rotate secret</Trans>
          </Button>
          <Button
            variant="danger"
            onClick={() => setPendingDelete(row.original)}
            aria-label={t`Delete application ${row.original.client_id}`}
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
    setRevealedSecret(null)
    const result = await createApplication.mutateAsync({
      client_type: clientType,
      redirect_uris: redirectUri.trim() ? [redirectUri.trim()] : [],
    })
    setRevealedSecret(result.client_secret)
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
          <Trans>OAuth applications</Trans>
        </h1>
      </div>

      {isError ? (
        <div {...stylex.props(styles.messageZone)}>
          <Alert tone="error">
            <Trans>Failed to load applications. Please try again.</Trans>
          </Alert>
        </div>
      ) : (
        <section aria-labelledby="app-list-heading" {...stylex.props(styles.tableSection)}>
          <h2 id="app-list-heading" {...stylex.props(page.visuallyHidden)}>
            <Trans>Application list</Trans>
          </h2>
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
        </section>
      )}

      <section aria-labelledby="app-create-heading" {...stylex.props(styles.createSection)}>
        <div {...stylex.props(styles.sectionMeta)}>
          <h2 id="app-create-heading" {...stylex.props(page.sectionLabel)}>
            <Trans>Register application</Trans>
          </h2>
          <p {...stylex.props(styles.sectionDesc)}>
            <Trans>
              Create an OAuth 2.0 client. The client secret is shown once on creation — store it
              immediately.
            </Trans>
          </p>
        </div>
        <div {...stylex.props(styles.controlCol)}>
          <form onSubmit={(event) => void handleCreate(event)} noValidate>
            <div {...stylex.props(styles.formRow)}>
              <div {...stylex.props(styles.formFieldGrow)}>
                <Field
                  label={<Trans>Redirect URI</Trans>}
                  error={createApplication.error?.message ?? undefined}
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
                  <select
                    value={clientType}
                    onChange={(event) =>
                      setClientType(event.target.value as OAuthApplication['client_type'])
                    }
                    aria-label={t`Select client type`}
                    {...stylex.props(styles.select)}
                  >
                    <option value="confidential">{t`confidential`}</option>
                    <option value="public">{t`public`}</option>
                  </select>
                </Field>
              </div>
              <Button type="submit" isLoading={createApplication.isPending}>
                <Trans>Create application</Trans>
              </Button>
            </div>
          </form>
          {rotateSecret.error ? <Alert tone="error">{rotateSecret.error.message}</Alert> : null}
          {deleteApplication.error ? (
            <Alert tone="error">{deleteApplication.error.message}</Alert>
          ) : null}
          {revealedSecret ? (
            <div {...stylex.props(styles.secretReveal)}>
              <Alert tone="success">
                <Trans>Client secret generated. Store it now; it will not be shown again.</Trans>
              </Alert>
              <code {...stylex.props(styles.secretCode)}>{revealedSecret}</code>
            </div>
          ) : null}
        </div>
      </section>

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
    </div>
  )
}
