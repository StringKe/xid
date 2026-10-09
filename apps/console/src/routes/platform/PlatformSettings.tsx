// 实例设置:宽屏是分节导航 + 全部分节;窄屏先列分节摘要,?section= 进入单个分节。
// 只读状态来自部署变量,页面只显示是否配置齐全,从不显示 secret。

import { Plural, Trans, useLingui } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'
import * as stylex from '@stylexjs/stylex'
import type { PlatformMfaPolicy } from '@xid-kit/types'
import { useManagementErrorMessage } from '@xid-kit/web-ui/api-error-message'
import { LOCALE_LABELS, SUPPORTED_LOCALES, isSupportedLocale } from '@xid-kit/web-ui/locale'
import type { SupportedLocale } from '@xid-kit/web-ui/locale'
import { consoleShell } from '@xid-kit/web-ui/styles/product-surface.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { leading, text, weight } from '@xid-kit/web-ui/styles/scale.stylex'
import { Link, useLocation, useSearchParams } from '@xid-kit/web-ui/tanstack-router'
import {
  Alert,
  Button,
  ConsolePage,
  Icon,
  RadioGroup,
  Select,
  Skeleton,
  useToast,
} from '@xid-kit/web-ui/ui'
import {
  useInstanceSettingsQuery,
  useSigningKeysQuery,
  useUpdateInstanceSettings,
} from './settings-queries'
import type { ConfigurationStatus, InstanceSettings, PlatformSigningKey } from './settings-queries'
import { SigningKeysSection } from './SigningKeysSection'

const NARROW_UP = '@media (min-width: 48rem)'
const SIDEBAR_UP = '@media (min-width: 64rem)'

const SECTION_IDS = [
  'general',
  'signing-keys',
  'sign-in-defaults',
  'bot-protection',
  'email-sending',
  'custom-domains',
  'billing-adapter',
] as const
type SectionId = (typeof SECTION_IDS)[number]

function isSectionId(value: string | null): value is SectionId {
  return (SECTION_IDS as readonly (string | null)[]).includes(value)
}

const styles = stylex.create({
  leadWide: { display: { default: 'none', [NARROW_UP]: 'inline' } },
  leadNarrow: { display: { default: 'inline', [NARROW_UP]: 'none' } },
  layout: {
    display: 'grid',
    gridTemplateColumns: {
      default: 'minmax(0, 1fr)',
      [NARROW_UP]: '10.5rem minmax(0, 1fr)',
      [SIDEBAR_UP]: '12.5rem minmax(0, 40rem)',
    },
    columnGap: { default: 0, [NARROW_UP]: '2rem', [SIDEBAR_UP]: '3rem' },
    alignItems: 'start',
  },
  nav: {
    display: { default: 'none', [NARROW_UP]: 'flex' },
    flexDirection: 'column',
    gap: '0.125rem',
    position: 'sticky',
    top: '1rem',
  },
  navItem: {
    display: 'flex',
    alignItems: 'center',
    minHeight: '2rem',
    paddingInline: '0.625rem',
    borderRadius: tokens['--xid-radius'],
    color: { default: tokens['--xid-muted-foreground'], ':hover': tokens['--xid-fg'] },
    fontSize: text.base,
    textDecoration: 'none',
  },
  navItemActive: {
    backgroundColor: tokens['--xid-muted'],
    color: tokens['--xid-fg'],
  },
  summaryList: {
    display: { default: 'flex', [NARROW_UP]: 'none' },
    flexDirection: 'column',
    margin: 0,
    padding: 0,
    listStyle: 'none',
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
  },
  summaryLink: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
    minHeight: '3rem',
    paddingBlock: '0.5rem',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
    color: tokens['--xid-fg'],
    textDecoration: 'none',
  },
  summaryText: { display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 },
  summaryTitle: { fontSize: text.md, lineHeight: leading.base },
  summaryValue: {
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
    lineHeight: leading.sm,
    overflowWrap: 'anywhere',
  },
  summaryChevron: { color: tokens['--xid-muted-foreground'] },
  backLink: {
    display: { default: 'inline-flex', [NARROW_UP]: 'none' },
    alignItems: 'center',
    gap: '0.25rem',
    marginBottom: '1rem',
    color: tokens['--xid-muted-foreground'],
    fontSize: text.base,
    textDecoration: 'none',
  },
  column: { display: 'flex', flexDirection: 'column', gap: '2.5rem', minWidth: 0 },
  hiddenNarrow: { display: { default: 'none', [NARROW_UP]: 'flex' } },
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
    scrollMarginTop: '1rem',
  },
  sectionHeader: { display: 'flex', flexDirection: 'column', gap: '0.25rem' },
  sectionTitle: {
    margin: 0,
    color: tokens['--xid-fg'],
    fontSize: text.lg,
    fontWeight: weight.display,
    letterSpacing: tokens['--xid-tracking-title'],
    lineHeight: leading.lg,
  },
  sectionDescription: {
    margin: 0,
    color: tokens['--xid-muted-foreground'],
    fontSize: text.base,
    lineHeight: leading.base,
    fontVariantNumeric: 'tabular-nums',
  },
  rows: {
    display: 'flex',
    flexDirection: 'column',
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
  },
  row: {
    display: 'flex',
    flexDirection: { default: 'column', [NARROW_UP]: 'row' },
    gap: { default: '0.25rem', [NARROW_UP]: '1rem' },
    paddingBlock: '0.75rem',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  rowLabel: {
    flexShrink: 0,
    width: { default: 'auto', [NARROW_UP]: '10rem' },
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
    lineHeight: leading.base,
  },
  rowBody: { display: 'flex', flexDirection: 'column', gap: '0.125rem', flex: 1, minWidth: 0 },
  rowValue: {
    color: tokens['--xid-fg'],
    fontSize: text.base,
    lineHeight: leading.base,
    overflowWrap: 'anywhere',
  },
  mono: { fontFamily: tokens['--xid-font-mono'], fontSize: text.sm },
  rowHint: {
    margin: 0,
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
    lineHeight: leading.sm,
  },
  note: {
    margin: 0,
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
    lineHeight: leading.sm,
  },
  statusOn: { color: tokens['--xid-success'], fontWeight: weight.medium },
  statusOff: { color: tokens['--xid-muted-foreground'], fontWeight: weight.regular },
  statusBad: { color: tokens['--xid-danger'], fontWeight: weight.medium },
  accent: { color: tokens['--xid-accent-strong'] },
  inlineForm: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.5rem' },
  formStack: { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '0.75rem' },
})

