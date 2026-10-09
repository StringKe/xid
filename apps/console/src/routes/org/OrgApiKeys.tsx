// 完整 key 明文只在创建时一次性返回;创建对话框按调用者可授予的 scope 置灰。

import type { MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { API_KEY_SCOPE_RESOURCES, type ApiKeyScopeResource } from '@xid-kit/types'
import { errorTargetsField, useManagementErrorMessage } from '@xid-kit/web-ui/api-error-message'
import { ConfirmDialog } from '@xid-kit/web-ui/ConfirmDialog'
import { organizationDisplayName } from '@xid-kit/web-ui/display-names'
import { useAuth } from '@xid-kit/web-ui/session'
import { leading, text, weight } from '@xid-kit/web-ui/styles/scale.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import {
  Alert,
  Badge,
  Button,
  Dialog,
  Dropdown,
  EmptyState,
  Field,
  Icon,
  IdentityCell,
  Input,
  OneTimeSecret,
  Select,
} from '@xid-kit/web-ui/ui'
import type { BadgeTone } from '@xid-kit/web-ui/ui'
import { DataTable } from '@xid-kit/web-ui/ui/DataTable'
import { LoadMore } from '@xid-kit/web-ui/ui/LoadMore'
import type { DataTableColumnDef } from '@xid-kit/web-ui/ui/DataTable'
import { DOCS_URL } from '../../components/layout/ConsoleTopBar'
import { PageFrame } from '../../components/page/PageFrame'
import { list } from '../../components/page/list-styles'
import { formatDate } from '../../lib/date-format'
import { formatRelative } from '../users/user-format'
import type { ActorRef, ApiKeyRow, GrantableScopes } from './integration-queries'
import { useApiKeyRowsQuery, useGrantableScopesQuery } from './integration-queries'
import { useCreateApiKey, useRevokeApiKey } from './queries'
import { TenantScopeGate } from './TenantScopeGate'
import type { CreatedApiKey } from './types'

const DAY_MS = 24 * 60 * 60 * 1000
const EXPIRING_WINDOW_MS = 30 * DAY_MS

type KeyState = 'active' | 'expiring' | 'expired'
type StatusFilter = KeyState | null
type Access = 'none' | 'read' | 'write'
type Expiry = '30' | '90' | '365' | 'never'

const RESOURCE_LABELS: Record<ApiKeyScopeResource, MessageDescriptor> = {
  'access-requests': msg`Access requests`,
  api_keys: msg`API keys`,
  applications: msg`Applications`,
  audit_events: msg`Audit log`,
  branding: msg`Branding`,
  connections: msg`Enterprise SSO and provisioning`,
  custom_hostnames: msg`Custom domains`,
  directories: msg`Directory sync`,
  invitations: msg`Invitations`,
  memberships: msg`Memberships`,
  organization_domains: msg`Organization domains`,
  organizations: msg`Organizations`,
  'org-units': msg`Organization units`,
  permissions: msg`Permissions`,
  projects: msg`Projects`,
  project_grants: msg`Project grants`,
  role_permissions: msg`Role permissions`,
  roles: msg`Roles`,
  sessions: msg`Sessions`,
  manager_assignments: msg`Manager assignments`,
  user_grants: msg`User grants`,
  users: msg`Users`,
  webhooks: msg`Webhooks`,
}

