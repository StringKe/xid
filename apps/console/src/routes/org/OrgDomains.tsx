import { Plural, Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import {
  Alert,
  Badge,
  Button,
  ConsolePage,
  ConsolePageNotice,
  Dialog,
  Dropdown,
  Field,
  Icon,
  Input,
  Spinner,
} from '@xid-kit/web-ui/ui'
import { CopyButton } from '@xid-kit/web-ui/ui/CopyButton'
import { LoadMore } from '@xid-kit/web-ui/ui/LoadMore'
import { Tabs } from '@xid-kit/web-ui/ui/Tabs'
import { useNavigate, useSearchParams } from '@xid-kit/web-ui/tanstack-router'
import { useManagementErrorMessage } from '@xid-kit/web-ui/api-error-message'
import { text, weight } from '@xid-kit/web-ui/styles/scale.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { formatDate } from '../../lib/date-format'
import { useCheckEmailDomain, useEmailDomainsQuery, type EmailDomain } from './brand-queries'
import { OrgCustomHostnames } from './OrgCustomHostnames'
import { useCreateOrgDomain } from './queries'
import { useOrgTarget } from './useOrgTarget'

const DAY_MS = 24 * 60 * 60 * 1000
// 每日检查连续一周仍未找到记录时,状态从等待改为未验证。
const NOT_VERIFIED_AFTER_DAYS = 7

type DomainTab = 'email' | 'sign-in'
type DomainState = 'verified' | 'waiting' | 'not_verified'

const styles = stylex.create({
  zone: {
    paddingInline: 'clamp(1rem, 2.5vw, 4rem)',
    display: 'flex',
    flexDirection: 'column',
    gap: '1.5rem',
  },
  intro: {
    display: 'flex',
    alignItems: { default: 'stretch', '@media (min-width: 48rem)': 'center' },
    flexDirection: { default: 'column-reverse', '@media (min-width: 48rem)': 'row' },
    justifyContent: 'space-between',
    gap: '1rem',
  },
  introText: {
    margin: 0,
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
    lineHeight: '1.25rem',
  },
  table: { display: 'flex', flexDirection: 'column' },
  headRow: {
    display: { default: 'none', '@media (min-width: 48rem)': 'grid' },
    gridTemplateColumns: 'minmax(0, 1fr) 11.5rem 15rem 2rem',
    gap: '1rem',
    paddingBlock: '0.5rem',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
  },
  item: {
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
    paddingBlock: '0.375rem',
  },
  row: {
    display: 'grid',
    gridTemplateColumns: {
      default: 'minmax(0, 1fr) auto 2rem',
      '@media (min-width: 48rem)': 'minmax(0, 1fr) 11.5rem 15rem 2rem',
    },
    alignItems: 'center',
    gap: { default: '0.25rem 0.5rem', '@media (min-width: 48rem)': '1rem' },
    minHeight: '3rem',
  },
  domainCell: { display: 'flex', flexDirection: 'column', gap: '0.125rem', minWidth: 0 },
  domainName: {
    color: tokens['--xid-fg'],
    fontSize: text.base,
    fontWeight: weight.medium,
    overflowWrap: 'anywhere',
  },
  sub: {
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
    fontVariantNumeric: 'tabular-nums',
  },
  details: {
    display: { default: 'none', '@media (min-width: 48rem)': 'block' },
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
    fontVariantNumeric: 'tabular-nums',
  },
  trailing: {
    display: 'flex',
    gridColumn: { default: '3', '@media (min-width: 48rem)': '4' },
    justifyContent: 'flex-end',
  },
  iconButton: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '2rem',
    height: '2rem',
    padding: 0,
    borderWidth: 0,
    borderRadius: tokens['--xid-radius-sm'],
    backgroundColor: { default: 'transparent', ':hover': tokens['--xid-muted'] },
    color: tokens['--xid-muted-foreground'],
    cursor: 'pointer',
  },
  chevron: { display: 'inline-flex', transform: 'rotate(90deg)' },
  chevronOpen: { transform: 'rotate(-90deg)' },
  linkButton: {
    padding: 0,
    borderWidth: 0,
    backgroundColor: 'transparent',
    color: tokens['--xid-accent'],
    fontFamily: 'inherit',
    fontSize: text.sm,
    cursor: 'pointer',
    textAlign: 'start',
  },
  panel: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
    marginBlock: '0.375rem 0.75rem',
    padding: { default: '0.75rem', '@media (min-width: 48rem)': '1rem' },
    borderRadius: tokens['--xid-radius-lg'],
    backgroundColor: tokens['--xid-sidebar'],
  },
  panelText: { margin: 0, color: tokens['--xid-fg'], fontSize: text.sm, lineHeight: '1.25rem' },
  record: {
    display: 'flex',
    flexDirection: 'column',
    borderRadius: tokens['--xid-radius'],
    backgroundColor: tokens['--xid-surface'],
    boxShadow: `inset 0 0 0 1px ${tokens['--xid-border']}`,
  },
  recordRow: {
    display: 'grid',
    gridTemplateColumns: {
      default: 'minmax(0, 1fr) auto',
      '@media (min-width: 48rem)': '5.5rem minmax(0, 1fr) auto',
    },
    alignItems: 'center',
    gap: '0.25rem 0.75rem',
    minHeight: '2.5rem',
    paddingBlock: '0.375rem',
    paddingInline: '0.75rem',
    borderBottomWidth: { default: '1px', ':last-child': '0' },
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  recordLabel: {
    gridColumn: { default: '1 / -1', '@media (min-width: 48rem)': 'auto' },
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
  },
  recordValue: {
    minWidth: 0,
    color: tokens['--xid-fg'],
    fontFamily: tokens['--xid-font-mono'],
    fontSize: text.sm,
    overflowWrap: 'anywhere',
  },
  recordTail: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
  },
  hostHint: { display: { default: 'none', '@media (min-width: 48rem)': 'inline' } },
  checkRow: {
    display: 'flex',
    flexDirection: { default: 'column', '@media (min-width: 48rem)': 'row' },
    alignItems: { default: 'stretch', '@media (min-width: 48rem)': 'center' },
    gap: '0.75rem',
  },
  checkText: {
    margin: 0,
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
    lineHeight: '1.25rem',
  },
  empty: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
    maxWidth: '36rem',
    paddingTop: '1rem',
  },
  emptyTitle: {
    margin: 0,
    color: tokens['--xid-fg'],
    fontSize: text.lg,
    fontWeight: weight.display,
    letterSpacing: tokens['--xid-tracking-heading'],
  },
  steps: {
    display: 'flex',
    flexDirection: 'column',
    margin: 0,
    padding: 0,
    listStyle: 'none',
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
  },
  step: {
    display: 'grid',
    gridTemplateColumns: { default: '1fr', '@media (min-width: 48rem)': '14rem minmax(0, 1fr)' },
    gap: '0.25rem 1rem',
    paddingBlock: '0.625rem',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
    fontSize: text.base,
  },
  stepTitle: { fontWeight: weight.medium },
  stepHint: { color: tokens['--xid-muted-foreground'] },
  center: { display: 'flex', justifyContent: 'center', paddingBlock: '2.25rem' },
})

