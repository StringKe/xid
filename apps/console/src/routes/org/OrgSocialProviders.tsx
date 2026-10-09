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
  Icon,
  Spinner,
} from '@xid-kit/web-ui/ui'
import { ConfirmDialog } from '@xid-kit/web-ui/ConfirmDialog'
import { consoleShell, page } from '@xid-kit/web-ui/styles/product-surface.stylex'
import { leading, text, weight } from '@xid-kit/web-ui/styles/scale.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { formatDate } from '../../lib/date-format'
import { useOrgSelfServiceLocked, useOrgTarget } from './useOrgTarget'
import { SelfServiceLockNotice } from './SelfServiceLock'
import { useUpdateOrgSocialProviders } from './queries'
import { useOrgSocialProvidersView } from './auth-queries'
import type { SocialProviderView } from './auth-queries'
import { SocialProviderDialog } from './SocialProviderDialog'
import {
  EMPTY_SOCIAL_PROVIDER,
  KNOWN_SOCIAL_PROVIDERS,
  SOCIAL_PROVIDER_TEMPLATES,
  isKnownProvider,
  providerMonogram,
  providerName,
} from './social-provider-presets'
import type { OrgSocialProviderPolicy } from './types'

const WIDE = '@media (min-width: 48rem)'

const styles = stylex.create({
  table: {
    maxWidth: '54rem',
    fontFamily: tokens['--xid-font'],
  },
  head: {
    display: { default: 'none', [WIDE]: 'grid' },
    gridTemplateColumns: 'minmax(0, 1fr) 8rem 9rem 6.5rem',
    gap: '1rem',
    paddingBottom: '0.625rem',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
  },
  numberHead: {
    textAlign: 'end',
  },
  row: {
    display: 'grid',
    gridTemplateColumns: {
      default: 'minmax(0, 1fr) auto',
      [WIDE]: 'minmax(0, 1fr) 8rem 9rem 6.5rem',
    },
    alignItems: 'center',
    gap: '1rem',
    minHeight: { default: '4.25rem', [WIDE]: '3rem' },
    paddingBlock: '0.375rem',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  rowButton: {
    appearance: 'none',
    margin: 0,
    padding: 0,
    borderWidth: 0,
    width: '100%',
    textAlign: 'start',
    backgroundColor: 'transparent',
    color: 'inherit',
    font: 'inherit',
    cursor: 'pointer',
  },
  provider: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
    minWidth: 0,
  },
  monogram: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    width: '2rem',
    height: '2rem',
    borderRadius: tokens['--xid-radius'],
    backgroundColor: tokens['--xid-muted'],
    color: tokens['--xid-fg'],
    fontSize: text.sm,
    fontWeight: weight.medium,
  },
  providerText: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.125rem',
    minWidth: 0,
  },
  name: {
    color: tokens['--xid-fg'],
    fontSize: { default: text.md, [WIDE]: text.base },
    fontWeight: weight.medium,
    lineHeight: leading.sm,
  },
  detail: {
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
    lineHeight: leading.sm,
    overflowWrap: 'anywhere',
  },
  wideOnly: {
    display: { default: 'none', [WIDE]: 'flex' },
  },
  wideDetail: {
    display: { default: 'none', [WIDE]: 'block' },
  },
  narrowDetail: {
    display: { default: 'block', [WIDE]: 'none' },
  },
  narrowOnly: {
    display: { default: 'inline-flex', [WIDE]: 'none' },
    color: tokens['--xid-muted-foreground'],
  },
  count: {
    justifyContent: 'flex-end',
    color: tokens['--xid-fg'],
    fontSize: text.base,
    fontVariantNumeric: 'tabular-nums',
  },
  action: {
    justifyContent: 'flex-end',
  },
  muted: {
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
  },
  footer: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: '1rem',
    maxWidth: '54rem',
    paddingTop: '1.5rem',
  },
  note: {
    margin: 0,
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
    lineHeight: leading.base,
  },
})

type Row = { key: string; policy: SocialProviderView | null }