const FIRST_KEY_EXAMPLES: readonly { scope: string; purpose: MessageDescriptor }[] = [
  { scope: 'users:write', purpose: msg`Create users from your HR import` },
  { scope: 'organizations:read', purpose: msg`List organizations and their members` },
  { scope: 'audit_events:read', purpose: msg`Copy the audit log into your SIEM` },
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
    gridTemplateColumns: { default: '1fr', '@media (min-width: 48rem)': '13.5rem minmax(0, 1fr)' },
    gap: '0.125rem 1rem',
    paddingBlock: '0.625rem',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
    fontSize: text.sm,
  },
  code: {
    fontFamily: tokens['--xid-font-mono'],
    fontSize: text.sm,
    color: tokens['--xid-fg'],
    overflowWrap: 'anywhere',
  },
  emptyActions: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '0.5rem 1rem',
    paddingTop: '0.5rem',
  },
  link: {
    color: tokens['--xid-accent'],
    fontSize: text.sm,
    textDecoration: 'none',
  },
  form: { display: 'flex', flexDirection: 'column', gap: '1.25rem' },
  nameRow: {
    display: 'grid',
    gridTemplateColumns: { default: '1fr', '@media (min-width: 48rem)': 'minmax(0, 1fr) 12.5rem' },
    gap: '1rem 0.75rem',
  },
  scopeHead: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    gap: '0.75rem',
    fontSize: text.sm,
  },
  scopeLabel: { fontWeight: weight.medium },
  scopeTable: {
    borderRadius: tokens['--xid-radius'],
    boxShadow: `inset 0 0 0 1px ${tokens['--xid-border']}`,
    maxHeight: { default: 'none', '@media (min-width: 48rem)': '22rem' },
    overflowY: 'auto',
  },
  scopeRow: {
    display: 'grid',
    gridTemplateColumns: {
      default: 'minmax(0, 1fr) 10rem',
      '@media (min-width: 48rem)': 'minmax(0, 1fr) repeat(3, 6.5rem)',
    },
    alignItems: 'center',
    gap: '0.75rem',
    paddingBlock: '0.625rem',
    paddingInline: '0.875rem',
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
  },
  scopeHeaderRow: {
    display: { default: 'none', '@media (min-width: 48rem)': 'grid' },
    borderTopWidth: 0,
    backgroundColor: tokens['--xid-sidebar'],
    color: tokens['--xid-muted-foreground'],
    fontSize: text.xs,
    paddingBlock: '0.5rem',
  },
  center: { textAlign: 'center' },
  resource: { display: 'flex', flexDirection: 'column', gap: '0.125rem', minWidth: 0 },
  resourceName: { fontSize: text.sm, fontWeight: weight.medium },
  resourceSub: {
    fontSize: text.xs,
    color: tokens['--xid-muted-foreground'],
    lineHeight: leading.xs,
  },
  radioCell: {
    display: { default: 'none', '@media (min-width: 48rem)': 'flex' },
    justifyContent: 'center',
  },
  selectCell: { display: { default: 'block', '@media (min-width: 48rem)': 'none' } },
  radio: {
    width: '1rem',
    height: '1rem',
    margin: 0,
    accentColor: tokens['--xid-accent'],
    cursor: { default: 'pointer', ':disabled': 'not-allowed' },
  },
  footerActions: {
    display: 'flex',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    gap: '0.5rem',
  },
  footnote: {
    margin: 0,
    fontSize: text.sm,
    color: tokens['--xid-muted-foreground'],
  },
  facts: {
    display: 'grid',
    gridTemplateColumns: { default: '1fr', '@media (min-width: 48rem)': '6rem minmax(0, 1fr)' },
    gap: '0.25rem 1rem',
    margin: 0,
    fontSize: text.sm,
  },
  factLabel: { color: tokens['--xid-muted-foreground'] },
  factValue: { margin: 0, overflowWrap: 'anywhere' },
})

function keyState(row: ApiKeyRow, now: number): KeyState {
  if (!row.expires_at) return 'active'
  const expiresAt = new Date(row.expires_at).getTime()
  if (expiresAt <= now) return 'expired'
  return expiresAt - now <= EXPIRING_WINDOW_MS ? 'expiring' : 'active'
}

const STATE_TONE: Record<KeyState, BadgeTone> = {
  active: 'success',
  expiring: 'warning',
  expired: 'danger',
}