const STATUS_STYLE: Record<ConfigurationStatus, typeof styles.statusOn> = {
  configured: styles.statusOn,
  not_configured: styles.statusOff,
  misconfigured: styles.statusBad,
}

function useSectionTitles(): Record<SectionId, string> {
  const { t } = useLingui()
  return {
    general: t`General`,
    'signing-keys': t`Signing keys`,
    'sign-in-defaults': t`Sign-in defaults`,
    'bot-protection': t`Bot protection`,
    'email-sending': t`Email sending`,
    'custom-domains': t`Custom domains`,
    'billing-adapter': t`Billing adapter`,
  }
}

function SettingsSection({
  id,
  selected,
  title,
  description,
  children,
}: {
  id: SectionId
  selected: SectionId | null
  title: ReactNode
  description?: ReactNode
  children: ReactNode
}): ReactNode {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      {...stylex.props(styles.section, selected !== null && selected !== id && styles.hiddenNarrow)}
    >
      <div {...stylex.props(styles.sectionHeader)}>
        <h2 id={`${id}-title`} {...stylex.props(styles.sectionTitle)}>
          {title}
        </h2>
        {description ? <p {...stylex.props(styles.sectionDescription)}>{description}</p> : null}
      </div>
      {children}
    </section>
  )
}

function Row({
  label,
  children,
  hint,
}: {
  label: ReactNode
  children: ReactNode
  hint?: ReactNode
}): ReactNode {
  return (
    <div {...stylex.props(styles.row)}>
      <div {...stylex.props(styles.rowLabel)}>{label}</div>
      <div {...stylex.props(styles.rowBody)}>
        <div {...stylex.props(styles.rowValue)}>{children}</div>
        {hint ? <p {...stylex.props(styles.rowHint)}>{hint}</p> : null}
      </div>
    </div>
  )
}

function StatusText({
  status,
  children,
}: {
  status: ConfigurationStatus
  children: ReactNode
}): ReactNode {
  return <span {...stylex.props(STATUS_STYLE[status])}>{children}</span>
}

