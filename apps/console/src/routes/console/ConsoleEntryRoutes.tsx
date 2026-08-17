import { Trans, useLingui } from '@lingui/react/macro'
import { useEffect } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Link, Navigate, useNavigate } from '@xid-kit/web-ui/tanstack-router'
import {
  Button,
  ConsolePage,
  ConsolePageSection,
  EmptyState,
  Icon,
  Spinner,
} from '@xid-kit/web-ui/ui'
import { useAuth } from '@xid-kit/web-ui/session'
import type { AuthOrg } from '@xid-kit/web-ui/session'
import { organizationDisplayName } from '@xid-kit/web-ui/display-names'
import { isOrgManagerRole } from '@xid-kit/web-ui/org-route-access'
import { consoleShell, page } from '@xid-kit/web-ui/styles/product-surface.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { ORG_NAV } from '../../nav'
import type { ConsoleNavItem } from '../../nav'

const styles = stylex.create({
  primaryLink: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: '2.5rem',
    paddingBlock: 0,
    paddingInline: '1rem',
    borderRadius: tokens['--xid-radius'],
    backgroundColor: tokens['--xid-primary'],
    color: tokens['--xid-primary-foreground'],
    fontSize: '0.875rem',
    fontWeight: 600,
    textDecoration: 'none',
    // 0.25s 对齐 springPress 预算,与按压微交互同口径。
    transitionProperty: 'opacity',
    transitionDuration: '0.25s',
    transitionTimingFunction: 'ease-out',
    ':hover': {
      opacity: 0.88,
    },
    ':focus-visible': {
      outlineStyle: 'solid',
      outlineWidth: '2px',
      outlineOffset: '2px',
      outlineColor: tokens['--xid-primary'],
    },
  },
  orgList: {
    listStyle: 'none',
    margin: 0,
    padding: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
    maxWidth: '40rem',
  },
  // 行而非卡:列表语义;hover 抬升 1px + shadow-sm,等同 Button 的 0.12s 过渡口径。
  orgRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
    paddingBlock: '0.625rem',
    paddingInline: '0.75rem',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: tokens['--xid-border'],
    borderRadius: tokens['--xid-radius'],
    backgroundColor: tokens['--xid-surface'],
    transitionProperty: {
      default: 'transform, box-shadow, border-color',
      '@media (prefers-reduced-motion: reduce)': 'none',
    },
    transitionDuration: '0.12s',
    transitionTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)',
    ':hover': {
      transform: 'translateY(-1px)',
      boxShadow: tokens['--xid-shadow-sm'],
      borderColor: tokens['--xid-border-strong'],
    },
  },
  orgAvatar: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '2rem',
    height: '2rem',
    flexShrink: 0,
    borderRadius: tokens['--xid-radius-sm'],
    backgroundColor: tokens['--xid-accent'],
    color: tokens['--xid-primary-foreground'],
    fontSize: '0.8125rem',
    fontWeight: 650,
    textTransform: 'uppercase',
  },
  orgText: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.125rem',
    minWidth: 0,
    flexGrow: 1,
  },
  orgName: {
    fontSize: '0.875rem',
    fontWeight: 600,
    color: tokens['--xid-fg'],
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  orgSlug: {
    fontFamily: tokens['--xid-font-mono'],
    fontSize: '0.6875rem',
    letterSpacing: '0.04em',
    color: tokens['--xid-muted-foreground'],
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  settingsList: {
    listStyle: 'none',
    margin: 0,
    padding: 0,
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
  },
  settingsItem: {
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  settingsRow: {
    display: 'grid',
    gridTemplateColumns: 'auto minmax(0, 1fr) auto',
    alignItems: 'center',
    gap: '0.875rem',
    minHeight: '4.75rem',
    paddingBlock: '0.875rem',
    paddingInline: '0.25rem',
    color: tokens['--xid-fg'],
    textDecoration: 'none',
    backgroundColor: {
      default: 'transparent',
      ':hover': tokens['--xid-muted'],
      ':focus-visible': tokens['--xid-muted'],
    },
    transitionProperty: 'background-color',
    transitionDuration: '0.12s',
    transitionTimingFunction: 'ease-out',
    outlineOffset: '2px',
    outlineColor: tokens['--xid-primary'],
  },
  settingsCopy: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.25rem',
    minWidth: 0,
  },
  settingsCardIcon: {
    display: 'inline-flex',
    flexShrink: 0,
    color: tokens['--xid-muted-foreground'],
  },
  settingsCardDescription: {
    margin: 0,
    fontSize: '0.8125rem',
    lineHeight: 1.5,
    color: tokens['--xid-muted-foreground'],
  },
  navArrow: {
    display: 'inline-flex',
    flexShrink: 0,
    color: tokens['--xid-muted-foreground'],
  },
})