function domainState(row: EmailDomain, now: number): DomainState {
  if (row.verification_status === 'verified') return 'verified'
  const ageDays = (now - new Date(row.created_at).getTime()) / DAY_MS
  return ageDays >= NOT_VERIFIED_AFTER_DAYS ? 'not_verified' : 'waiting'
}

function StateBadge({ state }: { state: DomainState }): ReactNode {
  if (state === 'verified') {
    return (
      <Badge tone="success">
        <Trans>Verified</Trans>
      </Badge>
    )
  }
  return state === 'waiting' ? (
    <Badge tone="warning">
      <Trans>Waiting for DNS</Trans>
    </Badge>
  ) : (
    <Badge tone="danger">
      <Trans>Not verified</Trans>
    </Badge>
  )
}

function utcTime(value: string): string {
  return new Date(value).toISOString().slice(11, 16)
}

function DomainSubline({
  row,
  state,
  now,
}: {
  row: EmailDomain
  state: DomainState
  now: number
}): ReactNode {
  const { i18n } = useLingui()
  if (state === 'verified') {
    const connection = row.routed_connection?.name
    return connection ? (
      <Plural
        value={row.user_count}
        one={`# user, routes to ${connection} SSO`}
        other={`# users, routes to ${connection} SSO`}
      />
    ) : (
      <Plural value={row.user_count} one="# user" other="# users" />
    )
  }
  if (state === 'not_verified') {
    const days = Math.floor((now - new Date(row.created_at).getTime()) / DAY_MS)
    return (
      <Plural
        value={days}
        one="Record still missing after # day of checks"
        other="Record still missing after # days of checks"
      />
    )
  }
  const added = formatDate(i18n, row.created_at) ?? ''
  const by = row.added_by?.display_name
  return by ? (
    <Trans>
      Added {added} by {by}
    </Trans>
  ) : (
    <Trans>Added {added}</Trans>
  )
}

