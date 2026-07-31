import { Trans, useLingui } from '@lingui/react/macro'
import { useEffect } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Link, Navigate, useNavigate } from '@xid-kit/web-ui/tanstack-router'
import {
  Button,
  Card,
  ConsolePage,
  ConsolePageSection,
  EmptyState,
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
  orgMeta: {
    margin: '0 0 1rem',
    color: tokens['--xid-muted-foreground'],
    fontSize: '0.8125rem',
  },
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
    // hover 时长对齐 motion springPress 预算(0.25s),按压/hover 微交互同口径
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
        <div {...stylex.props(page.gridActions)}>
          {organizations.map((org) => (
            <Card key={org.id} variant="raised">
              <h2 {...stylex.props(page.sectionTitle)}>{organizationDisplayName(org)}</h2>
              <p {...stylex.props(styles.orgMeta)}>{org.slug}</p>
              <Button
                type="button"
                onClick={() => {
                  void setActiveOrganization(org.id).then((ok) => {
                    if (ok) navigate(orgSelectionTarget(destination, org), { replace: true })
                  })
                }}
              >
                <Trans>Open organization</Trans>
              </Button>
            </Card>
          ))}
        </div>
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
              You do not have access to an organization yet. Create one to start managing
              authentication, users, and applications.
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

// Settings 卡片由 ORG_NAV 元数据生成:nav 是唯一事实源,新增 org 页自动出现在这里。
// 描述按路径补充;缺描述的路径仍然出卡,只是没有说明文案。
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
          <div {...stylex.props(page.gridActions)}>
            {group.items.map((item) => (
              <Card key={item.to} variant="raised">
                <h2 {...stylex.props(page.sectionTitle)}>{item.label}</h2>
                {SETTINGS_DESCRIPTIONS[item.to] ? (
                  <p {...stylex.props(styles.orgMeta)}>{SETTINGS_DESCRIPTIONS[item.to]}</p>
                ) : null}
                <Link to={item.to} {...stylex.props(styles.primaryLink)}>
                  <Trans>Open</Trans>
                </Link>
              </Card>
            ))}
          </div>
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
  // member 不属于 org 管理面:activeOrg 角色不足直接回 /account;
  // 选择列表只列可管理 org,member-only 用户同样落 /account(与 requireOrgManager 403 对齐)。
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

  // 中间态对齐页头版式:loading 与落地页同骨架,切换不跳动。
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