function KeyStatus({ row, now }: { row: ApiKeyRow; now: number }): ReactNode {
  const { i18n } = useLingui()
  const state = keyState(row, now)
  const date = row.expires_at
    ? i18n.date(new Date(row.expires_at), { month: 'short', day: 'numeric' })
    : ''
  return (
    <Badge tone={STATE_TONE[state]}>
      {state === 'active' ? <Trans>Active</Trans> : null}
      {state === 'expiring' ? <Trans>Expires {date}</Trans> : null}
      {state === 'expired' ? <Trans>Expired {date}</Trans> : null}
    </Badge>
  )
}

function CreatedCell({ row }: { row: ApiKeyRow }): ReactNode {
  const { i18n } = useLingui()
  const date = formatDate(i18n, row.created_at) ?? ''
  const actor = actorName(row.createdBy)
  if (!actor) return <span {...stylex.props(list.numeric)}>{date}</span>
  return (
    <span>
      <Trans>
        {date} by {actor}
      </Trans>
    </span>
  )
}

function actorName(actor: ActorRef | null): string | null {
  if (!actor) return null
  return actor.displayName ?? actor.id
}

function scopeCount(scopes: readonly string[]): number {
  if (scopes.includes('*')) return API_KEY_SCOPE_RESOURCES.length
  return new Set(scopes.map((scope) => scope.split(':')[0])).size
}

export default function OrgApiKeys(): ReactNode {
  return (
    <TenantScopeGate title={<Trans>API keys</Trans>}>
      <ApiKeysPage />
    </TenantScopeGate>
  )
}