function useProviderDescription(): (row: Row) => ReactNode {
  const { i18n } = useLingui()
  return ({ key, policy }) => {
    if (!policy) {
      if (key === 'google') return <Trans>Needs an OAuth client from Google Cloud Console</Trans>
      if (key === 'microsoft')
        return <Trans>Personal accounts only. Work accounts use Enterprise SSO.</Trans>
      if (key === 'github') return <Trans>Needs an OAuth app from GitHub developer settings</Trans>
      return <Trans>Needs a Services ID and a signing key from Apple Developer</Trans>
    }
    if (!policy.enabled && policy.disabledAt) {
      const date = formatDate(i18n, policy.disabledAt)
      return <Trans>Turned off {date}</Trans>
    }
    if (!policy.credentialsReady) {
      return <Trans>Client ID or the secret set by your instance operator is missing</Trans>
    }
    const scopes = policy.scopes.join(', ')
    return <Trans>Asks for {scopes}</Trans>
  }
}

function StatusBadge({ policy }: { policy: SocialProviderView | null }): ReactNode {
  if (!policy) return <span {...stylex.props(styles.muted)}>{<Trans>Not set up</Trans>}</span>
  if (policy.enabled && !policy.credentialsReady) {
    return (
      <Badge tone="warning">
        <Trans>Needs setup</Trans>
      </Badge>
    )
  }
  return policy.enabled ? (
    <Badge tone="success">
      <Trans>On</Trans>
    </Badge>
  ) : (
    <Badge tone="neutral">
      <Trans>Off</Trans>
    </Badge>
  )
}

function NarrowSummary({ policy }: { policy: SocialProviderView | null }): ReactNode {
  const { i18n } = useLingui()
  if (!policy) return <Trans>Not set up</Trans>
  if (!policy.enabled) {
    const date = formatDate(i18n, policy.disabledAt)
    return date ? <Trans>Off since {date}</Trans> : <Trans>Off</Trans>
  }
  return (
    <Plural
      value={policy.signIns30d}
      one="On, # person signed in over 30 days"
      other="On, # people signed in over 30 days"
    />
  )
}