function CheckSummary({ row }: { row: EmailDomain }): ReactNode {
  if (!row.last_checked_at) {
    return (
      <Trans>Not checked yet. XID checks once a day. DNS changes can take up to 48 hours.</Trans>
    )
  }
  const time = utcTime(row.last_checked_at)
  return row.last_check_result === 'found' ? (
    <Trans>Last checked {time} UTC: record found.</Trans>
  ) : (
    <Trans>
      Last checked {time} UTC: record not found yet. XID also checks once a day. DNS changes can
      take up to 48 hours.
    </Trans>
  )
}

function DnsRecordPanel({
  row,
  onCheck,
  isChecking,
}: {
  row: EmailDomain
  onCheck: () => void
  isChecking: boolean
}): ReactNode {
  const { t } = useLingui()
  const record = row.verification_record
  const host = record.name.endsWith(`.${row.domain}`)
    ? record.name.slice(0, -(row.domain.length + 1))
    : record.name
  return (
    <div {...stylex.props(styles.panel)}>
      <p {...stylex.props(styles.panelText)}>
        <Trans>
          Add this TXT record at your DNS provider for {row.domain}. Copy each value exactly; some
          providers add the domain to the name for you, so enter only the part shown under Host if
          yours does.
        </Trans>
      </p>
      <div {...stylex.props(styles.record)}>
        <div {...stylex.props(styles.recordRow)}>
          <span {...stylex.props(styles.recordLabel)}>
            <Trans>Type</Trans>
          </span>
          <span {...stylex.props(styles.recordValue)}>{record.type}</span>
        </div>
        <div {...stylex.props(styles.recordRow)}>
          <span {...stylex.props(styles.recordLabel)}>
            <Trans>Name</Trans>
          </span>
          <span {...stylex.props(styles.recordValue)}>{record.name}</span>
          <span {...stylex.props(styles.recordTail)}>
            <span {...stylex.props(styles.hostHint)}>
              <Trans>Host: {host}</Trans>
            </span>
            <CopyButton value={record.name} subject={t`TXT record name`} />
          </span>
        </div>
        <div {...stylex.props(styles.recordRow)}>
          <span {...stylex.props(styles.recordLabel)}>
            <Trans>Value</Trans>
          </span>
          <span {...stylex.props(styles.recordValue)}>{record.value}</span>
          <span {...stylex.props(styles.recordTail)}>
            <CopyButton value={record.value} subject={t`TXT record value`} />
          </span>
        </div>
      </div>
      <div {...stylex.props(styles.checkRow)}>
        <Button variant="secondary" isLoading={isChecking} onClick={onCheck}>
          <Trans>Check now</Trans>
        </Button>
        <p {...stylex.props(styles.checkText)} aria-live="polite">
          <CheckSummary row={row} />
        </p>
      </div>
    </div>
  )
}

