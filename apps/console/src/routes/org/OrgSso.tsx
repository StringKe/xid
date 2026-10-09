// /console/org/sso:一个组织最多一个企业连接。无连接显示首次为空,有连接直接显示详情;
// ?step=new|metadata|domains 进入新建向导的三步。

import { Trans, useLingui } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Alert, Button, ConsolePage, ConsolePageNotice, Icon, Spinner } from '@xid-kit/web-ui/ui'
import { useLocation, useNavigate, useSearchParams } from '@xid-kit/web-ui/tanstack-router'
import { consoleShell } from '@xid-kit/web-ui/styles/product-surface.stylex'
import { leading, text, weight } from '@xid-kit/web-ui/styles/scale.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { DOCS_URL } from '../../components/layout/ConsoleTopBar'
import { useOrgSelfServiceLocked, useOrgTarget } from './useOrgTarget'
import { SelfServiceLockNotice } from './SelfServiceLock'
import { useOrgSsoConnectionsView } from './auth-queries'
import { SsoConnectionDetail } from './SsoConnectionDetail'
import {
  SsoDomainsStep,
  SsoMetadataStep,
  SsoProviderStep,
  WizardBreadcrumb,
} from './SsoConnectionCreate'

const SSO_PATH = '/console/org/sso'

const styles = stylex.create({
  empty: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
    maxWidth: '40rem',
    paddingTop: '1.5rem',
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
    fontFamily: tokens['--xid-font'],
  },
  emptyTitle: {
    margin: 0,
    color: tokens['--xid-fg'],
    fontSize: text.lg,
    lineHeight: leading.lg,
    fontWeight: weight.display,
    letterSpacing: tokens['--xid-tracking-title'],
  },
  emptyText: {
    margin: 0,
    color: tokens['--xid-muted-foreground'],
    fontSize: text.base,
    lineHeight: leading.base,
  },
  steps: {
    margin: 0,
    padding: 0,
    listStyle: 'none',
  },
  step: {
    display: 'flex',
    alignItems: 'baseline',
    gap: '1rem',
    paddingBlock: '0.75rem',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
    color: tokens['--xid-fg'],
    fontSize: text.base,
    lineHeight: leading.base,
  },
  stepNumber: {
    flexShrink: 0,
    width: '1rem',
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
    fontVariantNumeric: 'tabular-nums',
  },
  actions: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '1rem',
    paddingTop: '0.5rem',
  },
  link: {
    color: tokens['--xid-accent'],
    fontSize: text.sm,
    fontWeight: weight.medium,
    textDecoration: 'none',
  },
})

function FirstRun({ locked, onAdd }: { locked: boolean; onAdd: () => void }): ReactNode {
  return (
    <section aria-labelledby="sso-empty-title" {...stylex.props(styles.empty)}>
      <h2 id="sso-empty-title" {...stylex.props(styles.emptyTitle)}>
        <Trans>No enterprise connections yet</Trans>
      </h2>
      <p {...stylex.props(styles.emptyText)}>
        <Trans>
          Connect a company&apos;s Okta, Microsoft Entra ID or other identity provider. People with
          an email at that company&apos;s domain then skip the password and sign in through their
          own provider.
        </Trans>
      </p>
      <ol {...stylex.props(styles.steps)}>
        <li {...stylex.props(styles.step)}>
          <span {...stylex.props(styles.stepNumber)}>1</span>
          <Trans>Pick the provider and protocol, SAML 2.0 or OpenID Connect</Trans>
        </li>
        <li {...stylex.props(styles.step)}>
          <span {...stylex.props(styles.stepNumber)}>2</span>
          <Trans>Swap metadata with the company&apos;s IT admin</Trans>
        </li>
        <li {...stylex.props(styles.step)}>
          <span {...stylex.props(styles.stepNumber)}>3</span>
          <Trans>Verify their email domain with a DNS record, then turn on routing</Trans>
        </li>
      </ol>
      <div {...stylex.props(styles.actions)}>
        <Button type="button" disabled={locked} onClick={onAdd}>
          <Icon name="plus" size={14} />
          <Trans>Add connection</Trans>
        </Button>
        <a
          href={`${DOCS_URL}/enterprise-sso`}
          target="_blank"
          rel="noreferrer"
          {...stylex.props(styles.link)}
        >
          <Trans>Read the enterprise SSO guide</Trans>
        </a>
      </div>
    </section>
  )
}

export default function OrgSso(): ReactNode {
  const { t } = useLingui()
  const locked = useOrgSelfServiceLocked()
  const { orgId, orgName } = useOrgTarget()
  const [params] = useSearchParams()
  const location = useLocation()
  const navigate = useNavigate()
  const { data, isLoading, isError } = useOrgSsoConnectionsView(orgId)
  const step = params.get('step')
  const connection = data?.[0] ?? null
  const title = <Trans>Enterprise SSO</Trans>
  const lead = (
    <Trans>
      Company identity providers. When someone enters an email at a routed domain, XID sends them
      straight to that provider.
    </Trans>
  )

  function goStep(next: string | null): void {
    navigate(next ? `${location.pathname}?step=${next}` : SSO_PATH)
  }

  if (!orgId || !data) {
    return (
      <ConsolePage title={title} lead={lead}>
        <ConsolePageNotice>
          {!orgId ? (
            <Alert tone="info">
              <Trans>No organization selected.</Trans>
            </Alert>
          ) : null}
          {isError ? (
            <Alert tone="error">
              <Trans>Enterprise SSO could not be loaded. Reload the page to try again.</Trans>
            </Alert>
          ) : null}
        </ConsolePageNotice>
        {isLoading ? (
          <div {...stylex.props(consoleShell.sectionPad)}>
            <Spinner label={t`Loading enterprise SSO`} />
          </div>
        ) : null}
      </ConsolePage>
    )
  }

  const lockNotice = locked ? (
    <ConsolePageNotice>
      <SelfServiceLockNotice />
    </ConsolePageNotice>
  ) : null

  if (!connection && step === 'new') {
    return (
      <div {...stylex.props(consoleShell.root)}>
        <div {...stylex.props(consoleShell.contentCap)}>
          <WizardBreadcrumb current={<Trans>Add connection</Trans>} />
          {lockNotice}
          <div {...stylex.props(consoleShell.sectionPad)}>
            <SsoProviderStep
              orgId={orgId}
              orgName={orgName}
              locked={locked}
              onCreated={() => goStep('metadata')}
              onCancel={() => goStep(null)}
            />
          </div>
        </div>
      </div>
    )
  }

  if (connection && (step === 'metadata' || step === 'domains')) {
    return (
      <div {...stylex.props(consoleShell.root)}>
        <div {...stylex.props(consoleShell.contentCap)}>
          <WizardBreadcrumb current={<Trans>Add connection</Trans>} />
          {lockNotice}
          <div {...stylex.props(consoleShell.sectionPad)}>
            {step === 'metadata' ? (
              <SsoMetadataStep
                orgId={orgId}
                connection={connection}
                locked={locked}
                onNext={() => goStep('domains')}
              />
            ) : (
              <SsoDomainsStep connection={connection} onFinish={() => goStep(null)} />
            )}
          </div>
        </div>
      </div>
    )
  }

  if (connection) {
    return (
      <>
        {lockNotice}
        <SsoConnectionDetail orgId={orgId} connection={connection} locked={locked} />
      </>
    )
  }

  return (
    <ConsolePage title={title} lead={lead}>
      {lockNotice}
      <FirstRun locked={locked} onAdd={() => goStep('new')} />
    </ConsolePage>
  )
}
