// org API key 管理页:key 列表(名称/前缀/环境/创建/最后使用)+ 创建(一次性展示完整 key)+ 撤销。
// 完整 key 明文只在创建时一次性返回(参照 OrgScim token 展示模式)。
// 调 /v1/api-keys(扁平租户级 Management API)。

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import type { ColumnDef } from '@tanstack/react-table'
import { Alert, Badge, Button, Field, Input } from '../../components/ui'
import type { BadgeTone } from '../../components/ui'
import { DataTable } from '../../components/ui/DataTable'
import { Pagination } from '../../components/ui/Pagination'
import { page } from '../../styles/product-surface.stylex'
import { tokens } from '../../styles/tokens.stylex'
import { ConfirmDialog } from '../account/ConfirmDialog'
import { useApiKeysQuery, useCreateApiKey, useRevokeApiKey } from './queries'
import type { ApiKey } from './types'
import { useOrgTarget } from './useOrgTarget'

const ENV_TONE: Record<string, BadgeTone> = {
  live: 'success',
  test: 'warning',
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
    flex: '1 1 200px',
    minWidth: 0,
  },
  formFieldFixed: {
    flex: '0 0 160px',
  },
  keyReveal: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
  },
  keyCode: {
    fontFamily: tokens['--xid-font-mono'],
    fontSize: '0.75rem',
    background: tokens['--xid-muted'],
    paddingBlock: '0.375rem',
    paddingInline: '0.5rem',
    borderRadius: tokens['--xid-radius-sm'],
    wordBreak: 'break-all',
  },
  prefixText: {
    fontFamily: tokens['--xid-font-mono'],
    fontSize: '0.8125rem',
    fontVariantNumeric: 'tabular-nums',
  },
  timeText: {
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
    fontSize: '0.8125rem',
  },
  mutedText: {
    color: tokens['--xid-muted-foreground'],
  },
  actionBtn: {
    minHeight: '1.75rem',
    paddingBlock: 0,
    paddingInline: '0.625rem',
    fontSize: '0.75rem',
  },
})

function EnvBadge({ environment }: { environment: string }): ReactNode {
  return <Badge tone={ENV_TONE[environment] ?? 'neutral'}>{environment}</Badge>
}

function LastUsed({ lastUsedAt }: { lastUsedAt: string | null }): ReactNode {
  if (lastUsedAt) {
    return <span {...stylex.props(styles.timeText)}>{new Date(lastUsedAt).toLocaleString()}</span>
  }
  return (
    <span {...stylex.props(styles.mutedText)}>
      <Trans>Never</Trans>
    </span>
  )
}