function ApiKeysPage(): ReactNode {
  const { t, i18n } = useLingui()
  const { activeOrg } = useAuth()
  const errorMessage = useManagementErrorMessage()
  const keys = useApiKeyRowsQuery()
  const revokeApiKey = useRevokeApiKey()
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<StatusFilter>(null)
  const [creating, setCreating] = useState(false)
  const [created, setCreated] = useState<CreatedApiKey | null>(null)
  const [pendingRevoke, setPendingRevoke] = useState<ApiKeyRow | null>(null)
  const orgName = activeOrg ? organizationDisplayName(activeOrg) : ''
  const now = Date.now()
  const rows = keys.data?.data ?? []
  const needle = query.trim().toLowerCase()
  const shown = rows.filter(
    (row) =>
      (status === null || keyState(row, now) === status) &&
      (needle === '' ||
        row.name.toLowerCase().includes(needle) ||
        row.key_prefix.toLowerCase().includes(needle)),
  )
  const statusLabels: Record<KeyState, string> = {
    active: t`Active`,
    expiring: t`Expiring soon`,
    expired: t`Expired`,
  }

  const columns: DataTableColumnDef<ApiKeyRow>[] = [
    {
      id: 'key',
      header: () => t`Key`,
      cell: ({ row }) => (
        <IdentityCell
          name={row.original.name}
          secondary={`${row.original.key_prefix}…`}
          secondaryIsCode
        />
      ),
      meta: { priority: 'primary', width: '34%' },
    },
    {
      id: 'status',
      header: () => t`Status`,
      cell: ({ row }) => <KeyStatus row={row.original} now={now} />,
      meta: { priority: 'primary' },
    },
    {
      id: 'scopes',
      header: () => t`Scopes`,
      cell: ({ row }) => (
        <span {...stylex.props(list.numeric)}>{scopeCount(row.original.scopes)}</span>
      ),
      meta: { align: 'end', hidden: { narrow: true, regular: false } },
    },
    {
      id: 'created',
      header: () => t`Created`,
      cell: ({ row }) => <CreatedCell row={row.original} />,
      meta: { hidden: { narrow: true, regular: true, sidebar: false } },
    },
    {
      id: 'lastUsed',
      header: () => t`Last used`,
      cell: ({ row }) =>
        row.original.last_used_at ? (
          <span {...stylex.props(list.numeric)}>
            {formatRelative(i18n, row.original.last_used_at)}
          </span>
        ) : (
          <span {...stylex.props(list.muted)}>{t`Never`}</span>
        ),
      meta: { align: 'end', hidden: { narrow: true, regular: false } },
    },
    {
      id: 'menu',
      header: () => t`Actions`,
      cell: ({ row }) => {
        const name = row.original.name
        return (
          <span {...stylex.props(list.rowMenu)}>
            <Dropdown
              ariaLabel={t`Actions for ${name}`}
              align="end"
              triggerStyle={list.iconButton}
              trigger={<Icon name="more-horizontal" size={16} />}
              items={[
                {
                  key: 'revoke',
                  label: <Trans>Revoke key…</Trans>,
                  tone: 'danger',
                  onSelect: () => setPendingRevoke(row.original),
                },
              ]}
            />
          </span>
        )
      },
      meta: { priority: 'primary', align: 'end', width: '3rem' },
    },
  ]

  const isEmpty = keys.data !== undefined && rows.length === 0

  return (
    <PageFrame
      title={<Trans>API keys</Trans>}
      lead={
        <Trans>
          Secret keys let your servers call the Management API for {orgName}. A key can only hold
          scopes that you have yourself.
        </Trans>
      }
    >
      {revokeApiKey.error ? <Alert tone="error">{errorMessage(revokeApiKey.error)}</Alert> : null}
      {keys.isError && !keys.data ? (
        <EmptyState
          variant="load-failure"
          title={<Trans>API keys could not be loaded</Trans>}
          description={<Trans>Nothing changed. Check your connection and try again.</Trans>}
          action={
            <Button variant="secondary" onClick={() => void keys.refetch()}>
              <Trans>Try again</Trans>
            </Button>
          }
        />
      ) : isEmpty ? (
        <FirstKey orgName={orgName} onCreate={() => setCreating(true)} />
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
                placeholder={t`Name or key prefix`}
                aria-label={t`Search API keys`}
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
                ...(['active', 'expiring', 'expired'] as const).map((option) => ({
                  key: option,
                  label: statusLabels[option],
                  checked: status === option,
                  onSelect: () => setStatus(option),
                })),
              ]}
            />
            <div {...stylex.props(list.barEnd)}>
              <Button onClick={() => setCreating(true)}>
                <Icon name="plus" size={16} />
                <Trans>Create API key…</Trans>
              </Button>
            </div>
          </div>
          <DataTable
            columns={columns}
            data={shown}
            getRowId={(row) => row.id}
            isLoading={keys.isLoading}
            density="comfortable"
            narrowMode="priority"
            caption={t`API keys`}
            captionDisplay="hidden"
            emptyMessage={<Trans>No API keys match these filters.</Trans>}
          />
          <LoadMore query={keys} loadMoreLabel={<Trans>Load more keys</Trans>} />
        </>
      )}
      {creating ? (
        <CreateApiKeyDialog
          onClose={() => setCreating(false)}
          onCreated={(key) => {
            setCreating(false)
            setCreated(key)
          }}
        />
      ) : null}
      {created ? <NewKeyDialog apiKey={created} onDone={() => setCreated(null)} /> : null}
      {pendingRevoke ? (
        <ConfirmDialog
          title={<Trans>Revoke {pendingRevoke.name}?</Trans>}
          description={
            <Trans>
              Requests signed with {pendingRevoke.key_prefix}… fail right away. A revoked key cannot
              be restored.
            </Trans>
          }
          confirmLabel={<Trans>Revoke key</Trans>}
          isLoading={revokeApiKey.isPending}
          onConfirm={() =>
            revokeApiKey.mutate(pendingRevoke.id, { onSettled: () => setPendingRevoke(null) })
          }
          onCancel={() => setPendingRevoke(null)}
        />
      ) : null}
    </PageFrame>
  )
}

