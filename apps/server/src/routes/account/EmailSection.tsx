// 资料页「Email addresses」:添加并用 6 位码验证、设为主邮箱(需重新验证)、移除非主邮箱。

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Alert, Badge, Button, Skeleton } from '../../components/ui'
import { isGuestUser, useAuth } from '../../lib/auth-context'
import { AccountRow, AccountSection } from './AccountPage'
import { surface } from './account-surface'
import { ConfirmDialog } from './ConfirmDialog'
import { ContactCodeDialog, type PendingContact } from './ContactCodeDialog'
import {
  useAddEmail,
  useEmailsQuery,
  useMakeEmailPrimary,
  useRemoveEmail,
  useSendEmailCode,
  useVerifyEmail,
} from './queries'
import { useStepUpGuard } from './step-up'
import type { EmailAddress } from './types'
import { useActionError } from './use-security-action-error'

type DialogState = { kind: 'add' } | { kind: 'verify'; pending: PendingContact } | null

export function EmailSection(): ReactNode {
  const { t } = useLingui()
  const { user } = useAuth()
  const emails = useEmailsQuery()
  const addEmail = useAddEmail()
  const sendCode = useSendEmailCode()
  const verifyEmail = useVerifyEmail()
  const makePrimary = useMakeEmailPrimary()
  const removeEmail = useRemoveEmail()
  const guard = useStepUpGuard()
  const actionError = useActionError()
  const [dialog, setDialog] = useState<DialogState>(null)
  const [removing, setRemoving] = useState<EmailAddress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmation, setConfirmation] = useState<string | null>(null)
  const isGuest = isGuestUser(user)

  const startVerify = async (email: EmailAddress): Promise<void> => {
    setError(null)
    if (email.pending) {
      setDialog({ kind: 'verify', pending: { id: email.id, target: email.email } })
      return
    }
    try {
      const pending = await sendCode.mutateAsync(email.id)
      setDialog({ kind: 'verify', pending: { id: pending.id, target: pending.email } })
    } catch (err) {
      setError(actionError(err, t`We couldn't send a code. Try again in a minute.`))
    }
  }

  const handleMakePrimary = async (email: EmailAddress): Promise<void> => {
    setError(null)
    setConfirmation(null)
    try {
      await guard(
        () => makePrimary.mutateAsync(email.id),
        <Trans>
          You're about to make {email.email} your primary email. Sign-in codes and account notices
          go there from now on.
        </Trans>,
      )
      setConfirmation(email.email)
    } catch (err) {
      setError(actionError(err, t`We couldn't change your primary email. Try again.`))
    }
  }

  const handleRemove = async (email: EmailAddress): Promise<void> => {
    setError(null)
    try {
      await guard(
        () => removeEmail.mutateAsync(email.id),
        <Trans>You're about to remove {email.email} from your account.</Trans>,
      )
      setRemoving(null)
    } catch (err) {
      setRemoving(null)
      setError(actionError(err, t`We couldn't remove that email. Try again.`))
    }
  }

  const list = emails.data?.data ?? []
  const confirmedPrimary = confirmation

  return (
    <AccountSection
      title={<Trans>Email addresses</Trans>}
      description={
        confirmedPrimary ? (
          <Trans>{confirmedPrimary} is now your primary address.</Trans>
        ) : (
          <Trans>We send sign-in codes and account notices to your primary address.</Trans>
        )
      }
      action={
        isGuest ? null : (
          <Button variant="secondary" onClick={() => setDialog({ kind: 'add' })}>
            <Trans>Add email…</Trans>
          </Button>
        )
      }
    >
      {emails.isPending ? (
        <div {...stylex.props(surface.skeletonStack)}>
          <Skeleton height="1.5rem" />
          <Skeleton height="1.5rem" />
        </div>
      ) : emails.error ? (
        <p {...stylex.props(surface.note)}>
          <Trans>We couldn't load your email addresses. Refresh the page to try again.</Trans>
        </p>
      ) : list.length === 0 ? (
        <p {...stylex.props(surface.note)}>
          <Trans>None yet. We'd send a 6-digit code to confirm it.</Trans>
        </p>
      ) : (
        list.map((email) => (
          <AccountRow
            key={email.id}
            title={email.email}
            badges={
              email.isPrimary ? (
                <Badge>
                  <Trans>Primary</Trans>
                </Badge>
              ) : !email.verified ? (
                <Badge tone="warning">
                  <Trans>Unverified</Trans>
                </Badge>
              ) : null
            }
            actions={
              email.isPrimary ? (
                <span {...stylex.props(surface.rowMeta)}>
                  <Trans>Can't be removed while primary</Trans>
                </span>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => setRemoving(email)}
                    aria-label={t`Remove ${email.email}`}
                    {...stylex.props(surface.quietButton)}
                  >
                    <Trans>Remove…</Trans>
                  </button>
                  {email.verified ? (
                    <Button
                      variant="secondary"
                      isLoading={makePrimary.isPending && makePrimary.variables === email.id}
                      onClick={() => void handleMakePrimary(email)}
                      aria-label={t`Make ${email.email} primary`}
                    >
                      <Trans>Make primary…</Trans>
                    </Button>
                  ) : (
                    <Button
                      variant="secondary"
                      isLoading={sendCode.isPending && sendCode.variables === email.id}
                      onClick={() => void startVerify(email)}
                      aria-label={t`Verify ${email.email}`}
                    >
                      <Trans>Verify…</Trans>
                    </Button>
                  )}
                </>
              )
            }
          />
        ))
      )}
      {error ? (
        <div {...stylex.props(surface.note)}>
          <Alert tone="error">{error}</Alert>
        </div>
      ) : null}
      {dialog ? (
        <ContactCodeDialog
          kind="email"
          pending={dialog.kind === 'verify' ? dialog.pending : undefined}
          send={async (target) => {
            const created = await addEmail.mutateAsync(target)
            return { id: created.id, target: created.email }
          }}
          resend={async (pending) => {
            const existing = list.find((item) => item.email === pending.target && !item.pending)
            const next = existing
              ? await sendCode.mutateAsync(existing.id)
              : await addEmail.mutateAsync(pending.target)
            return { id: next.id, target: next.email }
          }}
          verify={async (pending, code) => {
            await verifyEmail.mutateAsync({ id: pending.id, code })
          }}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {removing ? (
        <ConfirmDialog
          title={<Trans>Remove {removing.email}?</Trans>}
          description={
            <Trans>
              You won't be able to sign in with this address or get account notices there.
            </Trans>
          }
          confirmLabel={<Trans>Remove email</Trans>}
          isLoading={removeEmail.isPending}
          onConfirm={() => void handleRemove(removing)}
          onCancel={() => setRemoving(null)}
        />
      ) : null}
    </AccountSection>
  )
}