function DomainRow(props: {
  row: EmailDomain
  now: number
  expanded: boolean
  onToggle: () => void
  onCheck: () => void
  isChecking: boolean
}): ReactNode {
  const { i18n, t } = useLingui()
  const { row } = props
  const state = domainState(row, props.now)
  const verifiedAt = row.verified_at ? formatDate(i18n, row.verified_at) : null
  const details =
    state === 'verified' ? (
      verifiedAt ? (
        <Trans>Verified {verifiedAt}</Trans>
      ) : null
    ) : props.expanded || state === 'waiting' ? (
      row.last_checked_at ? (
        <Trans>Last checked {utcTime(row.last_checked_at)} UTC</Trans>
      ) : (
        <Trans>Not checked yet</Trans>
      )
    ) : (
      <button type="button" {...stylex.props(styles.linkButton)} onClick={props.onToggle}>
        <Trans>Show DNS record</Trans>
      </button>
    )
  return (
    <div {...stylex.props(styles.item)}>
      <div {...stylex.props(styles.row)}>
        <div {...stylex.props(styles.domainCell)}>
          <span {...stylex.props(styles.domainName)}>{row.domain}</span>
          <span {...stylex.props(styles.sub)}>
            <DomainSubline row={row} state={state} now={props.now} />
          </span>
        </div>
        <div>
          <StateBadge state={state} />
        </div>
        <div {...stylex.props(styles.details)}>{details}</div>
        <div {...stylex.props(styles.trailing)}>
          {state === 'verified' ? (
            <Dropdown
              ariaLabel={t`Actions for ${row.domain}`}
              align="end"
              trigger={
                <span {...stylex.props(styles.iconButton)}>
                  <Icon name="more-horizontal" size={16} />
                </span>
              }
              items={[
                { key: 'record', label: <Trans>Show DNS record</Trans>, onSelect: props.onToggle },
                { key: 'check', label: <Trans>Check now</Trans>, onSelect: props.onCheck },
              ]}
            />
          ) : (
            <button
              type="button"
              {...stylex.props(styles.iconButton)}
              aria-expanded={props.expanded}
              aria-label={
                props.expanded
                  ? t`Hide DNS record for ${row.domain}`
                  : t`Show DNS record for ${row.domain}`
              }
              onClick={props.onToggle}
            >
              <span {...stylex.props(styles.chevron, props.expanded && styles.chevronOpen)}>
                <Icon name="chevron-right" size={16} />
              </span>
            </button>
          )}
        </div>
      </div>
      {props.expanded ? (
        <DnsRecordPanel row={row} onCheck={props.onCheck} isChecking={props.isChecking} />
      ) : null}
    </div>
  )
}

function AddDomainDialog({
  orgId,
  open,
  onClose,
}: {
  orgId: string
  open: boolean
  onClose: () => void
}): ReactNode {
  const { t } = useLingui()
  const errorMessage = useManagementErrorMessage()
  const addDomain = useCreateOrgDomain(orgId)
  const [domain, setDomain] = useState('')
  function handleSubmit(event: FormEvent): void {
    event.preventDefault()
    if (!domain.trim()) return
    addDomain.mutate(
      { domain: domain.trim() },
      {
        onSuccess: () => {
          setDomain('')
          onClose()
        },
      },
    )
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => (next ? undefined : onClose())}
      title={<Trans>Add email domain</Trans>}
      description={<Trans>XID shows the TXT record to add after you save.</Trans>}
    >
      <form onSubmit={handleSubmit} noValidate>
        <Field
          label={<Trans>Domain</Trans>}
          error={addDomain.error ? errorMessage(addDomain.error) : undefined}
          required
        >
          <Input
            value={domain}
            onChange={(event) => setDomain(event.target.value)}
            placeholder={t`example.com`}
            autoComplete="off"
            inputMode="url"
            required
          />
        </Field>
        <Button type="submit" isLoading={addDomain.isPending}>
          <Trans>Add domain</Trans>
        </Button>
      </form>
    </Dialog>
  )
}

function EmptyEmailDomains({ orgName, onAdd }: { orgName: string; onAdd: () => void }): ReactNode {
  return (
    <div {...stylex.props(styles.empty)}>
      <h2 {...stylex.props(styles.emptyTitle)}>
        <Trans>No email domains verified yet</Trans>
      </h2>
      <p {...stylex.props(styles.introText)}>
        <Trans>
          Verify your company domain and people who sign up with that address join {orgName} and can
          be sent to your enterprise SSO. Verification is one DNS record:
        </Trans>
      </p>
      <ol {...stylex.props(styles.steps)}>
        <li {...stylex.props(styles.step)}>
          <span {...stylex.props(styles.stepTitle)}>
            <Trans>1. Add the domain</Trans>
          </span>
          <span {...stylex.props(styles.stepHint)}>
            <Trans>For example example.com</Trans>
          </span>
        </li>
        <li {...stylex.props(styles.step)}>
          <span {...stylex.props(styles.stepTitle)}>
            <Trans>2. Add a TXT record</Trans>
          </span>
          <span {...stylex.props(styles.stepHint)}>
            <Trans>XID shows the exact name and value to copy</Trans>
          </span>
        </li>
        <li {...stylex.props(styles.step)}>
          <span {...stylex.props(styles.stepTitle)}>
            <Trans>3. Wait for the check</Trans>
          </span>
          <span {...stylex.props(styles.stepHint)}>
            <Trans>Usually a few minutes, at most 48 hours</Trans>
          </span>
        </li>
      </ol>
      <div>
        <Button onClick={onAdd}>
          <Icon name="plus" size={16} />
          <Trans>Add domain</Trans>
        </Button>
      </div>
    </div>
  )
}

