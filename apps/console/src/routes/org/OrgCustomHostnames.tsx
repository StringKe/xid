import { Plural, Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { ConfirmDialog } from '@xid-kit/web-ui'
import { Alert, Badge, Button, Dropdown, Field, Icon, Input, Spinner } from '@xid-kit/web-ui/ui'
import { CopyButton } from '@xid-kit/web-ui/ui/CopyButton'
import { useManagementErrorMessage } from '@xid-kit/web-ui/api-error-message'
import { text, weight } from '@xid-kit/web-ui/styles/scale.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import {
  useBrandingQuery,
  useCreateCustomHostname,
  useCustomHostnamesQuery,
  useDeleteCustomHostname,
  useRefreshCustomHostname,
  type CustomHostname,
  type DnsRecord,
} from './brand-queries'

// 主机名语法各 locale 必须保持可原样提交,不可本地化占位符。
const HOSTNAME_EXAMPLE = 'login.example.com'

type CheckState = 'done' | 'working' | 'waiting' | 'failed'

const styles = stylex.create({
  stack: { display: 'flex', flexDirection: 'column', gap: '1.5rem' },
  head: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '1rem' },
  headText: { display: 'flex', flexDirection: 'column', gap: '0.375rem', minWidth: 0 },
  hostnameRow: { display: 'flex', alignItems: 'center', gap: '0.625rem', flexWrap: 'wrap' },
  hostname: {
    margin: 0,
    color: tokens['--xid-fg'],
    fontFamily: tokens['--xid-font-mono'],
    fontSize: text.lg,
    fontWeight: weight.medium,
    overflowWrap: 'anywhere',
  },
  lead: {
    margin: 0,
    color: tokens['--xid-muted-foreground'],
    fontSize: text.base,
    lineHeight: '1.25rem',
  },
  steps: {
    display: 'grid',
    gridTemplateColumns: {
      default: '1fr',
      '@media (min-width: 48rem)': 'repeat(3, minmax(0, 1fr))',
    },
    borderRadius: tokens['--xid-radius'],
    boxShadow: `inset 0 0 0 1px ${tokens['--xid-border']}`,
  },
  step: {
    display: 'flex',
    flexDirection: { default: 'row', '@media (min-width: 48rem)': 'column' },
    alignItems: { default: 'center', '@media (min-width: 48rem)': 'flex-start' },
    justifyContent: 'space-between',
    gap: '0.5rem',
    padding: '1rem',
    borderTopWidth: { default: '1px', ':first-child': '0', '@media (min-width: 48rem)': '0' },
    borderInlineStartWidth: { default: '0', '@media (min-width: 48rem)': '1px' },
    borderStyle: 'solid',
    borderColor: tokens['--xid-border'],
  },
  stepFirst: { borderInlineStartWidth: '0' },
  stepTitle: { color: tokens['--xid-fg'], fontSize: text.sm },
  stepNote: {
    display: { default: 'none', '@media (min-width: 48rem)': 'block' },
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
  },
  sectionHead: {
    display: 'flex',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: '1rem',
  },
  sectionTitle: {
    margin: 0,
    color: tokens['--xid-fg'],
    fontSize: text.lg,
    fontWeight: weight.display,
    letterSpacing: tokens['--xid-tracking-heading'],
  },
  sectionHint: { margin: 0, color: tokens['--xid-muted-foreground'], fontSize: text.sm },
  records: { display: 'flex', flexDirection: 'column' },
  recordHead: {
    display: { default: 'none', '@media (min-width: 48rem)': 'grid' },
    gridTemplateColumns: '5rem minmax(0, 1.4fr) minmax(0, 1.4fr) 7.5rem',
    gap: '1rem',
    paddingBlock: '0.5rem',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
  },
  record: {
    display: 'grid',
    gridTemplateColumns: {
      default: 'minmax(0, 1fr) auto',
      '@media (min-width: 48rem)': '5rem minmax(0, 1.4fr) minmax(0, 1.4fr) 7.5rem',
    },
    alignItems: 'center',
    gap: '0.25rem 1rem',
    paddingBlock: '0.625rem',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  mono: {
    minWidth: 0,
    color: tokens['--xid-fg'],
    fontFamily: tokens['--xid-font-mono'],
    fontSize: text.sm,
    overflowWrap: 'anywhere',
  },
  valueCell: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    minWidth: 0,
    gridColumn: { default: '1 / -1', '@media (min-width: 48rem)': 'auto' },
  },
  found: { color: tokens['--xid-success'], fontSize: text.sm },
  pending: { color: tokens['--xid-warning'], fontSize: text.sm },
  iconButton: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.375rem',
    minHeight: '2.25rem',
    paddingInline: '0.875rem',
    borderRadius: tokens['--xid-radius'],
    boxShadow: `inset 0 0 0 1px ${tokens['--xid-border-strong']}`,
    color: tokens['--xid-fg'],
    fontSize: text.base,
    fontWeight: weight.medium,
  },
  addRow: {
    display: 'flex',
    alignItems: 'flex-end',
    gap: '0.75rem',
    flexWrap: 'wrap',
    maxWidth: '36rem',
  },
  inputWrap: { flex: '1 1 18rem', minWidth: 0 },
  center: { display: 'flex', justifyContent: 'center', paddingBlock: '2.25rem' },
})