export default function OrgApiKeys(): ReactNode {
  const { t } = useLingui()
  const { orgId } = useOrgTarget()

  const [cursor, setCursor] = useState<string | undefined>()
  const { data, isLoading, isError } = useApiKeysQuery(cursor)

  const createApiKey = useCreateApiKey()
  const revokeApiKey = useRevokeApiKey()

  const [name, setName] = useState('')
  const [environment, setEnvironment] = useState<'live' | 'test'>('live')
  const [revealedKey, setRevealedKey] = useState<string | null>(null)
  const [pendingRevoke, setPendingRevoke] = useState<ApiKey | null>(null)

  const columns: ColumnDef<ApiKey>[] = [
    {
      id: 'name',
      header: () => <Trans>Name</Trans>,
      cell: ({ row }) => row.original.name,
    },
    {
      id: 'prefix',
      header: () => <Trans>Prefix</Trans>,
      cell: ({ row }) => (
        <span {...stylex.props(styles.prefixText)}>{row.original.key_prefix}</span>
      ),
      meta: { width: '180px' },
    },
    {
      id: 'environment',
      header: () => <Trans>Environment</Trans>,
      cell: ({ row }) => <EnvBadge environment={row.original.environment} />,
      meta: { width: '120px' },
    },
    {
      id: 'created',
      header: () => <Trans>Created</Trans>,
      cell: ({ row }) => (
        <span {...stylex.props(styles.timeText)}>
          {new Date(row.original.created_at).toLocaleDateString()}
        </span>
      ),
      meta: { width: '120px' },
    },
    {
      id: 'lastUsed',
      header: () => <Trans>Last used</Trans>,
      cell: ({ row }) => <LastUsed lastUsedAt={row.original.last_used_at} />,
      meta: { width: '160px' },
    },
    {
      id: 'actions',
      header: () => <Trans>Actions</Trans>,
      cell: ({ row }) => (
        <Button
          variant="danger"
          isLoading={revokeApiKey.isPending && revokeApiKey.variables === row.original.id}
          onClick={() => setPendingRevoke(row.original)}
          aria-label={t`Revoke API key ${row.original.name}`}
          {...stylex.props(styles.actionBtn)}
        >
          <Trans>Revoke</Trans>
        </Button>
      ),
      meta: { width: '120px' },
    },
  ]

  async function handleCreate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!name.trim()) return
    setRevealedKey(null)
    const result = await createApiKey.mutateAsync({
      name: name.trim(),
      environment,
      scopes: ['*'],
    })
    setRevealedKey(result.key)
    setName('')
  }

  async function confirmRevoke(): Promise<void> {
    if (!pendingRevoke) return
    await revokeApiKey.mutateAsync(pendingRevoke.id)
    setPendingRevoke(null)
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
          <Trans>API keys</Trans>
        </h1>
      </div>

      {isError ? (
        <div {...stylex.props(styles.messageZone)}>
          <Alert tone="error">
            <Trans>Failed to load API keys. Please try again.</Trans>
          </Alert>
        </div>
      ) : (
        <section aria-labelledby="apikey-list-heading" {...stylex.props(styles.tableSection)}>
          <h2 id="apikey-list-heading" {...stylex.props(page.visuallyHidden)}>
            <Trans>API key list</Trans>
          </h2>
          <DataTable
            columns={columns}
            data={data?.data ?? []}
            getRowId={(row) => row.id}
            isLoading={isLoading}
            emptyMessage={<Trans>No active API keys.</Trans>}
          />
          {data ? (
            <Pagination
              nextCursor={data.next_cursor}
              loadMoreLabel={<Trans>Load more keys</Trans>}
              onLoadMore={setCursor}
            />
          ) : null}
        </section>
      )}

      <section aria-labelledby="apikey-create-heading" {...stylex.props(styles.createSection)}>
        <div {...stylex.props(styles.sectionMeta)}>
          <h2 id="apikey-create-heading" {...stylex.props(page.sectionLabel)}>
            <Trans>Create API key</Trans>
          </h2>
          <p {...stylex.props(styles.sectionDesc)}>
            <Trans>
              The full key is shown once at creation. Live keys have full access; test keys are
              sandbox-only.
            </Trans>
          </p>
        </div>
        <div {...stylex.props(styles.controlCol)}>
          <form onSubmit={(event) => void handleCreate(event)} noValidate>
            <div {...stylex.props(styles.formRow)}>
              <div {...stylex.props(styles.formFieldGrow)}>
                <Field
                  label={<Trans>Key name</Trans>}
                  error={createApiKey.error?.message ?? undefined}
                  required
                >
                  <Input
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder={t`Production backend`}
                    required
                  />
                </Field>
              </div>
              <div {...stylex.props(styles.formFieldFixed)}>
                <Field label={<Trans>Environment</Trans>}>
                  <select
                    value={environment}
                    onChange={(event) => setEnvironment(event.target.value as 'live' | 'test')}
                    aria-label={t`Select key environment`}
                    {...stylex.props(styles.select)}
                  >
                    <option value="live">{t`live`}</option>
                    <option value="test">{t`test`}</option>
                  </select>
                </Field>
              </div>
              <Button type="submit" isLoading={createApiKey.isPending}>
                <Trans>Create key</Trans>
              </Button>
            </div>
          </form>
          {revokeApiKey.error ? <Alert tone="error">{revokeApiKey.error.message}</Alert> : null}
          {revealedKey ? (
            <div {...stylex.props(styles.keyReveal)}>
              <Alert tone="success">
                <Trans>API key created. Store it now; it will not be shown again.</Trans>
              </Alert>
              <code {...stylex.props(styles.keyCode)}>{revealedKey}</code>
            </div>
          ) : null}
        </div>
      </section>

      {pendingRevoke ? (
        <ConfirmDialog
          title={<Trans>Revoke API key?</Trans>}
          description={
            <Trans>
              The key {pendingRevoke.name} ({pendingRevoke.key_prefix}) will stop working
              immediately and cannot be restored.
            </Trans>
          }
          confirmLabel={<Trans>Revoke</Trans>}
          isLoading={revokeApiKey.isPending}
          onConfirm={() => void confirmRevoke()}
          onCancel={() => setPendingRevoke(null)}
        />
      ) : null}
    </div>
  )
}