function GeneralSection({
  settings,
  selected,
}: {
  settings: InstanceSettings
  selected: SectionId | null
}): ReactNode {
  const { t } = useLingui()
  const { notify } = useToast()
  const errorMessage = useManagementErrorMessage()
  const update = useUpdateInstanceSettings()
  const current: SupportedLocale = isSupportedLocale(settings.defaultLocale)
    ? settings.defaultLocale
    : 'en'
  const [locale, setLocale] = useState<SupportedLocale>(current)
  const domain = settings.primaryDomain
  useEffect(() => setLocale(current), [current])

  return (
    <SettingsSection id="general" selected={selected} title={<Trans>General</Trans>}>
      <div {...stylex.props(styles.rows)}>
        <Row
          label={<Trans>Instance name</Trans>}
          hint={
            <Trans>
              Shown in emails and on the status page. Set when the instance was created; not
              editable here.
            </Trans>
          }
        >
          {settings.name}
        </Row>
        <Row
          label={<Trans>Primary domain</Trans>}
          hint={<Trans>Issuer, JWKS and hosted sign-in. Set when the instance was created.</Trans>}
        >
          {domain}
        </Row>
        <Row
          label={<Trans>Mode</Trans>}
          hint={
            settings.mode === 'single_tenant' ? (
              <Trans>
                Every person signs in at {domain}. Stored with the instance record; not editable
                here.
              </Trans>
            ) : (
              <Trans>
                Each organization signs in at its own subdomain of {domain}. Stored with the
                instance record; not editable here.
              </Trans>
            )
          }
        >
          {settings.mode === 'single_tenant' ? (
            <Trans>Single-tenant</Trans>
          ) : (
            <Trans>Multi-tenant</Trans>
          )}
        </Row>
        <Row
          label={<Trans>Fallback language</Trans>}
          hint={
            <Trans>
              Used for API error messages and one-time sign-in code email when the visitor's browser
              language is not supported. The sign-in pages, Console and other email do not use it.
            </Trans>
          }
        >
          <form
            {...stylex.props(styles.inlineForm)}
            onSubmit={(event) => {
              event.preventDefault()
              if (locale === current) return
              update.mutate(
                { defaultLocale: locale },
                { onSuccess: () => notify({ title: t`Fallback language saved` }) },
              )
            }}
          >
            <Select
              aria-label={t`Fallback language`}
              value={locale}
              onChange={(event) => {
                const value = event.target.value
                if (isSupportedLocale(value)) setLocale(value)
              }}
            >
              {SUPPORTED_LOCALES.map((option) => (
                <option key={option} value={option}>
                  {LOCALE_LABELS[option]}
                </option>
              ))}
            </Select>
            <Button
              type="submit"
              variant="secondary"
              isLoading={update.isPending}
              disabled={locale === current}
            >
              <Trans>Save</Trans>
            </Button>
          </form>
        </Row>
        <Row
          label={<Trans>Data residency label</Trans>}
          hint={
            <Trans>
              Recorded at deployment as metadata. It does not move or restrict where data is stored,
              so it cannot be changed here.
            </Trans>
          }
        >
          {settings.dataResidency}
        </Row>
      </div>
      {update.error ? <Alert tone="error">{errorMessage(update.error)}</Alert> : null}
    </SettingsSection>
  )
}

function SignInDefaultsSection({
  settings,
  selected,
}: {
  settings: InstanceSettings
  selected: SectionId | null
}): ReactNode {
  const { t } = useLingui()
  const { notify } = useToast()
  const errorMessage = useManagementErrorMessage()
  const update = useUpdateInstanceSettings()
  const [policy, setPolicy] = useState<PlatformMfaPolicy>(settings.mfaPolicy)
  const { following, total } = settings.orgsFollowingDefaults
  useEffect(() => setPolicy(settings.mfaPolicy), [settings.mfaPolicy])

  return (
    <SettingsSection
      id="sign-in-defaults"
      selected={selected}
      title={<Trans>Sign-in defaults</Trans>}
      description={
        <>
          <Trans>Used by organizations that have not set their own policy.</Trans>{' '}
          <Plural
            value={following}
            one={`# of ${total} follows these defaults.`}
            other={`# of ${total} follow these defaults.`}
          />
        </>
      }
    >
      <form
        {...stylex.props(styles.formStack)}
        onSubmit={(event) => {
          event.preventDefault()
          if (policy === settings.mfaPolicy) return
          update.mutate(
            { mfaPolicy: policy },
            { onSuccess: () => notify({ title: t`Sign-in defaults saved` }) },
          )
        }}
      >
        <RadioGroup
          label={<Trans>Two-step verification</Trans>}
          value={policy}
          onValueChange={(value) => {
            if (value === 'disabled' || value === 'optional' || value === 'required')
              setPolicy(value)
          }}
          options={[
            { value: 'disabled', label: <Trans>Off</Trans> },
            { value: 'optional', label: <Trans>Optional, people choose to add it</Trans> },
            { value: 'required', label: <Trans>Required at next sign-in</Trans> },
          ]}
        />
        <Button type="submit" isLoading={update.isPending} disabled={policy === settings.mfaPolicy}>
          <Trans>Save sign-in defaults</Trans>
        </Button>
      </form>
      {update.error ? <Alert tone="error">{errorMessage(update.error)}</Alert> : null}
    </SettingsSection>
  )
}