function stepStates(item: CustomHostname): [CheckState, CheckState, CheckState] {
  const ownership: CheckState = item.dns_checks.txt === 'pending' ? 'working' : 'done'
  const failed = item.status === 'provisioning_failed' || item.status === 'deletion_failed'
  const certificate: CheckState = failed
    ? 'failed'
    : item.ssl_status === 'active'
      ? 'done'
      : 'working'
  const routing: CheckState =
    item.status === 'active' ? 'done' : certificate === 'done' ? 'working' : 'waiting'
  return [ownership, certificate, routing]
}

function StepBadge({
  state,
  labels,
}: {
  state: CheckState
  labels: Record<CheckState, ReactNode>
}): ReactNode {
  const tone =
    state === 'done'
      ? 'success'
      : state === 'working'
        ? 'warning'
        : state === 'failed'
          ? 'danger'
          : 'neutral'
  return <Badge tone={tone}>{labels[state]}</Badge>
}

function ChecksStrip({ item }: { item: CustomHostname }): ReactNode {
  const [ownership, certificate, routing] = stepStates(item)
  return (
    <div {...stylex.props(styles.steps)}>
      <div {...stylex.props(styles.step, styles.stepFirst)}>
        <span {...stylex.props(styles.stepTitle)}>
          <Trans>1. Ownership</Trans>
        </span>
        <StepBadge
          state={ownership}
          labels={{
            done: <Trans>Verified</Trans>,
            working: <Trans>Waiting for TXT</Trans>,
            waiting: null,
            failed: null,
          }}
        />
        <span {...stylex.props(styles.stepNote)}>
          {ownership === 'done' ? (
            <Trans>TXT record found</Trans>
          ) : (
            <Trans>Add the TXT record below</Trans>
          )}
        </span>
      </div>
      <div {...stylex.props(styles.step)}>
        <span {...stylex.props(styles.stepTitle)}>
          <Trans>2. Certificate</Trans>
        </span>
        <StepBadge
          state={certificate}
          labels={{
            done: <Trans>Active</Trans>,
            working: <Trans>Being issued</Trans>,
            waiting: null,
            failed: <Trans>Action required</Trans>,
          }}
        />
        <span {...stylex.props(styles.stepNote)}>
          {certificate === 'done' ? (
            <Trans>Certificate is active</Trans>
          ) : (
            <Trans>Needs the CNAME below to resolve</Trans>
          )}
        </span>
      </div>
      <div {...stylex.props(styles.step)}>
        <span {...stylex.props(styles.stepTitle)}>
          <Trans>3. Routing</Trans>
        </span>
        <StepBadge
          state={routing}
          labels={{
            done: <Trans>Live</Trans>,
            working: <Trans>Starting</Trans>,
            waiting: <Trans>Not started</Trans>,
            failed: null,
          }}
        />
        <span {...stylex.props(styles.stepNote)}>
          {routing === 'done' ? (
            <Trans>Sign-in pages are served here</Trans>
          ) : (
            <Trans>Starts after the certificate is active</Trans>
          )}
        </span>
      </div>
    </div>
  )
}