function EmailDomains({ orgId, orgName }: { orgId: string; orgName: string }): ReactNode {
  const errorMessage = useManagementErrorMessage()
  const domains = useEmailDomainsQuery(orgId)
  const check = useCheckEmailDomain(orgId)
  const [adding, setAdding] = useState(false)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const now = Date.now()
  const rows = domains.data?.data ?? []

  if (domains.isLoading) {
    return (
      <div {...stylex.props(styles.center)}>
        <Spinner />
      </div>
    )
  }
  if (domains.isError) {
    return (
      <Alert tone="error">
        <Trans>Failed to load email domains. Reload the page to try again.</Trans>
      </Alert>
    )
  }

  const dialog = <AddDomainDialog orgId={orgId} open={adding} onClose={() => setAdding(false)} />
  if (rows.length === 0) {
    return (
      <>
        <EmptyEmailDomains orgName={orgName} onAdd={() => setAdding(true)} />
        {dialog}
      </>
    )
  }

  // 等待 DNS 的域名默认展开记录,其余按用户点击。
  const isExpanded = (row: EmailDomain): boolean =>
    expanded[row.id] ?? domainState(row, now) === 'waiting'
  return (
    <>
      <div {...stylex.props(styles.intro)}>
        <p {...stylex.props(styles.introText)}>
          <Trans>
            A verified domain routes people with that email to {orgName} and to your enterprise SSO.
          </Trans>
        </p>
        <Button onClick={() => setAdding(true)}>
          <Icon name="plus" size={16} />
          <Trans>Add domain</Trans>
        </Button>
      </div>
      {check.error ? <Alert tone="error">{errorMessage(check.error)}</Alert> : null}
      <div {...stylex.props(styles.table)} role="list">
        <div {...stylex.props(styles.headRow)} aria-hidden="true">
          <span>
            <Trans>Domain</Trans>
          </span>
          <span>
            <Trans>Status</Trans>
          </span>
          <span>
            <Trans>Details</Trans>
          </span>
          <span />
        </div>
        {rows.map((row) => (
          <div role="listitem" key={row.id}>
            <DomainRow
              row={row}
              now={now}
              expanded={isExpanded(row)}
              onToggle={() =>
                setExpanded((current) => ({ ...current, [row.id]: !isExpanded(row) }))
              }
              onCheck={() => {
                setExpanded((current) => ({ ...current, [row.id]: true }))
                check.mutate(row.id)
              }}
              isChecking={check.isPending && check.variables === row.id}
            />
          </div>
        ))}
      </div>
      <LoadMore query={domains} loadMoreLabel={<Trans>Load more domains</Trans>} />
      {dialog}
    </>
  )
}

export default function OrgDomains(): ReactNode {
  const { t } = useLingui()
  const { orgId, activeOrg } = useOrgTarget()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const tab: DomainTab = searchParams.get('tab') === 'sign-in' ? 'sign-in' : 'email'
  const domains = useEmailDomainsQuery(orgId)
  const count = domains.data?.data.length

  function selectTab(next: string): void {
    const params = new URLSearchParams(searchParams)
    if (next === 'sign-in') params.set('tab', 'sign-in')
    else params.delete('tab')
    const search = params.toString()
    navigate(search ? `?${search}` : '?', { replace: true })
  }

  if (!orgId) {
    return (
      <ConsolePage wide title={<Trans>Domains</Trans>}>
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
      wide
      title={<Trans>Domains</Trans>}
      lead={
        <Trans>
          Prove you own your email domains, and choose the address your users sign in at.
        </Trans>
      }
    >
      <div {...stylex.props(styles.zone)}>
        <Tabs
          ariaLabel={t`Domain types`}
          value={tab}
          onValueChange={selectTab}
          items={[
            { value: 'email', label: <Trans>Email domains</Trans>, ...(count ? { count } : {}) },
            { value: 'sign-in', label: <Trans>Sign-in domain</Trans> },
          ]}
        />
        {tab === 'email' ? (
          <EmailDomains orgId={orgId} orgName={activeOrg?.name ?? ''} />
        ) : (
          <OrgCustomHostnames orgId={orgId} />
        )}
      </div>
    </ConsolePage>
  )
}