function BotProtectionSection({
  settings,
  selected,
}: {
  settings: InstanceSettings
  selected: SectionId | null
}): ReactNode {
  const { status, siteKey } = settings.turnstile
  return (
    <SettingsSection
      id="bot-protection"
      selected={selected}
      title={<Trans>Bot protection</Trans>}
      description={
        <Trans>
          Cloudflare Turnstile on password sign-in, sign-up, password reset and sign-in code
          requests.
        </Trans>
      }
    >
      <div {...stylex.props(styles.rows)}>
        <Row label={<Trans>Status</Trans>}>
          <StatusText status={status}>
            {status === 'configured' ? (
              <Trans>On, site key and secret are both set</Trans>
            ) : status === 'misconfigured' ? (
              <Trans>Only one of the site key and secret is set</Trans>
            ) : (
              <Trans>Off, neither the site key nor the secret is set</Trans>
            )}
          </StatusText>
        </Row>
        {siteKey ? (
          <Row label={<Trans>Site key</Trans>}>
            <span {...stylex.props(styles.mono)}>{siteKey}</span>
          </Row>
        ) : null}
      </div>
      <p {...stylex.props(styles.note)}>
        <Trans>
          Both are set at deployment: the site key as a public variable, the secret as a Workers
          secret. If only one is present, the protected forms stop accepting sign-ins until the
          other is added.
        </Trans>
      </p>
    </SettingsSection>
  )
}

function EmailSendingSection({
  settings,
  selected,
}: {
  settings: InstanceSettings
  selected: SectionId | null
}): ReactNode {
  const { fromAddress, fromName } = settings.emailSending
  const sendingDomain = fromAddress.split('@').at(-1) ?? fromAddress
  return (
    <SettingsSection
      id="email-sending"
      selected={selected}
      title={<Trans>Email sending</Trans>}
      description={
        <Trans>
          Sign-in codes, invitations and password reset email go out through Cloudflare Email
          Service.
        </Trans>
      }
    >
      <div {...stylex.props(styles.rows)}>
        <Row label={<Trans>Sender</Trans>}>
          {fromName} <span {...stylex.props(styles.statusOff)}>{fromAddress}</span>
        </Row>
        <Row
          label={<Trans>Sending domain</Trans>}
          hint={
            <Trans>
              Needs DKIM, SPF and DMARC records before Cloudflare delivers mail from it.
            </Trans>
          }
        >
          {sendingDomain}
        </Row>
      </div>
      <p {...stylex.props(styles.note)}>
        <Trans>Set at deployment with the EMAIL_FROM_ADDRESS and EMAIL_FROM_NAME variables.</Trans>
      </p>
    </SettingsSection>
  )
}