function RecordRow({ record, found }: { record: DnsRecord; found: boolean | null }): ReactNode {
  const { t } = useLingui()
  return (
    <div {...stylex.props(styles.record)}>
      <span {...stylex.props(styles.mono)}>{record.type}</span>
      <span {...stylex.props(styles.mono)}>{record.name}</span>
      <span {...stylex.props(styles.valueCell)}>
        <span {...stylex.props(styles.mono)}>{record.value}</span>
        <CopyButton value={record.value} subject={t`${record.type} record value`} />
      </span>
      {found === null ? (
        <span />
      ) : found ? (
        <span {...stylex.props(styles.found)}>
          <Trans>Found</Trans>
        </span>
      ) : (
        <span {...stylex.props(styles.pending)}>
          <Trans>Not found yet</Trans>
        </span>
      )}
    </div>
  )
}

function HostnameDetail({
  orgId,
  item,
  defaultHost,
}: {
  orgId: string
  item: CustomHostname
  defaultHost: string
}): ReactNode {
  const { t } = useLingui()
  const errorMessage = useManagementErrorMessage()
  const refresh = useRefreshCustomHostname(orgId)
  const remove = useDeleteCustomHostname(orgId)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const live = item.status === 'active'
  const failed = item.status === 'provisioning_failed' || item.status === 'deletion_failed'
  const certificateRecords = [
    ...item.dns_records.dcv_delegation,
    ...item.dns_records.certificate_validation,
  ]
  const error = refresh.error ?? remove.error

  return (
    <div {...stylex.props(styles.stack)}>
      <div {...stylex.props(styles.head)}>
        <div {...stylex.props(styles.headText)}>
          <div {...stylex.props(styles.hostnameRow)}>
            <h2 {...stylex.props(styles.hostname)}>{item.hostname}</h2>
            {live ? (
              <Badge tone="success">
                <Trans>Live</Trans>
              </Badge>
            ) : failed ? (
              <Badge tone="danger">
                <Trans>Action required</Trans>
              </Badge>
            ) : (
              <Badge tone="warning">
                <Trans>Not live yet</Trans>
              </Badge>
            )}
          </div>
          <p {...stylex.props(styles.lead)}>
            {live ? (
              <Trans>
                Your sign-in pages are served at {item.hostname}. Apps keep the same issuer.
              </Trans>
            ) : (
              <Trans>
                Your sign-in pages move here once all three checks pass. Until then people keep
                signing in at {defaultHost}. Apps keep the same issuer either way.
              </Trans>
            )}
          </p>
        </div>
        <Dropdown
          ariaLabel={t`Sign-in domain actions`}
          align="end"
          trigger={
            <span {...stylex.props(styles.iconButton)}>
              <Trans>Actions</Trans>
              <Icon name="chevrons-up-down" size={14} />
            </span>
          }
          items={[
            {
              key: 'refresh',
              label: <Trans>Check now</Trans>,
              onSelect: () => refresh.mutate(item.id),
            },
            {
              key: 'delete',
              label: <Trans>Remove sign-in domain</Trans>,
              tone: 'danger',
              separatorBefore: true,
              onSelect: () => setConfirmDelete(true),
            },
          ]}
        />
      </div>

      {error ? <Alert tone="error">{errorMessage(error)}</Alert> : null}
      <ChecksStrip item={item} />

      <div {...stylex.props(styles.sectionHead)}>
        <div>
          <h3 {...stylex.props(styles.sectionTitle)}>
            <Trans>DNS records</Trans>
          </h3>
          <p {...stylex.props(styles.sectionHint)}>
            <Trans>
              Keep these records in place. Removing one takes the sign-in pages offline.
            </Trans>
          </p>
        </div>
        <Button
          variant="secondary"
          isLoading={refresh.isPending}
          onClick={() => refresh.mutate(item.id)}
        >
          <Trans>Check now</Trans>
        </Button>
      </div>
      <div {...stylex.props(styles.records)}>
        <div {...stylex.props(styles.recordHead)} aria-hidden="true">
          <span>
            <Trans>Type</Trans>
          </span>
          <span>
            <Trans>Name</Trans>
          </span>
          <span>
            <Trans>Value</Trans>
          </span>
          <span>
            <Trans>Status</Trans>
          </span>
        </div>
        <RecordRow record={item.dns_records.traffic} found={item.dns_checks.cname === 'found'} />
        {item.dns_records.ownership ? (
          <RecordRow record={item.dns_records.ownership} found={item.dns_checks.txt === 'found'} />
        ) : null}
        {certificateRecords.map((record) => (
          <RecordRow
            key={`${record.type}:${record.name}:${record.value}`}
            record={record}
            found={item.ssl_status === 'active'}
          />
        ))}
      </div>

      {!live && item.requires_passkey_reregistration ? (
        <Alert
          tone="warning"
          title={<Trans>Passkeys won&apos;t carry over to {item.hostname}</Trans>}
        >
          <Plural
            value={item.affected_passkey_user_count}
            one={`Passkeys are tied to the address they were created on. When this domain goes live, # person with passkeys for ${defaultHost} will sign in another way once and be asked to create a new passkey. Tell them before you switch.`}
            other={`Passkeys are tied to the address they were created on. When this domain goes live, # people with passkeys for ${defaultHost} will sign in another way once and be asked to create a new passkey. Tell them before you switch.`}
          />
        </Alert>
      ) : null}

      {confirmDelete ? (
        <ConfirmDialog
          title={<Trans>Remove sign-in domain?</Trans>}
          description={
            <Trans>
              XID deletes the Cloudflare custom hostname before marking it removed. Sign-in returns
              to {defaultHost}. Remove the traffic CNAME after this succeeds.
            </Trans>
          }
          error={remove.error ? errorMessage(remove.error) : undefined}
          confirmLabel={<Trans>Remove domain</Trans>}
          isLoading={remove.isPending}
          onConfirm={() => remove.mutate(item.id, { onSuccess: () => setConfirmDelete(false) })}
          onCancel={() => setConfirmDelete(false)}
        />
      ) : null}
    </div>
  )
}

