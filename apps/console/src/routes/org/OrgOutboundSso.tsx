// /console/org/outbound-sso:XID 作为 IdP 的第三方 SAML app 列表;?appId= 显示详情。

import { Plural, Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import {
  Alert,
  Badge,
  Button,
  ConsolePage,
  ConsolePageNotice,
  Dropdown,
  EmptyState,
  Icon,
  Spinner,
} from '@xid-kit/web-ui/ui'
import { ConfirmDialog } from '@xid-kit/web-ui/ConfirmDialog'
import { useNavigate, useSearchParams } from '@xid-kit/web-ui/tanstack-router'
import { consoleShell } from '@xid-kit/web-ui/styles/product-surface.stylex'
import { leading, text, weight } from '@xid-kit/web-ui/styles/scale.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { list } from '../../components/page/list-styles'
import { formatDate } from '../../lib/date-format'
import { useOrgSelfServiceLocked, useOrgTarget } from './useOrgTarget'
import { SelfServiceLockNotice } from './SelfServiceLock'
import { useDeleteOutboundSamlApp } from './queries'
import { useOrgOutboundSamlAppsView } from './auth-queries'
import type { OutboundSamlAppView } from './auth-queries'
import { CERTIFICATE_WARNING_DAYS, daysUntil, relativeTime } from './auth-format'
import { OutboundAppDialog, appDisplayName, gateSummary } from './OutboundSamlAppForms'
import { OutboundSamlAppDetail, SAML_APPS_PATH } from './OutboundSamlAppDetail'

export { parseCertificates } from './OutboundSamlAppForms'

const WIDE = '@media (min-width: 48rem)'
const COLUMNS = 'minmax(0, 1.6fr) minmax(0, 1fr) minmax(0, 1fr) 9rem 2.5rem'

const styles = stylex.create({
  toolbar: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '0.5rem',
  },
  count: {
    margin: 0,
    paddingTop: '0.75rem',
    color: tokens['--xid-fg'],
    fontSize: text.sm,
    fontWeight: weight.medium,
  },
  head: {
    display: { default: 'none', [WIDE]: 'grid' },
    gridTemplateColumns: COLUMNS,
    gap: '1rem',
    marginTop: '1.5rem',
    paddingBottom: '0.625rem',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
  },
  headEnd: {
    textAlign: 'end',
    color: tokens['--xid-fg'],
  },
  rows: {
    margin: { default: '1rem 0 0', [WIDE]: 0 },
    padding: 0,
    listStyle: 'none',
    borderTopWidth: { default: '1px', [WIDE]: 0 },
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
  },
  row: {
    display: 'grid',
    gridTemplateColumns: { default: 'minmax(0, 1fr) auto', [WIDE]: COLUMNS },
    alignItems: 'center',
    gap: '0.25rem 1rem',
    paddingBlock: '0.625rem',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
    fontSize: text.base,
  },
  open: {
    appearance: 'none',
    display: 'flex',
    flexDirection: 'column',
    gap: '0.125rem',
    minWidth: 0,
    margin: 0,
    padding: 0,
    borderWidth: 0,
    textAlign: 'start',
    backgroundColor: 'transparent',
    color: tokens['--xid-fg'],
    font: 'inherit',
    cursor: 'pointer',
  },
  name: {
    fontSize: { default: text.md, [WIDE]: text.base },
    fontWeight: weight.medium,
    lineHeight: leading.sm,
  },
  entity: {
    color: tokens['--xid-muted-foreground'],
    fontFamily: tokens['--xid-font-mono'],
    fontSize: text.xs,
    overflowWrap: 'anywhere',
  },
  narrowMeta: {
    display: { default: 'block', [WIDE]: 'none' },
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
  },
  wide: {
    display: { default: 'none', [WIDE]: 'block' },
    minWidth: 0,
  },
  last: {
    display: { default: 'none', [WIDE]: 'block' },
    textAlign: 'end',
    fontVariantNumeric: 'tabular-nums',
  },
  never: {
    color: tokens['--xid-muted-foreground'],
  },
  chevron: {
    display: { default: 'inline-flex', [WIDE]: 'none' },
    color: tokens['--xid-muted-foreground'],
  },
  menu: {
    display: { default: 'none', [WIDE]: 'flex' },
    justifyContent: 'flex-end',
  },
})