function CustomDomainsSection({
  settings,
  selected,
}: {
  settings: InstanceSettings
  selected: SectionId | null
}): ReactNode {
  const { status, cnameTarget } = settings.customDomains
  return (
    <SettingsSection
      id="custom-domains"
      selected={selected}
      title={<Trans>Custom domains</Trans>}
      description={
        <Trans>Organizations can sign in at their own hostname through Cloudflare for SaaS.</Trans>
      }
    >
      <div {...stylex.props(styles.rows)}>
        <Row label={<Trans>Status</Trans>}>
          <StatusText status={status}>
            {status === 'configured' ? (
              <Trans>Connected to Cloudflare for SaaS</Trans>
            ) : status === 'misconfigured' ? (
              <Trans>
                The zone ID or API token is missing, so new custom domains cannot be added
              </Trans>
            ) : (
              <Trans>Off, Cloudflare for SaaS is not set up</Trans>
            )}
          </StatusText>
        </Row>
        {status !== 'not_configured' ? (
          <Row
            label={<Trans>CNAME target</Trans>}
            hint={
              cnameTarget ? undefined : (
                <Trans>
                  Not set. Customers point their CNAME record at the zone's fallback origin.
                </Trans>
              )
            }
          >
            {cnameTarget ? (
              <span {...stylex.props(styles.mono)}>{cnameTarget}</span>
            ) : (
              <Trans>Fallback origin</Trans>
            )}
          </Row>
        ) : null}
      </div>
      <p {...stylex.props(styles.note)}>
        <Trans>
          Set at deployment: the zone ID and CNAME target as variables, the API token as a Workers
          secret.
        </Trans>
      </p>
    </SettingsSection>
  )
}

function BillingAdapterSection({
  settings,
  selected,
}: {
  settings: InstanceSettings
  selected: SectionId | null
}): ReactNode {
  const { status } = settings.billingAdapter
  return (
    <SettingsSection
      id="billing-adapter"
      selected={selected}
      title={<Trans>Billing adapter</Trans>}
      description={
        <Trans>
          Reports monthly active users to Stripe as metered usage. With the adapter off, every
          feature stays available.
        </Trans>
      }
    >
      <div {...stylex.props(styles.rows)}>
        <Row label={<Trans>Status</Trans>}>
          <StatusText status={status}>
            {status === 'configured' ? (
              <Trans>On, monthly active users are reported to Stripe</Trans>
            ) : status === 'misconfigured' ? (
              <Trans>Some Stripe settings are missing, so no usage is reported</Trans>
            ) : (
              <Trans>Off, Stripe is not configured</Trans>
            )}
          </StatusText>
        </Row>
      </div>
      <p {...stylex.props(styles.note)}>
        <Trans>
          Set at deployment: the Stripe secret key and webhook secret as Workers secrets, the meter
          event name as a variable. All three are needed.
        </Trans>
      </p>
    </SettingsSection>
  )
}

function useSectionSummaries(
  settings: InstanceSettings,
  keys: readonly PlatformSigningKey[] | undefined,
): Record<SectionId, ReactNode> {
  const { t } = useLingui()
  const domain = settings.primaryDomain
  const next = keys?.find((key) => key.status === 'next')
  const active = keys?.find((key) => key.status === 'active')
  const nextReady =
    next?.activatableAt !== null && next !== undefined && (next.activatableAt ?? 0) <= Date.now()
  const mfaLabel: Record<PlatformMfaPolicy, string> = {
    disabled: t`Two-step verification off`,
    optional: t`Two-step verification optional`,
    required: t`Two-step verification required`,
  }
  const statusLabel = (status: ConfigurationStatus, on: string, off: string): ReactNode => (
    <StatusText status={status}>
      {status === 'misconfigured' ? t`Partly configured` : status === 'configured' ? on : off}
    </StatusText>
  )
  return {
    general:
      settings.mode === 'single_tenant' ? t`${domain}, single-tenant` : t`${domain}, multi-tenant`,
    'signing-keys': nextReady ? (
      <span {...stylex.props(styles.accent)}>{t`Next key ready to make active`}</span>
    ) : active ? (
      t`Active key ${active.kid}`
    ) : null,
    'sign-in-defaults': mfaLabel[settings.mfaPolicy],
    'bot-protection': statusLabel(settings.turnstile.status, t`On`, t`Off`),
    'email-sending': t`From ${settings.emailSending.fromAddress}`,
    'custom-domains': statusLabel(
      settings.customDomains.status,
      t`Cloudflare for SaaS connected`,
      t`Off`,
    ),
    'billing-adapter': statusLabel(
      settings.billingAdapter.status,
      t`Stripe metered MAU on`,
      t`Stripe not configured`,
    ),
  }
}

