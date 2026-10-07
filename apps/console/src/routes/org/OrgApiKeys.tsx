// 完整 key 明文只在创建时一次性返回。

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { FormattedDate } from '../../components/FormattedDate'
import type { DataTableColumnDef as ColumnDef } from '@xid-kit/web-ui/ui/DataTable'
import { API_KEY_SCOPE_RESOURCES, type ApiKeyEnvironment } from '@xid-kit/types'
import { Alert, Badge, Button, Checkbox, Field, Input, Select } from '@xid-kit/web-ui/ui'
import type { BadgeTone } from '@xid-kit/web-ui/ui'
import {
  ConsolePage,
  ConsolePageNotice,
  ConsolePageSection,
  ConsolePageSplitSection,
} from '@xid-kit/web-ui/ui'
import { DataTable } from '@xid-kit/web-ui/ui/DataTable'
import { LoadMore } from '@xid-kit/web-ui/ui/LoadMore'
import { consoleShell, page } from '@xid-kit/web-ui/styles/product-surface.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { ConfirmDialog } from '@xid-kit/web-ui/ConfirmDialog'
import { errorTargetsField, useManagementErrorMessage } from '@xid-kit/web-ui/api-error-message'
import { ChoiceList } from './ChoiceList'
import { useApiKeysQuery, useCreateApiKey, useRevokeApiKey } from './queries'
import { TenantScopeGate } from './TenantScopeGate'
import type { ApiKey } from './types'

const ENV_TONE: Record<string, BadgeTone> = {
  live: 'success',
  test: 'warning',
}

const SCOPE_OPTIONS = API_KEY_SCOPE_RESOURCES.flatMap((resource) => [
  `${resource}:read`,
  `${resource}:write`,
])

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
    flex: '0 0 180px',
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
  scopeStack: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
  },
  checkRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    fontSize: '0.875rem',
  },
})

function EnvBadge({ environment }: { environment: string }): ReactNode {
  return <Badge tone={ENV_TONE[environment] ?? 'neutral'}>{environment}</Badge>
}

function LastUsed({ lastUsedAt }: { lastUsedAt: string | null }): ReactNode {
  if (lastUsedAt) {
    return (
      <span {...stylex.props(styles.timeText)}>
        <FormattedDate value={lastUsedAt} time />
      </span>
    )
  }
  return (
    <span {...stylex.props(styles.mutedText)}>
      <Trans>Never</Trans>
    </span>
  )
}

function Scopes({ scopes }: { scopes: string[] }): ReactNode {
  if (scopes.includes('*')) {
    return (
      <Badge tone="warning">
        <Trans>Full access</Trans>
      </Badge>
    )
  }
  return <span {...stylex.props(styles.prefixText)}>{scopes.join(', ')}</span>
}

// 日期输入按本地时区取当天结束时刻,服务端只接受未来时间。
function endOfLocalDay(date: string): string | undefined {
  if (!date) return undefined
  return new Date(`${date}T23:59:59.999`).toISOString()
}

export default function OrgApiKeys(): ReactNode {
  return (
    <TenantScopeGate title={<Trans>API keys</Trans>}>
      <ApiKeysPage />
    </TenantScopeGate>
  )
}

