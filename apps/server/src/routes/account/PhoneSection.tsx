// 资料页「Phone number」:用短信 6 位码添加手机号、移除。添加手机号不会开启短信两步验证。

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
import { useAddPhone, usePhonesQuery, useRemovePhone, useVerifyPhone } from './queries'
import { useStepUpGuard } from './step-up'
import type { PhoneNumber } from './types'
import { useActionError } from './use-security-action-error'

export function PhoneSection(): ReactNode {
  const { t } = useLingui()
  const { user } = useAuth()
  const phones = usePhonesQuery()
  const addPhone = useAddPhone()
  const verifyPhone = useVerifyPhone()
  const removePhone = useRemovePhone()
  const guard = useStepUpGuard()
  const actionError = useActionError()
  const [dialog, setDialog] = useState<{ pending?: PendingContact } | null>(null)
  const [removing, setRemoving] = useState<PhoneNumber | null>(null)
  const [error, setError] = useState<string | null>(null)

  const list = phones.data?.data ?? []
  const verified = list.filter((phone) => !phone.pending)
  const canAdd = (phones.data?.canAdd ?? false) && !isGuestUser(user)

  const handleRemove = async (phone: PhoneNumber): Promise<void> => {
    setError(null)
    try {
      await guard(
        () => removePhone.mutateAsync(phone.id),
        <Trans>You're about to remove {phone.phone} from your account.</Trans>,
      )
      setRemoving(null)
    } catch (err) {
      setRemoving(null)
      setError(actionError(err, t`We couldn't remove that number. Try again.`))
    }
  }

  const description =
    verified.length === 0 ? (
      canAdd ? (
        <Trans>None added. Apps can text you account notices once you add one.</Trans>
      ) : (
        <Trans>None added. This organization doesn't send text messages yet.</Trans>
      )
    ) : (
      <Trans>
        Verified numbers aren't used for two-step verification until you turn on text message codes
        in Security.
      </Trans>
    )

  return (
    <AccountSection
      title={<Trans>Phone number</Trans>}
      description={description}
      action={
        canAdd ? (
          <Button variant="secondary" onClick={() => setDialog({})}>
            <Trans>Add phone number…</Trans>
          </Button>
        ) : null
      }
    >
      {phones.isPending ? (
        <div {...stylex.props(surface.skeletonStack)}>
          <Skeleton height="1.5rem" />
        </div>
      ) : phones.error ? (
        <p {...stylex.props(surface.note)}>
          <Trans>We couldn't load your phone numbers. Refresh the page to try again.</Trans>
        </p>
      ) : (
        list.map((phone) => (
          <AccountRow
            key={phone.id}
            title={phone.phone}
            badges={
              phone.pending ? (
                <Badge tone="warning">
                  <Trans>Unverified</Trans>
                </Badge>
              ) : (
                <Badge tone="success">
                  <Trans>Verified</Trans>
                </Badge>
              )
            }
            actions={
              <>
                <button
                  type="button"
                  onClick={() => setRemoving(phone)}
                  aria-label={t`Remove ${phone.phone}`}
                  {...stylex.props(surface.quietButton)}
                >
                  <Trans>Remove…</Trans>
                </button>
                {phone.pending ? (
                  <Button
                    variant="secondary"
                    onClick={() => setDialog({ pending: { id: phone.id, target: phone.phone } })}
                  >
                    <Trans>Verify…</Trans>
                  </Button>
                ) : null}
              </>
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
          kind="phone"
          pending={dialog.pending}
          send={async (target) => {
            const created = await addPhone.mutateAsync(target)
            return { id: created.id, target: created.phone }
          }}
          resend={async (pending) => {
            const next = await addPhone.mutateAsync(pending.target)
            return { id: next.id, target: next.phone }
          }}
          verify={async (pending, code) => {
            await verifyPhone.mutateAsync({ id: pending.id, code })
          }}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {removing ? (
        <ConfirmDialog
          title={<Trans>Remove {removing.phone}?</Trans>}
          description={
            <Trans>
              Text message codes for two-step verification stop going to this number too.
            </Trans>
          }
          confirmLabel={<Trans>Remove number</Trans>}
          isLoading={removePhone.isPending}
          onConfirm={() => void handleRemove(removing)}
          onCancel={() => setRemoving(null)}
        />
      ) : null}
    </AccountSection>
  )
}
