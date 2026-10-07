// Data & privacy:已授权的第三方应用、下载数据、删除账户入口(或已排期删除的状态与取消)。

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { useOrganizationLabel } from '@xid-kit/web-ui/display-names'
import { leading, text, weight } from '@xid-kit/web-ui/styles/scale.stylex'
import { useNavigate } from '@xid-kit/web-ui/tanstack-router'
import { Alert, Button, Skeleton } from '../../components/ui'
import { useAuth } from '../../lib/auth-context'
import { useTheme } from '../../lib/theme'
import { tokens } from '../../styles/tokens.stylex'
import { AccountPage, AccountRow, AccountSection, RowMeta } from './AccountPage'
import { useAccountDates } from './account-format'
import { ACCOUNT_PATHS } from './account-paths'
import { surface } from './account-surface'
import { ConfirmDialog } from './ConfirmDialog'
import { DataExportRow, ExportBadge } from './DataExport'
import { scheduledDeletion } from './PendingDeletionBanner'
import { useScopeSummary } from './privacy-shared'
import {
  useAuthorizedAppsQuery,
  useCancelPrivacyRequest,
  usePrivacyRequestsQuery,
  useRevokeAuthorizedApp,
} from './queries'
import { useStepUpGuard } from './step-up'
import type { AuthorizedApp } from './types'
import { useActionError } from './use-security-action-error'

