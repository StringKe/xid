import { Trans, useLingui } from '@lingui/react/macro'
import { useEffect } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Link, Navigate, useNavigate } from '../../lib/router'
import { Button, Card, PageHeader, Spinner } from '../../components/ui'
import { useAuth } from '../../lib/auth-context'
import type { AuthOrg } from '../../lib/auth-context'
import { organizationDisplayName } from '../../lib/display-names'
import { isOrgManagerRole } from '../../lib/org-route-access'
import { page } from '../../styles/product-surface.stylex'
import { tokens } from '../../styles/tokens.stylex'

const styles = stylex.create({
  orgMeta: {
    margin: '0 0 1rem',
    color: tokens['--xid-muted-foreground'],
    fontSize: '0.8125rem',
  },
  settingsLink: {
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
    <div {...stylex.props(page.root)}>
      <PageHeader
        title={<Trans>Select organization</Trans>}
        lead={<Trans>Choose an organization to continue in the console.</Trans>}
      />
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
    </div>
  )
}

function EmptyOrganizationState(): ReactNode {
  return (
    <div {...stylex.props(page.root)}>
      <PageHeader
        title={<Trans>No organization access</Trans>}
        lead={<Trans>You do not have access to an organization yet.</Trans>}
      />
    </div>
  )
}

function SettingsOverview({ org }: { org: AuthOrg }): ReactNode {
  const orgName = organizationDisplayName(org)
  const entries = [
    {
      to: '/console/org/auth-policy',
      title: <Trans>Auth policy</Trans>,
      description: (
        <Trans>
          Manage hosted sign-in methods, identifiers, profile fields, and email domain rules.
        </Trans>
      ),
      cta: <Trans>Open auth policy</Trans>,
    },
    {
      to: '/console/org/delivery-channels',
      title: <Trans>Delivery channels</Trans>,
      description: (
        <Trans>
          Configure WhatsApp and SMS providers, secret references, sender IDs, and delivery
          readiness.
        </Trans>
      ),
      cta: <Trans>Open delivery channels</Trans>,
    },
    {
      to: '/console/org/social-providers',
      title: <Trans>Social providers</Trans>,
      description: (
        <Trans>
          Manage OAuth and OIDC provider connections, client IDs, secret references, scopes, and
          provider readiness.
        </Trans>
      ),
      cta: <Trans>Open social providers</Trans>,
    },
    {
      to: '/console/org/sso',
      title: <Trans>Enterprise SSO inbound</Trans>,
      description: (
        <Trans>Manage upstream SAML and OIDC enterprise identity provider connections.</Trans>
      ),
      cta: <Trans>Open inbound SSO</Trans>,
    },
    {
      to: '/console/org/outbound-sso',
      title: <Trans>Enterprise SSO outbound</Trans>,
      description: (
        <Trans>
          Configure downstream SaaS SAML apps from Slack, GitHub, Microsoft, and other presets.
        </Trans>
      ),
      cta: <Trans>Open outbound SSO</Trans>,
    },
    {
      to: '/console/org/scim',
      title: <Trans>Directory sync</Trans>,
      description: <Trans>Manage SCIM directories, tokens, users, and groups.</Trans>,
      cta: <Trans>Open directory sync</Trans>,
    },
    {
      to: '/console/org/scim-targets',
      title: <Trans>SCIM targets</Trans>,
      description: (
        <Trans>
          Push users and groups to downstream SaaS SCIM APIs with assignment gates and sync
          controls.
        </Trans>
      ),
      cta: <Trans>Open SCIM targets</Trans>,
    },
    {
      to: '/console/org/domains',
      title: <Trans>Domains</Trans>,
      description: (
        <Trans>
          Manage verified domains for discovery, hosted authentication, and organization routing.
        </Trans>
      ),
      cta: <Trans>Open domains</Trans>,
    },
    {
      to: '/console/org/branding',
      title: <Trans>Branding</Trans>,
      description: (
        <Trans>Manage organization display name, logo URLs, colors, and typography.</Trans>
      ),
      cta: <Trans>Open branding</Trans>,
    },
    {
      to: '/console/org/applications',
      title: <Trans>OAuth applications</Trans>,
      description: (
        <Trans>
          Register OAuth clients, view client IDs, rotate client secrets, and manage redirect URIs.
        </Trans>
      ),
      cta: <Trans>Open applications</Trans>,
    },
    {
      to: '/console/org/webhooks',
      title: <Trans>Webhooks</Trans>,
      description: (
        <Trans>
          Manage event subscriptions, endpoint URLs, and signing secrets for outbound deliveries.
        </Trans>
      ),
      cta: <Trans>Open webhooks</Trans>,
    },
    {
      to: '/console/org/api-keys',
      title: <Trans>API keys</Trans>,
      description: <Trans>Create and revoke secret keys for the Management API.</Trans>,
      cta: <Trans>Open API keys</Trans>,
    },
    {
      to: '/console/org/audit-events',
      title: <Trans>Audit events</Trans>,
      description: <Trans>Review the read-only event log filtered by type and time range.</Trans>,
      cta: <Trans>Open audit events</Trans>,
    },
  ] as const

  return (
    <div {...stylex.props(page.root)}>
      <PageHeader
        title={<Trans>Settings</Trans>}
        lead={
          <Trans>
            Configure authentication, provider connections, enterprise identity, and organization
            presentation for {orgName}.
          </Trans>
        }
      />
      <div {...stylex.props(page.gridActions)}>
        {entries.map((entry) => (
          <Card key={entry.to} variant="raised">
            <h2 {...stylex.props(page.sectionTitle)}>{entry.title}</h2>
            <p {...stylex.props(styles.orgMeta)}>{entry.description}</p>
            <Link to={entry.to} {...stylex.props(styles.settingsLink)}>
              {entry.cta}
            </Link>
          </Card>
        ))}
      </div>
    </div>
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
  if (target === 'settings' && activeOrg) return <SettingsOverview org={activeOrg} />
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
    <div {...stylex.props(page.loadingCenter)}>
      <Spinner label={t`Opening organization`} />
    </div>
  )
}