type EntryTarget = 'home' | 'organizations' | 'users' | 'settings'

function orgTargetPath(target: EntryTarget): string {
  if (target === 'users') return '/console/org/members'
  if (target === 'settings') return '/console/settings'
  return '/console/org'
}

export function orgSelectionTarget(destination: string, org: AuthOrg): string {
  if (!destination.startsWith('/console/org')) return destination
  const params = new URLSearchParams({ orgId: org.id })
  return `${destination}?${params.toString()}`
}

// 首字母方块取原始 name/slug;displayName 可能是 Trans 节点,取不出字符。
function orgInitial(org: AuthOrg): string {
  const letter = (org.name ?? org.slug ?? '').trim().charAt(0)
  return letter ? letter.toUpperCase() : '?'
}

type OrganizationSelectionProps = {
  target: EntryTarget
  organizations: readonly AuthOrg[]
}

function OrganizationSelection({ target, organizations }: OrganizationSelectionProps): ReactNode {
  const { setActiveOrganization } = useAuth()
  const navigate = useNavigate()
  const destination = orgTargetPath(target)

  return (
    <ConsolePage
      title={<Trans>Select organization</Trans>}
      lead={<Trans>Choose an organization to continue in the console.</Trans>}
    >
      <ConsolePageSection>
        <ul {...stylex.props(styles.orgList)}>
          {organizations.map((org) => (
            <li key={org.id} {...stylex.props(styles.orgRow)}>
              <span aria-hidden="true" {...stylex.props(styles.orgAvatar)}>
                {orgInitial(org)}
              </span>
              <span {...stylex.props(styles.orgText)}>
                <span {...stylex.props(styles.orgName)}>{organizationDisplayName(org)}</span>
                <span {...stylex.props(styles.orgSlug)}>{org.slug}</span>
              </span>
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  void setActiveOrganization(org.id).then((ok) => {
                    if (ok) navigate(orgSelectionTarget(destination, org), { replace: true })
                  })
                }}
              >
                <Trans>Open</Trans>
              </Button>
            </li>
          ))}
        </ul>
      </ConsolePageSection>
    </ConsolePage>
  )
}

function EmptyOrganizationState(): ReactNode {
  return (
    <ConsolePage title={<Trans>Organizations</Trans>}>
      <ConsolePageSection>
        <EmptyState
          title={<Trans>No organization access</Trans>}
          description={
            <Trans>
              An organization is where you register OAuth applications, invite members, and turn on
              enterprise SSO or directory sync. Create one to get your first issuer and managed
              sign-in pages.
            </Trans>
          }
          action={
            <a href="/create-organization" {...stylex.props(styles.primaryLink)}>
              <Trans>Create organization</Trans>
            </a>
          }
        />
      </ConsolePageSection>
    </ConsolePage>
  )
}

// Settings 从 ORG_NAV 派生,图标与信息架构同源。
const SETTINGS_DESCRIPTIONS: Record<string, ReactNode> = {
  '/console/org/auth-policy': (
    <Trans>
      Manage hosted sign-in methods, identifiers, profile fields, and email domain rules.
    </Trans>
  ),
  '/console/org/social-providers': (
    <Trans>
      Manage OAuth and OIDC provider connections, client IDs, secret references, scopes, and
      provider readiness.
    </Trans>
  ),
  '/console/org/sso': (
    <Trans>Manage upstream SAML and OIDC enterprise identity provider connections.</Trans>
  ),
  '/console/org/outbound-sso': (
    <Trans>
      Configure downstream SaaS SAML apps from Slack, GitHub, Microsoft, and other presets.
    </Trans>
  ),
  '/console/org/scim': <Trans>Manage SCIM directories, tokens, users, and groups.</Trans>,
  '/console/org/scim-targets': (
    <Trans>
      Push users and groups to downstream SaaS SCIM APIs with assignment gates and sync controls.
    </Trans>
  ),
  '/console/org/delivery-channels': (
    <Trans>
      Configure WhatsApp and SMS providers, secret references, sender IDs, and delivery readiness.
    </Trans>
  ),
  '/console/org/applications': (
    <Trans>
      Register OAuth clients, view client IDs, rotate client secrets, and manage redirect URIs.
    </Trans>
  ),
  '/console/org/projects': (
    <Trans>Group applications into projects and manage per-project configuration.</Trans>
  ),
  '/console/org/roles': (
    <Trans>Define organization roles and the permissions granted to members.</Trans>
  ),
  '/console/org/api-keys': <Trans>Create and revoke secret keys for the Management API.</Trans>,
  '/console/org/webhooks': (
    <Trans>
      Manage event subscriptions, endpoint URLs, and signing secrets for outbound deliveries.
    </Trans>
  ),
  '/console/org/domains': (
    <Trans>
      Manage verified domains for discovery, hosted authentication, and organization routing.
    </Trans>
  ),
  '/console/org/branding': (
    <Trans>Manage organization display name, logo URLs, colors, and typography.</Trans>
  ),
  '/console/org/members': (
    <Trans>Invite members, manage roles, and review membership status.</Trans>
  ),
  '/console/org/audit-events': (
    <Trans>Review the read-only event log filtered by type and time range.</Trans>
  ),
  '/console/org/compliance': (
    <Trans>Review compliance documents and data-processing posture for this organization.</Trans>
  ),
}