const styles = stylex.create({
  appLogo: {
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
  appLogoImage: {
    width: '100%',
    height: '100%',
    objectFit: 'contain',
  },
  scopes: {
    margin: 0,
    fontSize: text.base,
    lineHeight: leading.base,
    color: tokens['--xid-fg'],
  },
  danger: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: '0.5rem',
    padding: { default: '1rem', '@media (min-width: 48rem)': '1.25rem' },
    borderRadius: tokens['--xid-radius-lg'],
    boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${tokens['--xid-danger']} 30%, ${tokens['--xid-border']})`,
  },
  dangerTitle: {
    margin: 0,
    fontSize: text.lg,
    lineHeight: leading.lg,
    fontWeight: weight.display,
    letterSpacing: tokens['--xid-tracking-title'],
    color: tokens['--xid-fg'],
  },
  dangerBody: {
    margin: 0,
    fontSize: text.sm,
    lineHeight: '1.25rem',
    color: tokens['--xid-muted-foreground'],
  },
  dangerButton: {
    color: tokens['--xid-danger'],
  },
})

function AppLogo({ app }: { app: AuthorizedApp }): ReactNode {
  return (
    <span aria-hidden="true" {...stylex.props(styles.appLogo)}>
      {app.logoUrl ? (
        <img src={app.logoUrl} alt="" {...stylex.props(styles.appLogoImage)} />
      ) : (
        app.name.slice(0, 1).toUpperCase()
      )}
    </span>
  )
}

function AuthorizedAppsSection(): ReactNode {
  const { t } = useLingui()
  const { brand } = useTheme()
  const apps = useAuthorizedAppsQuery()
  const revoke = useRevokeAuthorizedApp()
  const guard = useStepUpGuard()
  const actionError = useActionError()
  const scopeSummary = useScopeSummary()
  const dates = useAccountDates()
  const [revoking, setRevoking] = useState<AuthorizedApp | null>(null)
  const [error, setError] = useState<string | null>(null)
  const appName = brand.appName ?? 'XID'
  const list = apps.data ?? []

  const handleRevoke = async (app: AuthorizedApp): Promise<void> => {
    setError(null)
    try {
      await guard(
        () => revoke.mutateAsync(app.clientId),
        <Trans>You're about to revoke {app.name}'s access to your account.</Trans>,
      )
      setRevoking(null)
    } catch (err) {
      setRevoking(null)
      setError(actionError(err, t`We couldn't revoke that app's access. Try again.`))
    }
  }

  return (
    <AccountSection
      title={<Trans>Authorized apps</Trans>}
      description={
        <Trans>
          Apps that you allowed to use your {appName} account. Apps that sign you in without asking
          aren't listed.
        </Trans>
      }
    >
      {apps.isPending ? (
        <div {...stylex.props(surface.skeletonStack)}>
          <Skeleton height="3rem" />
          <Skeleton height="3rem" />
        </div>
      ) : apps.error ? (
        <p {...stylex.props(surface.note)}>
          <Trans>We couldn't load your authorized apps. Refresh the page to try again.</Trans>
        </p>
      ) : list.length === 0 ? (
        <p {...stylex.props(surface.note)}>
          <Trans>You haven't allowed any app to use your account.</Trans>
        </p>
      ) : (
        <>
          {list.map((app) => {
            const allowed = dates.date(app.createdAt)
            return (
              <AccountRow
                key={app.clientId}
                icon={<AppLogo app={app} />}
                title={app.name}
                meta={
                  <>
                    <p {...stylex.props(styles.scopes)}>{scopeSummary(app.grantedScopes)}</p>
                    <RowMeta>
                      {app.redirectOrigin ? (
                        <Trans>
                          Allowed {allowed}. Sends you to {app.redirectOrigin}.
                        </Trans>
                      ) : (
                        <Trans>Allowed {allowed}.</Trans>
                      )}
                    </RowMeta>
                  </>
                }
                actions={
                  <Button
                    variant="secondary"
                    aria-label={t`Revoke access for ${app.name}`}
                    onClick={() => setRevoking(app)}
                  >
                    <Trans>Revoke access…</Trans>
                  </Button>
                }
              />
            )
          })}
          <p {...stylex.props(surface.note)}>
            <Trans>
              Revoking stops new access right away. Anything an app already copied stays with that
              company; ask them to delete it.
            </Trans>
          </p>
        </>
      )}
      {error ? (
        <div {...stylex.props(surface.note)}>
          <Alert tone="error">{error}</Alert>
        </div>
      ) : null}
      {revoking ? (
        <ConfirmDialog
          title={<Trans>Revoke {revoking.name}'s access?</Trans>}
          description={
            <Trans>
              {revoking.name} can't use your account anymore, and it's signed out right away. If you
              use it again, it asks for permission again.
            </Trans>
          }
          confirmLabel={<Trans>Revoke access</Trans>}
          isLoading={revoke.isPending}
          onConfirm={() => void handleRevoke(revoking)}
          onCancel={() => setRevoking(null)}
        />
      ) : null}
    </AccountSection>
  )
}

function DeleteAccountCard(): ReactNode {
  const { t, i18n } = useLingui()
  const navigate = useNavigate()
  const { organizations } = useAuth()
  const dates = useAccountDates()
  const requests = usePrivacyRequestsQuery()
  const cancel = useCancelPrivacyRequest()
  const actionError = useActionError()
  const organizationLabel = useOrganizationLabel()
  const [error, setError] = useState<string | null>(null)
  const orgNames = new Intl.ListFormat(i18n.locale, { type: 'conjunction' }).format(
    organizations.map(organizationLabel),
  )
  const pending = scheduledDeletion(requests.data)

  const handleCancel = async (): Promise<void> => {
    if (!pending) return
    setError(null)
    try {
      await cancel.mutateAsync(pending.id)
    } catch (err) {
      setError(actionError(err, t`We couldn't cancel the deletion. Try again.`))
    }
  }

  if (pending?.scheduledFor) {
    const deletionDate = dates.date(pending.scheduledFor)
    const asked = dates.date(pending.createdAt)
    return (
      <section {...stylex.props(surface.column, styles.danger)}>
        <h2 {...stylex.props(styles.dangerTitle)}>
          <Trans>Deletion scheduled for {deletionDate}</Trans>
        </h2>
        <p {...stylex.props(styles.dangerBody)}>
          {orgNames ? (
            <Trans>
              30 days after you asked on {asked}. On {deletionDate} you lose access to {orgNames},
              and we remove your name, email and sign-in methods.
            </Trans>
          ) : (
            <Trans>
              30 days after you asked on {asked}. On {deletionDate} we remove your name, email and
              sign-in methods.
            </Trans>
          )}
        </p>
        {error ? <Alert tone="error">{error}</Alert> : null}
        <Button
          variant="secondary"
          isLoading={cancel.isPending}
          onClick={() => void handleCancel()}
        >
          <Trans>Cancel deletion</Trans>
        </Button>
      </section>
    )
  }

  return (
    <section {...stylex.props(surface.column, styles.danger)}>
      <h2 {...stylex.props(styles.dangerTitle)}>
        <Trans>Delete your account</Trans>
      </h2>
      <p {...stylex.props(styles.dangerBody)}>
        {orgNames ? (
          <Trans>
            You lose access to {orgNames}, and to the apps you use with this account. We wait 30
            days before deleting anything, and you can cancel until then.
          </Trans>
        ) : (
          <Trans>
            You lose access to the apps you use with this account. We wait 30 days before deleting
            anything, and you can cancel until then.
          </Trans>
        )}
      </p>
      <Button variant="secondary" onClick={() => navigate(ACCOUNT_PATHS.deleteAccount)}>
        <span {...stylex.props(styles.dangerButton)}>
          <Trans>Delete account…</Trans>
        </span>
      </Button>
    </section>
  )
}

export default function PrivacyPage(): ReactNode {
  return (
    <AccountPage
      title={<Trans>Data & privacy</Trans>}
      description={
        <Trans>
          Which apps can use your account, a copy of your data, and closing your account.
        </Trans>
      }
    >
      <AuthorizedAppsSection />
      <AccountSection
        title={<Trans>Download your data</Trans>}
        badge={<ExportBadge />}
        description={
          <Trans>
            Your profile, sign-in methods, devices, organizations and app permissions as one JSON
            file. Passwords and passkey keys are never included.
          </Trans>
        }
      >
        <DataExportRow />
      </AccountSection>
      <DeleteAccountCard />
    </AccountPage>
  )
}
