// Security(账户门户默认落地页):顶部是未验证邮箱的待办,
// 之后按 Passkeys -> Password -> Two-step verification -> Connected accounts 排列。
// 组织强制绑定(pending_mfa_setup)在 Hosted Auth /mfa/setup 完成,不进入账户门户。

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { leading, text, weight } from '@xid-kit/web-ui/styles/scale.stylex'
import { Badge, Button } from '../../components/ui'
import { isGuestUser, useAuth } from '../../lib/auth-context'
import { useTheme } from '../../lib/theme'
import { tokens } from '../../styles/tokens.stylex'
import { AccountPage } from './AccountPage'
import { surface } from './account-surface'
import { ConnectedAccountsSection } from './ConnectedAccountsSection'
import { ContactCodeDialog, type PendingContact } from './ContactCodeDialog'
import { GuestConversionBanner } from './GuestConversionBanner'
import { PasskeySection } from './PasskeySection'
import { PasswordSection } from './PasswordSection'
import { useAddEmail, useEmailsQuery, useSendEmailCode, useVerifyEmail } from './queries'
import { TwoStepSection } from './TwoStepSection'
import type { EmailAddress } from './types'
import { useActionError } from './use-security-action-error'

const styles = stylex.create({
  task: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: '0.625rem',
    padding: { default: '1rem', '@media (min-width: 48rem)': '1rem 1.25rem' },
    borderRadius: tokens['--xid-radius-lg'],
    backgroundColor: tokens['--xid-warning-bg'],
  },
  taskHead: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: '0.5rem',
  },
  taskTitle: {
    margin: 0,
    fontSize: text.md,
    lineHeight: leading.md,
    fontWeight: weight.medium,
    color: tokens['--xid-fg'],
    overflowWrap: 'anywhere',
  },
  taskBody: {
    margin: 0,
    fontSize: text.sm,
    lineHeight: '1.25rem',
    color: tokens['--xid-muted-foreground'],
  },
  taskActions: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '0.5rem',
  },
  tasks: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
  },
  error: {
    margin: 0,
    fontSize: text.sm,
    color: tokens['--xid-danger'],
  },
})

function VerifyEmailTask({ email }: { email: EmailAddress }): ReactNode {
  const { t } = useLingui()
  const sendCode = useSendEmailCode()
  const addEmail = useAddEmail()
  const verifyEmail = useVerifyEmail()
  const actionError = useActionError()
  const [pending, setPending] = useState<PendingContact | null>(null)
  const [error, setError] = useState<string | null>(null)

  const sendNew = async (): Promise<PendingContact> => {
    const next = email.pending
      ? await addEmail.mutateAsync(email.email)
      : await sendCode.mutateAsync(email.id)
    return { id: next.id, target: next.email }
  }

  const handleSend = async (openAfter: boolean): Promise<void> => {
    setError(null)
    try {
      const next = await sendNew()
      if (openAfter) setPending(next)
    } catch (err) {
      setError(actionError(err, t`We couldn't send a code. Try again in a minute.`))
    }
  }

  return (
    <section aria-label={email.email} {...stylex.props(styles.task)}>
      <div {...stylex.props(styles.taskHead)}>
        <Badge tone="warning" variant="outline">
          <Trans>To do</Trans>
        </Badge>
        <h2 {...stylex.props(styles.taskTitle)}>
          <Trans>Verify your email, {email.email}</Trans>
        </h2>
      </div>
      <p {...stylex.props(styles.taskBody)}>
        {email.pending ? (
          <Trans>
            We sent a 6-digit code. Until you enter it, this address can't be used to sign in or get
            account notices.
          </Trans>
        ) : (
          <Trans>
            Until it's verified, this address can't be used to sign in or get account notices.
          </Trans>
        )}
      </p>
      {error ? <p {...stylex.props(styles.error)}>{error}</p> : null}
      <div {...stylex.props(styles.taskActions)}>
        {email.pending ? (
          <>
            <Button onClick={() => setPending({ id: email.id, target: email.email })}>
              <Trans>Enter code…</Trans>
            </Button>
            <Button
              variant="secondary"
              isLoading={addEmail.isPending || sendCode.isPending}
              onClick={() => void handleSend(false)}
            >
              <Trans>Send a new code</Trans>
            </Button>
          </>
        ) : (
          <Button isLoading={sendCode.isPending} onClick={() => void handleSend(true)}>
            <Trans>Send code…</Trans>
          </Button>
        )}
      </div>
      {pending ? (
        <ContactCodeDialog
          kind="email"
          pending={pending}
          send={async () => sendNew()}
          resend={async () => sendNew()}
          verify={async (current, code) => {
            await verifyEmail.mutateAsync({ id: current.id, code })
          }}
          onClose={() => setPending(null)}
        />
      ) : null}
    </section>
  )
}

function PendingTasks(): ReactNode {
  const emails = useEmailsQuery()
  const unverified = (emails.data?.data ?? []).filter((email) => !email.verified)
  if (unverified.length === 0) return null
  return (
    <div {...stylex.props(surface.column, styles.tasks)}>
      {unverified.map((email) => (
        <VerifyEmailTask key={email.id} email={email} />
      ))}
    </div>
  )
}

export default function SecurityPage(): ReactNode {
  const { brand } = useTheme()
  const { user } = useAuth()
  const appName = brand.appName ?? 'XID'
  const isGuest = isGuestUser(user)

  return (
    <AccountPage
      before={
        <>
          <GuestConversionBanner />
          {isGuest ? null : <PendingTasks />}
        </>
      }
      title={<Trans>Security</Trans>}
      description={
        <Trans>How you sign in to {appName}, and what keeps someone else from doing it.</Trans>
      }
    >
      <PasskeySection />
      {isGuest ? null : <PasswordSection />}
      {isGuest ? null : <TwoStepSection />}
      <ConnectedAccountsSection />
    </AccountPage>
  )
}