function FirstKey({ orgName, onCreate }: { orgName: ReactNode; onCreate: () => void }): ReactNode {
  const { i18n } = useLingui()
  return (
    <section {...stylex.props(styles.empty)}>
      <h2 {...stylex.props(styles.emptyTitle)}>
        <Trans>No API keys for {orgName} yet</Trans>
      </h2>
      <p {...stylex.props(styles.emptyLead)}>
        <Trans>
          Give each service its own key with only the scopes it needs, so one leaked key can't touch
          everything. Typical first keys:
        </Trans>
      </p>
      <ul {...stylex.props(styles.examples)}>
        {FIRST_KEY_EXAMPLES.map((example) => (
          <li key={example.scope} {...stylex.props(styles.example)}>
            <span {...stylex.props(styles.code)}>{example.scope}</span>
            <span {...stylex.props(list.muted)}>{i18n._(example.purpose)}</span>
          </li>
        ))}
      </ul>
      <div {...stylex.props(styles.emptyActions)}>
        <Button onClick={onCreate}>
          <Icon name="plus" size={16} />
          <Trans>Create API key…</Trans>
        </Button>
        <a
          href={`${DOCS_URL}/management-api`}
          target="_blank"
          rel="noreferrer"
          {...stylex.props(styles.link)}
        >
          <Trans>Read the Management API guide</Trans>
        </a>
      </div>
    </section>
  )
}

function scopesFrom(access: Partial<Record<ApiKeyScopeResource, Access>>): string[] {
  return API_KEY_SCOPE_RESOURCES.flatMap((resource) => {
    const level = access[resource] ?? 'none'
    if (level === 'read') return [`${resource}:read`]
    if (level === 'write') return [`${resource}:read`, `${resource}:write`]
    return []
  })
}

function expiryDate(expiry: Expiry, now: number): Date | null {
  return expiry === 'never' ? null : new Date(now + Number(expiry) * DAY_MS)
}

function CreateApiKeyDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: (key: CreatedApiKey) => void
}): ReactNode {
  const { t, i18n } = useLingui()
  const errorMessage = useManagementErrorMessage()
  const create = useCreateApiKey()
  const grantable = useGrantableScopesQuery(true)
  const [name, setName] = useState('')
  const [expiry, setExpiry] = useState<Expiry>('90')
  const [access, setAccess] = useState<Partial<Record<ApiKeyScopeResource, Access>>>({})
  const [missing, setMissing] = useState<'name' | 'scopes' | null>(null)
  const [now] = useState(() => Date.now())
  const chosen = API_KEY_SCOPE_RESOURCES.filter(
    (resource) => (access[resource] ?? 'none') !== 'none',
  )
  const total = API_KEY_SCOPE_RESOURCES.length
  const chosenCount = chosen.length
  const expiryLabel = (days: number) =>
    i18n.date(new Date(now + days * DAY_MS), { month: 'short', day: 'numeric', year: 'numeric' })
  const date30 = expiryLabel(30)
  const date90 = expiryLabel(90)
  const date365 = expiryLabel(365)
  const scopeError = errorTargetsField(create.error, 'scopes') ? errorMessage(create.error) : null
  const formError =
    create.error && !scopeError && !errorTargetsField(create.error, 'expires_at')
      ? errorMessage(create.error)
      : null

  function submit(event: FormEvent): void {
    event.preventDefault()
    const scopes = scopesFrom(access)
    if (!name.trim()) return setMissing('name')
    if (scopes.length === 0) return setMissing('scopes')
    setMissing(null)
    const expiresAt = expiryDate(expiry, Date.now())
    create.mutate(
      {
        name: name.trim(),
        environment: 'live',
        scopes,
        ...(expiresAt ? { expires_at: expiresAt.toISOString() } : {}),
      },
      { onSuccess: onCreated },
    )
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => (next || create.isPending ? undefined : onClose())}
      title={<Trans>Create API key</Trans>}
      description={
        <Trans>
          Give the key only what the service needs. You can't widen a key's scopes later; create a
          new key instead.
        </Trans>
      }
      position={{ narrow: 'fullscreen', regular: 'center' }}
      size="lg"
      footer={
        <>
          <p {...stylex.props(styles.footnote)}>
            <Trans>You'll see the full key once, right after it's created.</Trans>
          </p>
          <span {...stylex.props(styles.footerActions)}>
            <Button variant="secondary" disabled={create.isPending} onClick={onClose}>
              <Trans>Cancel</Trans>
            </Button>
            <Button type="submit" form="create-api-key" isLoading={create.isPending}>
              <Trans>Create key</Trans>
            </Button>
          </span>
        </>
      }
    >
      <form id="create-api-key" onSubmit={submit} noValidate {...stylex.props(styles.form)}>
        <div {...stylex.props(styles.nameRow)}>
          <Field
            label={<Trans>Name</Trans>}
            error={missing === 'name' ? t`Enter a name for the key.` : (formError ?? undefined)}
            required
          >
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t`Driver App roster sync`}
              autoFocus
            />
          </Field>
          <Field
            label={<Trans>Expires</Trans>}
            error={
              errorTargetsField(create.error, 'expires_at') ? errorMessage(create.error) : undefined
            }
          >
            <Select value={expiry} onChange={(event) => setExpiry(event.target.value as Expiry)}>
              <option value="30">{t`In 30 days (${date30})`}</option>
              <option value="90">{t`In 90 days (${date90})`}</option>
              <option value="365">{t`In 1 year (${date365})`}</option>
              <option value="never">{t`Never`}</option>
            </Select>
          </Field>
        </div>
        <ScopePicker
          access={access}
          grantable={grantable.data ?? null}
          onChange={(resource, level) =>
            setAccess((current) => ({ ...current, [resource]: level }))
          }
          summary={
            <Trans>
              {chosenCount} of {total} resources
            </Trans>
          }
        />
        {missing === 'scopes' ? (
          <Alert tone="error">
            <Trans>Give the key access to at least one resource.</Trans>
          </Alert>
        ) : null}
        {scopeError ? <Alert tone="error">{scopeError}</Alert> : null}
        {grantable.isError ? (
          <Alert tone="error">
            <Trans>
              Your grantable scopes could not be loaded. Close the dialog and try again.
            </Trans>
          </Alert>
        ) : null}
      </form>
    </Dialog>
  )
}