function ApiKeysPage(): ReactNode {
  const { t } = useLingui()
  const errorMessage = useManagementErrorMessage()
  const apiKeys = useApiKeysQuery()
  const { data, isLoading, error } = apiKeys

  const createApiKey = useCreateApiKey()
  const revokeApiKey = useRevokeApiKey()

  const [name, setName] = useState('')
  const [environment, setEnvironment] = useState<ApiKeyEnvironment>('live')
  const [scopes, setScopes] = useState<string[]>([])
  const [fullAccess, setFullAccess] = useState(false)
  const [expiresOn, setExpiresOn] = useState('')
  const [scopesMissing, setScopesMissing] = useState(false)
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
      header: () => <Trans>Label</Trans>,
      cell: ({ row }) => <EnvBadge environment={row.original.environment} />,
      meta: { width: '100px' },
    },
    {
      id: 'scopes',
      header: () => <Trans>Scopes</Trans>,
      cell: ({ row }) => <Scopes scopes={row.original.scopes} />,
    },
    {
      id: 'expires',
      header: () => <Trans>Expires</Trans>,
      cell: ({ row }) =>
        row.original.expires_at ? (
          <span {...stylex.props(styles.timeText)}>
            <FormattedDate value={row.original.expires_at} />
          </span>
        ) : (
          <span {...stylex.props(styles.mutedText)}>
            <Trans>Never</Trans>
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

  function handleCreate(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (!name.trim()) return
    const requestedScopes = fullAccess ? ['*'] : scopes
    setScopesMissing(requestedScopes.length === 0)
    if (requestedScopes.length === 0) return
    setRevealedKey(null)
    const expiresAt = endOfLocalDay(expiresOn)
    createApiKey.mutate(
      {
        name: name.trim(),
        environment,
        scopes: requestedScopes,
        ...(expiresAt ? { expires_at: expiresAt } : {}),
      },
      {
        onSuccess: (result) => {
          setRevealedKey(result.key)
          setName('')
          setScopes([])
          setFullAccess(false)
          setExpiresOn('')
        },
      },
    )
  }

  function confirmRevoke(): void {
    if (!pendingRevoke) return
    revokeApiKey.mutate(pendingRevoke.id, { onSettled: () => setPendingRevoke(null) })
  }

  const fieldError = (field: string): string | undefined =>
    errorTargetsField(createApiKey.error, field) ? errorMessage(createApiKey.error) : undefined
  const formError =
    createApiKey.error &&
    !['scopes', 'expires_at', 'environment'].some((field) =>
      errorTargetsField(createApiKey.error, field),
    )
      ? errorMessage(createApiKey.error)
      : undefined

  return (
    <ConsolePage
      wide
      title={<Trans>API keys</Trans>}
      lead={
        <Trans>
          Create and revoke API keys for server-side integrations. API keys are shared by every
          organization in the tenant.
        </Trans>
      }
    >
      {error || revokeApiKey.error ? (
        <ConsolePageNotice>
          {error ? <Alert tone="error">{errorMessage(error)}</Alert> : null}
          {revokeApiKey.error ? (
            <Alert tone="error">{errorMessage(revokeApiKey.error)}</Alert>
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
        <LoadMore query={apiKeys} loadMoreLabel={<Trans>Load more keys</Trans>} />
      </ConsolePageSection>

      <ConsolePageSplitSection
        title={<Trans>Create API key</Trans>}
        description={
          <Trans>
            The full key is shown once at creation. Live and test keys have the same permissions;
            the label only marks the intended use. Grant only the scopes the integration needs.
          </Trans>
        }
      >
        <form onSubmit={handleCreate} noValidate>
          <div {...stylex.props(page.gridForm)}>
            <div {...stylex.props(styles.formRow)}>
              <div {...stylex.props(styles.formFieldGrow)}>
                <Field label={<Trans>Key name</Trans>} error={formError} required>
                  <Input
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder={t`Production backend`}
                    required
                  />
                </Field>
              </div>
              <div {...stylex.props(styles.formFieldFixed)}>
                <Field label={<Trans>Label</Trans>} error={fieldError('environment')}>
                  <Select
                    value={environment}
                    onChange={(event) => setEnvironment(event.target.value as ApiKeyEnvironment)}
                    aria-label={t`Select key label`}
                  >
                    <option value="live">{t`live`}</option>
                    <option value="test">{t`test`}</option>
                  </Select>
                </Field>
              </div>
              <div {...stylex.props(styles.formFieldFixed)}>
                <Field
                  label={<Trans>Expires on</Trans>}
                  hint={<Trans>Optional</Trans>}
                  error={fieldError('expires_at')}
                >
                  <Input
                    type="date"
                    value={expiresOn}
                    onChange={(event) => setExpiresOn(event.target.value)}
                  />
                </Field>
              </div>
            </div>
            <Field
              label={<Trans>Scopes</Trans>}
              error={scopesMissing ? t`Select at least one scope.` : fieldError('scopes')}
              required
            >
              <div {...stylex.props(styles.scopeStack)}>
                <label {...stylex.props(styles.checkRow)}>
                  <Checkbox
                    checked={fullAccess}
                    onChange={(event) => setFullAccess(event.target.checked)}
                  />
                  <span>
                    <Trans>Full access to every resource in the tenant</Trans>
                  </span>
                </label>
                {fullAccess ? null : (
                  <ChoiceList
                    options={SCOPE_OPTIONS}
                    selected={scopes}
                    onChange={setScopes}
                    label={t`Scopes`}
                  />
                )}
              </div>
            </Field>
            <div>
              <Button type="submit" isLoading={createApiKey.isPending}>
                <Trans>Create key</Trans>
              </Button>
            </div>
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
          onConfirm={confirmRevoke}
          onCancel={() => setPendingRevoke(null)}
        />
      ) : null}
    </ConsolePage>
  )
}
