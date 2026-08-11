// 完整 key 明文只在创建时一次性返回。

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
import { useApiKeysQuery, useCreateApiKey, useRevokeApiKey } from './queries'
import type { ApiKey } from './types'
import { useOrgTarget } from './useOrgTarget'

const ENV_TONE: Record<string, BadgeTone> = {
  live: 'success',
  test: 'warning',
}

const styles = stylex.create({
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
  keyStack: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
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
          {...stylex.props(consoleShell.actionButton)}
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
      <ConsolePage title={<Trans>API keys</Trans>}>
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
      title={<Trans>API keys</Trans>}
      lead={<Trans>Create and revoke API keys for server-side integrations.</Trans>}
    >
      {isError || revokeApiKey.isError ? (
        <ConsolePageNotice>
          {isError ? (
            <Alert tone="error">
              <Trans>Failed to load API keys.</Trans>
            </Alert>
          ) : null}
          {revokeApiKey.isError ? (
            <Alert tone="error">
              <Trans>Failed to revoke API key. Try again.</Trans>
            </Alert>
          ) : null}
        </ConsolePageNotice>
      ) : null}

      <ConsolePageSection title={<Trans>Active keys</Trans>}>
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
      </ConsolePageSection>

      <ConsolePageSplitSection
        title={<Trans>Create API key</Trans>}
        description={
          <Trans>
            The full key is shown once at creation. Live keys have full access; test keys are
            sandbox-only.
          </Trans>
        }
      >
        <form onSubmit={(event) => void handleCreate(event)} noValidate>
          <div {...stylex.props(styles.formRow)}>
            <div {...stylex.props(styles.formFieldGrow)}>
              <Field
                label={<Trans>Key name</Trans>}
                error={createApiKey.error ? t`Failed to create API key. Try again.` : undefined}
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
                <Select
                  value={environment}
                  onChange={(event) => setEnvironment(event.target.value as 'live' | 'test')}
                  aria-label={t`Select key environment`}
                >
                  <option value="live">{t`live`}</option>
                  <option value="test">{t`test`}</option>
                </Select>
              </Field>
            </div>
            <Button type="submit" isLoading={createApiKey.isPending}>
              <Trans>Create key</Trans>
            </Button>
          </div>
        </form>
        {revealedKey ? (
          <div {...stylex.props(styles.keyStack)}>
            <Alert tone="success">
              <Trans>API key created. Store it now; it will not be shown again.</Trans>
            </Alert>
            <code {...stylex.props(consoleShell.codeBlock)}>{revealedKey}</code>
          </div>
        ) : null}
      </ConsolePageSplitSection>

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
    </ConsolePage>
  )
}
