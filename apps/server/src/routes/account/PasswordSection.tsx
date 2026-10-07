// Security 页的 Password 区:已有密码时用旧密码修改;没有密码时在账户内直接设置(有强因子的
// 用户先重新验证),长度、泄露检查与历史规则和重置一致。

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Alert, Button, Dialog, PasswordField, Skeleton } from '../../components/ui'
import { useAuth } from '../../lib/auth-context'
import { trackPasswordChanged } from '../../lib/google-analytics-funnel'
import { useAccountBrand } from './use-account-brand'
import { AccountSection } from './AccountPage'
import { useAccountDates } from './account-format'
import { surface } from './account-surface'
import { usePasswordStatusQuery, useSetPassword } from './queries'
import { useStepUpGuard } from './step-up'
import { useActionError } from './use-security-action-error'

const PASSWORD_MIN_LENGTH = 12

type FieldErrors = { currentPassword?: string; newPassword?: string }

function paramNameOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null
  const meta = (error as { meta?: { paramName?: string } }).meta
  return meta?.paramName ?? null
}

export function PasswordDialog({
  hasPassword,
  onClose,
}: {
  hasPassword: boolean
  onClose: () => void
}): ReactNode {
  const { t } = useLingui()
  const { user } = useAuth()
  const setPassword = useSetPassword()
  const guard = useStepUpGuard()
  const actionError = useActionError()
  const [open, setOpen] = useState(true)
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [error, setError] = useState<string | null>(null)
  const appName = useAccountBrand().name
  const email = user?.email ?? ''
  const minLength = PASSWORD_MIN_LENGTH

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    setFieldErrors({})
    setError(null)
    if (newPassword.length < minLength) {
      setFieldErrors({ newPassword: t`Use at least ${minLength} characters.` })
      return
    }
    try {
      if (hasPassword) {
        await setPassword.mutateAsync({ currentPassword, newPassword })
      } else {
        await guard(
          () => setPassword.mutateAsync({ newPassword }),
          <Trans>You're about to set a password for your account.</Trans>,
        )
      }
      trackPasswordChanged()
      setOpen(false)
    } catch (err) {
      const message = actionError(err, t`We couldn't save your password. Try again.`)
      const param = paramNameOf(err)
      if (message && (param === 'currentPassword' || param === 'newPassword')) {
        setFieldErrors({ [param]: message })
      } else {
        setError(message)
      }
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !setPassword.isPending) setOpen(false)
      }}
      onOpenChangeComplete={(isOpen) => {
        if (!isOpen) onClose()
      }}
      title={hasPassword ? <Trans>Update your password</Trans> : <Trans>Set a password</Trans>}
      description={
        hasPassword ? (
          <Trans>Signing out of your other devices happens automatically after the change.</Trans>
        ) : email ? (
          <Trans>
            You can then sign in to {appName} with {email} and this password.
          </Trans>
        ) : (
          <Trans>You can then sign in to {appName} with this password.</Trans>
        )
      }
      footer={
        <>
          <Button
            variant="secondary"
            disabled={setPassword.isPending}
            onClick={() => setOpen(false)}
          >
            <Trans>Cancel</Trans>
          </Button>
          <Button
            variant="accent"
            type="submit"
            form="password-form"
            isLoading={setPassword.isPending}
          >
            {hasPassword ? <Trans>Update password</Trans> : <Trans>Set password</Trans>}
          </Button>
        </>
      }
    >
      <form
        id="password-form"
        onSubmit={(event) => void handleSubmit(event)}
        noValidate
        {...stylex.props(surface.formStack)}
      >
        {email ? (
          <input type="email" autoComplete="username" value={email} readOnly hidden />
        ) : null}
        {hasPassword ? (
          <PasswordField
            label={<Trans>Current password</Trans>}
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            autoComplete="current-password"
            error={fieldErrors.currentPassword}
            autoFocus
          />
        ) : null}
        <PasswordField
          label={<Trans>New password</Trans>}
          value={newPassword}
          onChange={(event) => setNewPassword(event.target.value)}
          autoComplete="new-password"
          hint={
            fieldErrors.newPassword ? undefined : (
              <Trans>Use at least {minLength} characters.</Trans>
            )
          }
          error={fieldErrors.newPassword}
          autoFocus={!hasPassword}
        />
      </form>
      {error ? <Alert tone="error">{error}</Alert> : null}
    </Dialog>
  )
}

export function PasswordSection(): ReactNode {
  const status = usePasswordStatusQuery()
  const dates = useAccountDates()
  const [editing, setEditing] = useState(false)
  const data = status.data
  const changed = data?.updatedAt ? dates.date(data.updatedAt) : null

  const description = !data ? null : data.hasPassword ? (
    data.breached ? (
      changed ? (
        <Trans>
          Last changed {changed}. This password has appeared in a known data breach, so change it.
        </Trans>
      ) : (
        <Trans>This password has appeared in a known data breach, so change it.</Trans>
      )
    ) : changed ? (
      <Trans>Last changed {changed}. Not found in any known data breach.</Trans>
    ) : (
      <Trans>Not found in any known data breach.</Trans>
    )
  ) : (
    <Trans>Not set. Add one so you can still sign in if your other methods aren't available.</Trans>
  )

  return (
    <AccountSection
      title={<Trans>Password</Trans>}
      description={description}
      action={
        data ? (
          <Button variant="secondary" onClick={() => setEditing(true)}>
            {data.hasPassword ? <Trans>Update password…</Trans> : <Trans>Set a password…</Trans>}
          </Button>
        ) : null
      }
    >
      {status.isPending ? (
        <div {...stylex.props(surface.skeletonStack)}>
          <Skeleton height="1.25rem" />
        </div>
      ) : status.error ? (
        <p {...stylex.props(surface.note)}>
          <Trans>We couldn't load your password status. Refresh the page to try again.</Trans>
        </p>
      ) : null}
      {editing && data ? (
        <PasswordDialog hasPassword={data.hasPassword} onClose={() => setEditing(false)} />
      ) : null}
    </AccountSection>
  )
}
