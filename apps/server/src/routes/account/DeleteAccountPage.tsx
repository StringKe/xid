// 删除账户:先列出会失去什么,再引导导出,最后输入 DELETE 并重新验证后排期,30 天内可取消。

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { useOrganizationLabel } from '@xid-kit/web-ui/display-names'
import { leading, text, weight } from '@xid-kit/web-ui/styles/scale.stylex'
import { Link, useNavigate } from '@xid-kit/web-ui/tanstack-router'
import { Alert, Breadcrumb, Button, TextField } from '../../components/ui'
import { useAuth } from '../../lib/auth-context'
import { useTheme } from '../../lib/theme'
import { tokens } from '../../styles/tokens.stylex'
import { AccountPage, AccountSection, KeyRow } from './AccountPage'
import { useAccountDates } from './account-format'
import { ACCOUNT_PATHS } from './account-paths'
import { surface } from './account-surface'
import { DataExportRow } from './DataExport'
import { scheduledDeletion } from './PendingDeletionBanner'
import {
  useAuthorizedAppsQuery,
  useCreatePrivacyRequest,
  useMfaFactorsQuery,
  usePasskeysQuery,
  usePrivacyRequestsQuery,
} from './queries'
import { useStepUpGuard } from './step-up'
import { errorCode, useActionError } from './use-security-action-error'

const DELETE_CONFIRMATION = 'DELETE'
const GRACE_DAYS = 30

const styles = stylex.create({
  step: {
    display: 'inline-flex',
    alignItems: 'baseline',
    gap: '0.5rem',
  },
  stepNumber: {
    fontSize: text.sm,
    fontVariantNumeric: 'tabular-nums',
    color: tokens['--xid-muted-foreground'],
  },
  schedule: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
    paddingBlockStart: '1rem',
  },
  body: {
    margin: 0,
    fontSize: text.base,
    lineHeight: leading.md,
    color: tokens['--xid-fg'],
  },
  input: {
    maxWidth: '22.5rem',
  },
  actions: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '0.5rem',
  },
  hint: {
    margin: 0,
    fontSize: text.sm,
    color: tokens['--xid-muted-foreground'],
  },
  linkButton: {
    display: 'inline-flex',
    alignItems: 'center',
    minHeight: { default: '2.25rem', '@media (pointer: coarse)': '2.75rem' },
    paddingInline: '0.875rem',
    borderRadius: tokens['--xid-radius'],
    boxShadow: `inset 0 0 0 1px ${tokens['--xid-border-strong']}`,
    color: tokens['--xid-fg'],
    fontSize: text.base,
    fontWeight: weight.medium,
    textDecoration: 'none',
  },
})

function Step({ number, children }: { number: number; children: ReactNode }): ReactNode {
  return (
    <span {...stylex.props(styles.step)}>
      <span aria-hidden="true" {...stylex.props(styles.stepNumber)}>
        {number}
      </span>
      {children}
    </span>
  )
}

function useSignInMethodsSummary(): string {
  const { t, i18n } = useLingui()
  const { user } = useAuth()
  const passkeys = usePasskeysQuery()
  const factors = useMfaFactorsQuery()
  const count = passkeys.data?.data.length ?? 0
  const items: string[] = []
  if (count === 1) items.push(t`your passkey`)
  if (count > 1) items.push(t`${count} passkeys`)
  if (user?.hasPassword) items.push(t`your password`)
  if (factors.data?.some((factor) => factor.type === 'totp')) items.push(t`your authenticator app`)
  if (items.length === 0) return t`Every way you sign in stops working.`
  const list = new Intl.ListFormat(i18n.locale, { type: 'conjunction' }).format(items)
  return t`These stop working: ${list}.`
}