type SettingsGroup = {
  key: string
  label: ReactNode
  items: ConsoleNavItem[]
}

function settingsGroups(): readonly SettingsGroup[] {
  const groups: SettingsGroup[] = []
  for (const item of ORG_NAV) {
    if (item.end) continue
    const key = item.groupKey ?? 'general'
    const existing = groups.find((group) => group.key === key)
    if (existing) {
      existing.items.push(item)
    } else {
      groups.push({ key, label: item.groupLabel ?? <Trans>General</Trans>, items: [item] })
    }
  }
  return groups
}

function SettingsOverview(): ReactNode {
  return (
    <ConsolePage
      title={<Trans>Settings</Trans>}
      lead={
        <Trans>
          Configure authentication, provider connections, enterprise identity, and organization
          presentation.
        </Trans>
      }
    >
      {settingsGroups().map((group) => (
        <ConsolePageSection key={group.key} title={group.label}>
          <ul {...stylex.props(styles.settingsList)}>
            {group.items.map((item) => (
              <li key={item.to} {...stylex.props(styles.settingsItem)}>
                <Link to={item.to} {...stylex.props(styles.settingsRow)}>
                  <span aria-hidden="true" {...stylex.props(styles.settingsCardIcon)}>
                    <Icon name={item.icon ?? 'gear'} size={18} />
                  </span>
                  <div {...stylex.props(styles.settingsCopy)}>
                    <h2 {...stylex.props(page.sectionTitle)}>{item.label}</h2>
                    {SETTINGS_DESCRIPTIONS[item.to] ? (
                      <p {...stylex.props(styles.settingsCardDescription)}>
                        {SETTINGS_DESCRIPTIONS[item.to]}
                      </p>
                    ) : null}
                  </div>
                  <span aria-hidden="true" {...stylex.props(styles.navArrow)}>
                    <Icon name="arrow-right" size={14} />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </ConsolePageSection>
      ))}
    </ConsolePage>
  )
}

export function ConsoleUsersEntry(): ReactNode {
  return <ConsoleEntry target="users" />
}

export function ConsoleHomeEntry(): ReactNode {
  return <ConsoleEntry target="home" />
}

export function ConsoleOrganizationsEntry(): ReactNode {
  return <ConsoleEntry target="organizations" />
}

export function ConsoleSettingsEntry(): ReactNode {
  return <ConsoleEntry target="settings" />
}

function ConsoleEntry({ target }: { target: EntryTarget }): ReactNode {
  const { activeOrg, organizations } = useAuth()
  // member 与仅 member org 均回 /account,与 requireOrgManager 403 对齐。
  const manageableOrgs = organizations.filter((org) => isOrgManagerRole(org.role))
  const soleOrg = manageableOrgs.length === 1 ? manageableOrgs[0] : null
  if (activeOrg && !isOrgManagerRole(activeOrg.role)) return <Navigate to="/account" replace />
  if (target === 'settings' && activeOrg) return <SettingsOverview />
  if (activeOrg) return <Navigate to={orgTargetPath(target)} replace />
  if (organizations.length > 0 && manageableOrgs.length === 0) {
    return <Navigate to="/account" replace />
  }
  if (soleOrg) return <AutoSelectOrganization target={target} org={soleOrg} />
  if (manageableOrgs.length > 0)
    return <OrganizationSelection target={target} organizations={manageableOrgs} />
  return <EmptyOrganizationState />
}

function AutoSelectOrganization({ target, org }: { target: EntryTarget; org: AuthOrg }): ReactNode {
  const { setActiveOrganization } = useAuth()
  const navigate = useNavigate()
  const { t } = useLingui()
  const destination = orgTargetPath(target)

  useEffect(() => {
    void setActiveOrganization(org.id).then((ok) => {
      if (ok) navigate(orgSelectionTarget(destination, org), { replace: true })
    })
  }, [destination, navigate, org, setActiveOrganization])

  return (
    <ConsolePage title={<Trans>Open organization</Trans>}>
      <ConsolePageSection>
        <div {...stylex.props(consoleShell.controls)}>
          <Spinner label={t`Opening organization`} />
        </div>
      </ConsolePageSection>
    </ConsolePage>
  )
}