export default function OrgSocialProvidersPage(): ReactNode {
  const { t, i18n } = useLingui()
  const locked = useOrgSelfServiceLocked()
  const { orgId, orgName } = useOrgTarget()
  const { data, isLoading, isError } = useOrgSocialProvidersView(orgId)
  const update = useUpdateOrgSocialProviders(orgId)
  const describe = useProviderDescription()
  const [editing, setEditing] = useState<string | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const title = <Trans>Social login</Trans>

  if (!orgId) {
    return (
      <ConsolePage title={title}>
        <ConsolePageNotice>
          <Alert tone="info">
            <Trans>No organization selected.</Trans>
          </Alert>
        </ConsolePageNotice>
      </ConsolePage>
    )
  }

  const configured = data?.socialProviders ?? {}
  const rows: Row[] = [
    ...KNOWN_SOCIAL_PROVIDERS.map((key) => ({ key, policy: configured[key] ?? null })),
    ...Object.keys(configured)
      .filter((key) => !isKnownProvider(key))
      .map((key) => ({ key, policy: configured[key] ?? null })),
  ]

  function baseProviders(): Record<string, OrgSocialProviderPolicy> {
    return { ...configured }
  }

  function save(key: string, policy: OrgSocialProviderPolicy): void {
    update.mutate(
      { socialProviders: { ...baseProviders(), [key]: policy } },
      { onSuccess: () => setEditing(null) },
    )
  }

  function remove(key: string): void {
    const next = baseProviders()
    delete next[key]
    update.mutate(
      { socialProviders: next },
      {
        onSuccess: () => {
          setRemoving(null)
          setEditing(null)
        },
      },
    )
  }

  const removingName = removing ? providerName(removing) : ''
  const editingPolicy = editing
    ? (configured[editing] ??
      (isKnownProvider(editing) ? SOCIAL_PROVIDER_TEMPLATES[editing] : EMPTY_SOCIAL_PROVIDER))
    : null

  return (
    <ConsolePage
      title={title}
      lead={
        <Trans>
          Buttons on the {orgName} sign-in page for people who sign in with a personal account.
        </Trans>
      }
    >
      {locked || isError ? (
        <ConsolePageNotice>
          {locked ? <SelfServiceLockNotice /> : null}
          {isError ? (
            <Alert tone="error">
              <Trans>
                Social login settings could not be loaded. Reload the page to try again.
              </Trans>
            </Alert>
          ) : null}
        </ConsolePageNotice>
      ) : null}
      {!data ? (
        isLoading ? (
          <div {...stylex.props(consoleShell.sectionPad)}>
            <Spinner label={t`Loading social login`} />
          </div>
        ) : null
      ) : (
        <>
          <div role="table" aria-label={t`Social login providers`} {...stylex.props(styles.table)}>
            <div role="row" {...stylex.props(styles.head)}>
              <span role="columnheader">
                <Trans>Provider</Trans>
              </span>
              <span role="columnheader">
                <Trans>Status</Trans>
              </span>
              <span role="columnheader" {...stylex.props(styles.numberHead)}>
                <Trans>People, last 30 days</Trans>
              </span>
              <span role="columnheader">
                <span {...stylex.props(page.visuallyHidden)}>{t`Actions`}</span>
              </span>
            </div>
            {rows.map((row) => {
              const name = providerName(row.key)
              return (
                <div role="row" key={row.key} {...stylex.props(styles.row)}>
                  <button
                    type="button"
                    role="cell"
                    disabled={locked}
                    onClick={() => setEditing(row.key)}
                    {...stylex.props(styles.rowButton, styles.provider)}
                  >
                    <span aria-hidden {...stylex.props(styles.monogram)}>
                      {providerMonogram(row.key)}
                    </span>
                    <span {...stylex.props(styles.providerText)}>
                      <span {...stylex.props(styles.name)}>{name}</span>
                      <span {...stylex.props(styles.detail, styles.wideDetail)}>
                        {describe(row)}
                      </span>
                      <span {...stylex.props(styles.detail, styles.narrowDetail)}>
                        <NarrowSummary policy={row.policy} />
                      </span>
                    </span>
                  </button>
                  <span role="cell" {...stylex.props(styles.wideOnly)}>
                    <StatusBadge policy={row.policy} />
                  </span>
                  <span role="cell" {...stylex.props(styles.wideOnly, styles.count)}>
                    {row.policy ? i18n.number(row.policy.signIns30d) : null}
                  </span>
                  <span role="cell" {...stylex.props(styles.wideOnly, styles.action)}>
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={locked}
                      onClick={() => setEditing(row.key)}
                    >
                      {row.policy ? <Trans>Configure…</Trans> : <Trans>Set up…</Trans>}
                    </Button>
                  </span>
                  <span aria-hidden {...stylex.props(styles.narrowOnly)}>
                    <Icon name="chevron-right" />
                  </span>
                </div>
              )
            })}
          </div>
          <div {...stylex.props(styles.footer)}>
            <p {...stylex.props(styles.note)}>
              <Trans>
                When someone signs in with a provider using an email that already has a {orgName}{' '}
                account, XID asks them to prove they own that account before linking the two.
              </Trans>
            </p>
          </div>
        </>
      )}
      {editing && editingPolicy ? (
        <SocialProviderDialog
          providerKey={editing}
          initial={editingPolicy}
          isNew={!configured[editing]}
          isPending={update.isPending}
          error={update.error}
          onSave={(policy) => save(editing, policy)}
          onRemove={() => setRemoving(editing)}
          onClose={() => {
            update.reset()
            setEditing(null)
          }}
        />
      ) : null}
      {removing ? (
        <ConfirmDialog
          title={<Trans>Remove {removingName}?</Trans>}
          description={
            <Trans>
              The {removingName} button disappears from the sign-in page. People who signed in with
              it keep their accounts and can use another method.
            </Trans>
          }
          confirmLabel={<Trans>Remove</Trans>}
          isLoading={update.isPending}
          onConfirm={() => remove(removing)}
          onCancel={() => setRemoving(null)}
        />
      ) : null}
    </ConsolePage>
  )
}