export default function DeleteAccountPage(): ReactNode {
  const { t, i18n } = useLingui()
  const { brand } = useTheme()
  const { organizations } = useAuth()
  const navigate = useNavigate()
  const dates = useAccountDates()
  const apps = useAuthorizedAppsQuery()
  const requests = usePrivacyRequestsQuery()
  const create = useCreatePrivacyRequest()
  const guard = useStepUpGuard()
  const actionError = useActionError()
  const methods = useSignInMethodsSummary()
  const [confirmation, setConfirmation] = useState('')
  const [error, setError] = useState<string | null>(null)
  const appName = brand.appName ?? 'XID'
  const list = new Intl.ListFormat(i18n.locale, { type: 'conjunction' })
  const organizationLabel = useOrganizationLabel()
  const orgNames = list.format(organizations.map(organizationLabel))
  const appNames = list.format((apps.data ?? []).map((app) => app.name))
  const deletionDate = dates.date(new Date(Date.now() + GRACE_DAYS * 86_400_000).toISOString())
  const alreadyScheduled = scheduledDeletion(requests.data)

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (confirmation !== DELETE_CONFIRMATION) return
    setError(null)
    try {
      await guard(
        () => create.mutateAsync({ type: 'delete', confirmation: DELETE_CONFIRMATION }),
        <Trans>You're about to schedule the deletion of your account.</Trans>,
      )
      navigate(ACCOUNT_PATHS.privacy)
    } catch (err) {
      setError(
        errorCode(err) === 'account_deletion_blocked'
          ? actionError(err, t`You can't delete your account yet.`)
          : actionError(err, t`We couldn't schedule the deletion. Try again.`),
      )
    }
  }

  return (
    <AccountPage
      before={
        <div {...stylex.props(surface.column)}>
          <Breadcrumb
            items={[
              { key: 'privacy', label: <Trans>Data & privacy</Trans>, href: ACCOUNT_PATHS.privacy },
              { key: 'delete', label: <Trans>Delete account</Trans> },
            ]}
          />
        </div>
      }
      title={<Trans>Delete your account</Trans>}
      description={
        <Trans>
          Read what you'll lose, save a copy of your data, then schedule the deletion. You have 30
          days to change your mind.
        </Trans>
      }
    >
      <AccountSection
        title={
          <Step number={1}>
            <Trans>What you'll lose</Trans>
          </Step>
        }
      >
        <KeyRow label={<Trans>Organizations</Trans>}>
          {orgNames ? (
            <Trans>{orgNames}. An admin would have to invite you again.</Trans>
          ) : (
            <Trans>None</Trans>
          )}
        </KeyRow>
        <KeyRow label={<Trans>Apps</Trans>}>
          {appNames ? (
            <Trans>Every app you sign in to with this account, including {appNames}.</Trans>
          ) : (
            <Trans>Every app you sign in to with this account.</Trans>
          )}
        </KeyRow>
        <KeyRow label={<Trans>Sign-in methods</Trans>}>{methods}</KeyRow>
        <KeyRow label={<Trans>What stays</Trans>}>
          <Trans>
            Audit records of what you did in {appName}. The organization must keep them unchanged.
          </Trans>
        </KeyRow>
      </AccountSection>

      <AccountSection
        title={
          <Step number={2}>
            <Trans>Save a copy first</Trans>
          </Step>
        }
      >
        <DataExportRow />
      </AccountSection>

      <AccountSection
        title={
          <Step number={3}>
            <Trans>Schedule the deletion</Trans>
          </Step>
        }
      >
        {alreadyScheduled ? (
          <div {...stylex.props(styles.schedule)}>
            <Alert tone="info">
              <Trans>
                Your account is already scheduled for deletion. You can cancel it on Data & privacy.
              </Trans>
            </Alert>
          </div>
        ) : (
          <form
            onSubmit={(event) => void handleSubmit(event)}
            noValidate
            {...stylex.props(styles.schedule)}
          >
            <p {...stylex.props(styles.body)}>
              <Trans>
                Your account will be deleted on {deletionDate}. Until then you can sign in and
                cancel from this page. After {deletionDate}, what you'll lose can't be recovered.
              </Trans>
            </p>
            <div {...stylex.props(styles.input)}>
              <TextField
                label={<Trans>Type DELETE to confirm</Trans>}
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
              />
            </div>
            {error ? <Alert tone="error">{error}</Alert> : null}
            <div {...stylex.props(styles.actions)}>
              <Button
                type="submit"
                variant="danger"
                disabled={confirmation !== DELETE_CONFIRMATION}
                isLoading={create.isPending}
              >
                <Trans>Schedule deletion</Trans>
              </Button>
              <Link to={ACCOUNT_PATHS.privacy} {...stylex.props(styles.linkButton)}>
                <Trans>Keep my account</Trans>
              </Link>
            </div>
            <p {...stylex.props(styles.hint)}>
              <Trans>We'll ask you to confirm it's you before scheduling.</Trans>
            </p>
          </form>
        )}
      </AccountSection>
    </AccountPage>
  )
}