function ScopePicker({
  access,
  grantable,
  onChange,
  summary,
}: {
  access: Partial<Record<ApiKeyScopeResource, Access>>
  grantable: GrantableScopes | null
  onChange: (resource: ApiKeyScopeResource, level: Access) => void
  summary: ReactNode
}): ReactNode {
  const { t, i18n } = useLingui()
  const allowed = new Set(grantable?.scopes ?? [])
  return (
    <div {...stylex.props(styles.form)}>
      <div {...stylex.props(styles.scopeHead)}>
        <span {...stylex.props(styles.scopeLabel)}>
          <Trans>Scopes</Trans>
        </span>
        <span {...stylex.props(list.muted)}>{summary}</span>
      </div>
      <div role="table" aria-label={t`Scopes`} {...stylex.props(styles.scopeTable)}>
        <div role="row" {...stylex.props(styles.scopeRow, styles.scopeHeaderRow)}>
          <span role="columnheader">{t`Resource`}</span>
          <span role="columnheader" {...stylex.props(styles.center)}>{t`No access`}</span>
          <span role="columnheader" {...stylex.props(styles.center)}>{t`Read`}</span>
          <span role="columnheader" {...stylex.props(styles.center)}>{t`Read and write`}</span>
        </div>
        {API_KEY_SCOPE_RESOURCES.map((resource) => {
          const level = access[resource] ?? 'none'
          const canRead = allowed.has(`${resource}:read`)
          const canWrite = canRead && allowed.has(`${resource}:write`)
          const label = i18n._(RESOURCE_LABELS[resource])
          const options: readonly { value: Access; label: string; disabled: boolean }[] = [
            { value: 'none', label: t`No access`, disabled: false },
            { value: 'read', label: t`Read`, disabled: !canRead },
            { value: 'write', label: t`Read and write`, disabled: !canWrite },
          ]
          return (
            <div role="row" key={resource} {...stylex.props(styles.scopeRow)}>
              <span role="cell" {...stylex.props(styles.resource)}>
                <span {...stylex.props(styles.resourceName)}>{label}</span>
                <span {...stylex.props(styles.resourceSub)}>
                  <ScopeHint
                    resource={resource}
                    level={level}
                    canRead={canRead}
                    canWrite={canWrite}
                    ready={grantable !== null}
                  />
                </span>
              </span>
              {options.map((option) => (
                <span role="cell" key={option.value} {...stylex.props(styles.radioCell)}>
                  <input
                    type="radio"
                    name={`scope-${resource}`}
                    value={option.value}
                    checked={level === option.value}
                    disabled={option.disabled}
                    onChange={() => onChange(resource, option.value)}
                    aria-label={`${label}: ${option.label}`}
                    {...stylex.props(styles.radio)}
                  />
                </span>
              ))}
              <span role="cell" {...stylex.props(styles.selectCell)}>
                <Select
                  value={level}
                  aria-label={label}
                  onChange={(event) => onChange(resource, event.target.value as Access)}
                >
                  {options.map((option) => (
                    <option key={option.value} value={option.value} disabled={option.disabled}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function ScopeHint({
  resource,
  level,
  canRead,
  canWrite,
  ready,
}: {
  resource: ApiKeyScopeResource
  level: Access
  canRead: boolean
  canWrite: boolean
  ready: boolean
}): ReactNode {
  if (ready && !canRead) return <Trans>Not available: your own access doesn't include it</Trans>
  if (ready && !canWrite && level === 'none') {
    return <Trans>Write isn't available: your own access can only read this</Trans>
  }
  if (level === 'read') return <span {...stylex.props(styles.code)}>{`${resource}:read`}</span>
  if (level === 'write') {
    return <span {...stylex.props(styles.code)}>{`${resource}:read, ${resource}:write`}</span>
  }
  return <Trans>No access</Trans>
}

function NewKeyDialog({
  apiKey,
  onDone,
}: {
  apiKey: CreatedApiKey
  onDone: () => void
}): ReactNode {
  const { t, i18n } = useLingui()
  const name = apiKey.name
  const expires = formatDate(i18n, apiKey.expires_at)
  return (
    <Dialog
      open
      dismissible={false}
      onOpenChange={() => undefined}
      title={<Trans>Copy your new key now</Trans>}
      description={
        <Trans>
          This is the only time XID shows the full key for {name}. If you lose it, create a new key
          first, then revoke this one.
        </Trans>
      }
      position={{ narrow: 'fullscreen', regular: 'center' }}
      size="md"
    >
      <OneTimeSecret
        label={<Trans>API key</Trans>}
        value={apiKey.key}
        subject={t`API key`}
        hint={
          <span {...stylex.props(styles.facts)}>
            <span {...stylex.props(styles.factLabel)}>
              <Trans>Scopes</Trans>
            </span>
            <span {...stylex.props(styles.factValue, styles.code)}>{apiKey.scopes.join(', ')}</span>
            <span {...stylex.props(styles.factLabel)}>
              <Trans>Expires</Trans>
            </span>
            <span {...stylex.props(styles.factValue)}>{expires ?? t`Never`}</span>
          </span>
        }
        savedLabel={<Trans>I saved this key somewhere safe</Trans>}
        onDone={onDone}
      />
    </Dialog>
  )
}