function CertificateCell({ app }: { app: OutboundSamlAppView }): ReactNode {
  const { i18n } = useLingui()
  const active = app.signingCertificates.find((cert) => cert.status === 'active') ?? null
  if (!active) return <Trans>Created on first sign-in</Trans>
  const days = daysUntil(active.notAfter)
  if (days !== null && days <= 0) {
    return (
      <Badge tone="danger">
        <Trans>Expired</Trans>
      </Badge>
    )
  }
  if (days !== null && days <= CERTIFICATE_WARNING_DAYS) {
    return (
      <Badge tone="warning">
        <Plural value={days} one="Expires in # day" other="Expires in # days" />
      </Badge>
    )
  }
  const date = formatDate(i18n, active.notAfter)
  return <Trans>Expires {date}</Trans>
}

function lastSignInSort(a: OutboundSamlAppView, b: OutboundSamlAppView): number {
  return (
    (b.lastSignInAt ? Date.parse(b.lastSignInAt) : 0) -
    (a.lastSignInAt ? Date.parse(a.lastSignInAt) : 0)
  )
}

export default function OrgOutboundSso(): ReactNode {
  const { t, i18n } = useLingui()
  const locked = useOrgSelfServiceLocked()
  const { orgId, orgName } = useOrgTarget()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const { data, isLoading, isError } = useOrgOutboundSamlAppsView(orgId)
  const remove = useDeleteOutboundSamlApp(orgId)
  const [query, setQuery] = useState('')
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState<OutboundSamlAppView | null>(null)
  const appId = params.get('appId')
  const title = <Trans>SAML apps</Trans>

  function openApp(id: string | null): void {
    navigate(id ? `${SAML_APPS_PATH}?appId=${encodeURIComponent(id)}` : SAML_APPS_PATH)
  }

  const selected = appId ? (data?.find((app) => app.id === appId) ?? null) : null
  if (orgId && selected) {
    return (
      <>
        {locked ? (
          <ConsolePageNotice>
            <SelfServiceLockNotice />
          </ConsolePageNotice>
        ) : null}
        <OutboundSamlAppDetail
          orgId={orgId}
          app={selected}
          locked={locked}
          onBack={() => openApp(null)}
        />
      </>
    )
  }

  const needle = query.trim().toLowerCase()
  const apps = (data ?? [])
    .filter(
      (app) =>
        !needle ||
        appDisplayName(app).toLowerCase().includes(needle) ||
        app.spEntityId.toLowerCase().includes(needle),
    )
    .sort(lastSignInSort)
  const removingName = removing ? appDisplayName(removing) : ''

  return (
    <ConsolePage
      wide
      title={title}
      lead={
        <Trans>
          Third-party apps where {orgName} people sign in with their XID account. XID is the
          identity provider for each one.
        </Trans>
      }
    >
      {!orgId || locked || isError || (appId && data && !selected) ? (
        <ConsolePageNotice>
          {!orgId ? (
            <Alert tone="info">
              <Trans>No organization selected.</Trans>
            </Alert>
          ) : null}
          {locked ? <SelfServiceLockNotice /> : null}
          {isError ? (
            <Alert tone="error">
              <Trans>SAML apps could not be loaded. Reload the page to try again.</Trans>
            </Alert>
          ) : null}
          {appId && data && !selected ? (
            <Alert tone="info">
              <Trans>This SAML app no longer exists.</Trans>
            </Alert>
          ) : null}
        </ConsolePageNotice>
      ) : null}
      {orgId && !data && isLoading ? (
        <div {...stylex.props(consoleShell.sectionPad)}>
          <Spinner label={t`Loading SAML apps`} />
        </div>
      ) : null}
      {data ? (
        <section {...stylex.props(consoleShell.sectionPad)}>
          <div {...stylex.props(styles.toolbar)}>
            <label {...stylex.props(list.search)}>
              <span {...stylex.props(list.searchIcon)}>
                <Icon name="search" size={16} />
              </span>
              <input
                type="search"
                value={query}
                aria-label={t`Search SAML apps`}
                placeholder={t`App name or entity ID`}
                onChange={(event) => setQuery(event.target.value)}
                {...stylex.props(list.searchInput)}
              />
            </label>
            <div {...stylex.props(list.barEnd)}>
              <Button type="button" disabled={locked} onClick={() => setAdding(true)}>
                <Icon name="plus" size={14} />
                <Trans>Add SAML app</Trans>
              </Button>
            </div>
          </div>
          {data.length === 0 ? (
            <EmptyState
              variant="first-use"
              title={<Trans>No SAML apps yet</Trans>}
              description={
                <Trans>
                  Add an app such as Salesforce, Workday or Slack so people sign in to it with their
                  XID account.
                </Trans>
              }
            />
          ) : (
            <>
              <p {...stylex.props(styles.count)}>
                <Plural value={apps.length} one="# app" other="# apps" />
              </p>
              <div aria-hidden {...stylex.props(styles.head)}>
                <span>
                  <Trans>App</Trans>
                </span>
                <span>
                  <Trans>Who can sign in</Trans>
                </span>
                <span>
                  <Trans>Signing certificate</Trans>
                </span>
                <span {...stylex.props(styles.headEnd)}>
                  <Trans>Last sign-in</Trans>
                </span>
                <span />
              </div>
              <ul {...stylex.props(styles.rows)}>
                {apps.map((app) => {
                  const name = appDisplayName(app)
                  return (
                    <li key={app.id} {...stylex.props(styles.row)}>
                      <button
                        type="button"
                        onClick={() => openApp(app.id)}
                        {...stylex.props(styles.open)}
                      >
                        <span {...stylex.props(styles.name)}>{name}</span>
                        <span {...stylex.props(styles.entity)}>{app.spEntityId}</span>
                        <span {...stylex.props(styles.narrowMeta)}>
                          {gateSummary(app.assignmentGate)}
                        </span>
                      </button>
                      <span {...stylex.props(styles.wide)}>{gateSummary(app.assignmentGate)}</span>
                      <span {...stylex.props(styles.wide)}>
                        <CertificateCell app={app} />
                      </span>
                      <span {...stylex.props(styles.last, !app.lastSignInAt && styles.never)}>
                        {app.lastSignInAt ? (
                          relativeTime(i18n, app.lastSignInAt)
                        ) : (
                          <Trans>No sign-ins yet</Trans>
                        )}
                      </span>
                      <span {...stylex.props(styles.menu)}>
                        <Dropdown
                          ariaLabel={t`Actions for ${name}`}
                          align="end"
                          triggerStyle={list.iconButton}
                          trigger={<Icon name="more-horizontal" size={16} />}
                          items={[
                            {
                              key: 'open',
                              label: <Trans>Open</Trans>,
                              onSelect: () => openApp(app.id),
                            },
                            {
                              key: 'remove',
                              label: <Trans>Remove app…</Trans>,
                              tone: 'danger',
                              disabled: locked,
                              separatorBefore: true,
                              onSelect: () => setRemoving(app),
                            },
                          ]}
                        />
                      </span>
                      <span aria-hidden {...stylex.props(styles.chevron)}>
                        <Icon name="chevron-right" />
                      </span>
                    </li>
                  )
                })}
              </ul>
            </>
          )}
        </section>
      ) : null}
      {adding && orgId ? (
        <OutboundAppDialog
          orgId={orgId}
          app={null}
          onClose={() => setAdding(false)}
          onCreated={(created) => {
            setAdding(false)
            openApp(created.id)
          }}
        />
      ) : null}
      {removing ? (
        <ConfirmDialog
          title={<Trans>Remove {removingName}?</Trans>}
          description={<Trans>People can no longer sign in to {removingName} with XID.</Trans>}
          confirmLabel={<Trans>Remove app</Trans>}
          isLoading={remove.isPending}
          onConfirm={() => remove.mutate(removing.id, { onSettled: () => setRemoving(null) })}
          onCancel={() => setRemoving(null)}
        />
      ) : null}
    </ConsolePage>
  )
}