function AddHostname({ orgId }: { orgId: string }): ReactNode {
  const errorMessage = useManagementErrorMessage()
  const create = useCreateCustomHostname(orgId)
  const [hostname, setHostname] = useState('')
  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    const normalized = hostname.trim()
    if (!normalized) return
    create.mutate({ hostname: normalized }, { onSuccess: () => setHostname('') })
  }
  return (
    <div {...stylex.props(styles.stack)}>
      <div>
        <h2 {...stylex.props(styles.sectionTitle)}>
          <Trans>No sign-in domain yet</Trans>
        </h2>
        <p {...stylex.props(styles.lead)}>
          <Trans>
            Serve the sign-in pages from a hostname you own. XID provisions it and its certificate,
            and switches over only after both are ready.
          </Trans>
        </p>
      </div>
      <Alert tone="warning">
        <Trans>
          Passkeys are tied to the address they were created on. People with passkeys will create
          new ones the first time they sign in at your own hostname.
        </Trans>
      </Alert>
      <form onSubmit={handleSubmit} noValidate>
        <div {...stylex.props(styles.addRow)}>
          <div {...stylex.props(styles.inputWrap)}>
            <Field
              label={<Trans>Hostname</Trans>}
              error={create.error ? errorMessage(create.error) : undefined}
              required
            >
              <Input
                value={hostname}
                onChange={(event) => setHostname(event.target.value)}
                placeholder={HOSTNAME_EXAMPLE}
                autoComplete="off"
                inputMode="url"
                required
              />
            </Field>
          </div>
          <Button type="submit" isLoading={create.isPending}>
            <Trans>Add hostname</Trans>
          </Button>
        </div>
      </form>
    </div>
  )
}

export function OrgCustomHostnames({ orgId }: { orgId: string }): ReactNode {
  const hostnames = useCustomHostnamesQuery(orgId)
  const branding = useBrandingQuery(orgId)
  const defaultHost = branding.data?.signInHost ?? ''
  if (hostnames.isLoading) {
    return (
      <div {...stylex.props(styles.center)}>
        <Spinner />
      </div>
    )
  }
  if (hostnames.isError) {
    return (
      <Alert tone="error">
        <Trans>Failed to load the sign-in domain. Reload the page to try again.</Trans>
      </Alert>
    )
  }
  const item = hostnames.data?.data[0]
  return item ? (
    <HostnameDetail orgId={orgId} item={item} defaultHost={defaultHost} />
  ) : (
    <AddHostname orgId={orgId} />
  )
}
