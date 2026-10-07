// Organizations:本人所在的组织,可切换当前组织、进入控制台、离开组织;唯一 owner 不能离开,
// 目录同步托管的成员关系由身份提供方决定。

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import type { BrowserAuthOrganization } from '@xid-kit/types'
import { useRoleLabel } from '@xid-kit/web-ui/enum-labels'
import { isOrgManagerRole } from '@xid-kit/web-ui/org-route-access'
import { text, weight } from '@xid-kit/web-ui/styles/scale.stylex'
import { Link } from '@xid-kit/web-ui/tanstack-router'
import { Alert, Badge, Button } from '../../components/ui'
import { useAuth } from '../../lib/auth-context'
import { useTheme } from '../../lib/theme'
import { tokens } from '../../styles/tokens.stylex'
import { AccountPage, AccountRow, RowMeta } from './AccountPage'
import { useAccountDates } from './account-format'
import { surface } from './account-surface'
import { ConfirmDialog } from './ConfirmDialog'
import { useLeaveOrganization } from './queries'
import { errorCode, useActionError } from './use-security-action-error'

const CONSOLE_PATH = '/console'

const styles = stylex.create({
  logo: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    width: '2.25rem',
    height: '2.25rem',
    borderRadius: tokens['--xid-radius'],
    backgroundColor: tokens['--xid-sidebar'],
    boxShadow: `inset 0 0 0 1px ${tokens['--xid-border']}`,
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
    fontWeight: weight.medium,
    overflow: 'hidden',
  },
  logoCurrent: {
    backgroundColor: tokens['--xid-primary'],
    color: tokens['--xid-primary-foreground'],
    boxShadow: 'none',
  },
  logoImage: {
    width: '100%',
    height: '100%',
    objectFit: 'contain',
  },
  list: {
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
  },
  consoleLink: {
    color: tokens['--xid-accent'],
    fontSize: text.sm,
    fontWeight: weight.medium,
    textDecoration: { default: 'none', ':hover': 'underline' },
    whiteSpace: 'nowrap',
  },
})

function OrgLogo({ org, current }: { org: BrowserAuthOrganization; current: boolean }): ReactNode {
  return (
    <span
      aria-hidden="true"
      {...stylex.props(styles.logo, current && !org.logoUrl && styles.logoCurrent)}
    >
      {org.logoUrl ? (
        <img src={org.logoUrl} alt="" {...stylex.props(styles.logoImage)} />
      ) : (
        org.name.slice(0, 1).toUpperCase()
      )}
    </span>
  )
}

function OrgRow({
  org,
  current,
  onLeave,
}: {
  org: BrowserAuthOrganization
  current: boolean
  onLeave: (org: BrowserAuthOrganization) => void
}): ReactNode {
  const { t } = useLingui()
  const { setActiveOrganization } = useAuth()
  const roleLabel = useRoleLabel()
  const dates = useAccountDates()
  const [switching, setSwitching] = useState(false)
  const role = roleLabel(org.role)
  const joined = org.joinedAt ? dates.date(org.joinedAt) : null

  const switchTo = async (): Promise<void> => {
    setSwitching(true)
    await setActiveOrganization(org.id)
    setSwitching(false)
  }

  const openConsole = async (): Promise<void> => {
    if (!current) await setActiveOrganization(org.id)
    globalThis.location.assign(CONSOLE_PATH)
  }

  return (
    <AccountRow
      icon={<OrgLogo org={org} current={current} />}
      title={org.name}
      badges={
        current ? (
          <Badge tone="info">
            <Trans>Current</Trans>
          </Badge>
        ) : null
      }
      meta={
        <RowMeta>
          {joined ? (
            <Trans>
              {role}. Joined {joined}.
            </Trans>
          ) : (
            role
          )}
        </RowMeta>
      }
      actions={
        <>
          {isOrgManagerRole(org.role) ? (
            <a
              href={CONSOLE_PATH}
              onClick={(event) => {
                event.preventDefault()
                void openConsole()
              }}
              {...stylex.props(styles.consoleLink)}
            >
              <Trans>Open console</Trans>
            </a>
          ) : null}
          {org.isManaged ? (
            <span {...stylex.props(surface.rowMeta)}>
              <Trans>Managed by your directory</Trans>
            </span>
          ) : org.joinedAt ? (
            <button
              type="button"
              aria-label={t`Leave ${org.name}`}
              onClick={() => onLeave(org)}
              {...stylex.props(surface.quietButton)}
            >
              <Trans>Leave…</Trans>
            </button>
          ) : null}
          {current ? null : (
            <Button variant="secondary" isLoading={switching} onClick={() => void switchTo()}>
              <Trans>Switch</Trans>
            </Button>
          )}
        </>
      }
    />
  )
}

export default function OrganizationsPage(): ReactNode {
  const { t } = useLingui()
  const { brand } = useTheme()
  const { organizations, activeOrg, user, refresh } = useAuth()
  const leave = useLeaveOrganization()
  const actionError = useActionError()
  const [leaving, setLeaving] = useState<BrowserAuthOrganization | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [left, setLeft] = useState<string | null>(null)
  const appName = brand.appName ?? 'XID'

  const sorted = [...organizations].sort((a, b) => {
    if (a.id === activeOrg?.id) return -1
    if (b.id === activeOrg?.id) return 1
    return a.name.localeCompare(b.name)
  })

  const handleLeave = async (org: BrowserAuthOrganization): Promise<void> => {
    setError(null)
    try {
      await leave.mutateAsync(org.id)
      await refresh()
      setLeaving(null)
      setLeft(org.name)
    } catch (err) {
      setLeaving(null)
      setError(
        errorCode(err) === 'last_owner'
          ? t`You're the only owner of ${org.name}. Make someone else an owner first, then leave.`
          : actionError(err, t`We couldn't remove you from ${org.name}. Try again.`),
      )
    }
  }

  return (
    <AccountPage
      title={<Trans>Organizations</Trans>}
      description={
        <Trans>
          Teams you belong to inside {appName}. Switching changes which apps and data you see.
        </Trans>
      }
      actions={
        user?.canCreateOrganization ? (
          <Link to="/create-organization" {...stylex.props(surface.linkButton)}>
            <Trans>Create organization…</Trans>
          </Link>
        ) : null
      }
    >
      <div {...stylex.props(surface.column)}>
        {error ? <Alert tone="error">{error}</Alert> : null}
        {left ? (
          <Alert tone="success">
            <Trans>
              You left {left}. An admin has to invite you again if you want to come back.
            </Trans>
          </Alert>
        ) : null}
        <div {...stylex.props(styles.list)}>
          {sorted.length === 0 ? (
            <p {...stylex.props(surface.note)}>
              <Trans>You're not a member of any organization yet.</Trans>
            </p>
          ) : (
            sorted.map((org) => (
              <OrgRow
                key={org.id}
                org={org}
                current={org.id === activeOrg?.id}
                onLeave={setLeaving}
              />
            ))
          )}
        </div>
      </div>
      {leaving ? (
        <ConfirmDialog
          title={<Trans>Leave {leaving.name}?</Trans>}
          description={
            <Trans>
              You lose access to {leaving.name} and the apps it gives you right away. To come back,
              an admin has to invite you again.
            </Trans>
          }
          position={{ narrow: 'fullscreen', regular: 'center' }}
          confirmLabel={<Trans>Leave organization</Trans>}
          isLoading={leave.isPending}
          onConfirm={() => void handleLeave(leaving)}
          onCancel={() => setLeaving(null)}
        />
      ) : null}
    </AccountPage>
  )
}