function SectionSummaryList({
  settings,
  keys,
  pathname,
}: {
  settings: InstanceSettings
  keys: readonly PlatformSigningKey[] | undefined
  pathname: string
}): ReactNode {
  const titles = useSectionTitles()
  const summaries = useSectionSummaries(settings, keys)
  return (
    <ul {...stylex.props(styles.summaryList)}>
      {SECTION_IDS.map((id) => (
        <li key={id}>
          <Link to={`${pathname}?section=${id}`} {...stylex.props(styles.summaryLink)}>
            <span {...stylex.props(styles.summaryText)}>
              <span {...stylex.props(styles.summaryTitle)}>{titles[id]}</span>
              <span {...stylex.props(styles.summaryValue)}>{summaries[id]}</span>
            </span>
            <span {...stylex.props(styles.summaryChevron)}>
              <Icon name="chevron-right" size={16} />
            </span>
          </Link>
        </li>
      ))}
    </ul>
  )
}

function SectionNav({
  selected,
  pathname,
}: {
  selected: SectionId | null
  pathname: string
}): ReactNode {
  const { t } = useLingui()
  const titles = useSectionTitles()
  const current = selected ?? 'general'
  return (
    <nav aria-label={t`Settings sections`} {...stylex.props(styles.nav)}>
      {SECTION_IDS.map((id) => (
        <Link
          key={id}
          to={`${pathname}?section=${id}`}
          replace
          aria-current={id === current ? 'true' : undefined}
          {...stylex.props(styles.navItem, id === current && styles.navItemActive)}
        >
          {titles[id]}
        </Link>
      ))}
    </nav>
  )
}

export default function PlatformSettingsPage(): ReactNode {
  const settingsQuery = useInstanceSettingsQuery()
  const keysQuery = useSigningKeysQuery()
  const [params] = useSearchParams()
  const { pathname } = useLocation()
  const requested = params.get('section')
  const selected = isSectionId(requested) ? requested : null
  const settings = settingsQuery.data
  const domain = settings?.primaryDomain ?? ''
  const keys = keysQuery.data?.data
  const signingAlg = keys?.find((key) => key.status === 'active')?.alg ?? keys?.[0]?.alg ?? 'ES256'

  const isLoaded = settings !== undefined
  useEffect(() => {
    if (!selected || !isLoaded) return
    const target = globalThis.document.getElementById(selected)
    if (globalThis.matchMedia?.('(min-width: 48rem)').matches)
      target?.scrollIntoView({ block: 'start' })
    else globalThis.scrollTo({ top: 0 })
  }, [selected, isLoaded])

  return (
    <ConsolePage
      title={<Trans>Instance settings</Trans>}
      lead={
        settings ? (
          <>
            <span {...stylex.props(styles.leadWide)}>
              <Trans>
                Settings that apply to every organization on {domain}. Each section saves on its
                own.
              </Trans>
            </span>
            <span {...stylex.props(styles.leadNarrow)}>
              <Trans>
                Settings for every organization on {domain}. Open a section to change it.
              </Trans>
            </span>
          </>
        ) : undefined
      }
    >
      {settingsQuery.isError ? (
        <Alert tone="error">
          <Trans>Failed to load instance settings.</Trans>
        </Alert>
      ) : !settings ? (
        <Skeleton height="20rem" />
      ) : (
        <div {...stylex.props(consoleShell.sectionPad, styles.layout)}>
          <SectionNav selected={selected} pathname={pathname} />
          {selected === null ? (
            <SectionSummaryList settings={settings} keys={keys} pathname={pathname} />
          ) : null}
          <div {...stylex.props(styles.column, selected === null && styles.hiddenNarrow)}>
            {selected !== null ? (
              <Link to={pathname} {...stylex.props(styles.backLink)}>
                <Icon name="chevron-left" size={16} />
                <Trans>All settings</Trans>
              </Link>
            ) : null}
            <GeneralSection settings={settings} selected={selected} />
            <SettingsSection
              id="signing-keys"
              selected={selected}
              title={<Trans>Signing keys</Trans>}
              description={
                <Trans>
                  {signingAlg} keys that sign every token on {domain}. A new key is published
                  automatically every 90 days; making it the active key is up to you, after apps
                  have refreshed their key cache (1 hour).
                </Trans>
              }
            >
              <SigningKeysSection
                keys={keys}
                isLoading={keysQuery.isPending}
                isError={keysQuery.isError}
              />
            </SettingsSection>
            <SignInDefaultsSection settings={settings} selected={selected} />
            <BotProtectionSection settings={settings} selected={selected} />
            <EmailSendingSection settings={settings} selected={selected} />
            <CustomDomainsSection settings={settings} selected={selected} />
            <BillingAdapterSection settings={settings} selected={selected} />
          </div>
        </div>
      )}
    </ConsolePage>
  )
}
