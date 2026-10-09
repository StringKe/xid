// Save or replace the sign-in an organization app uses. The password is write-only: it is never
// loaded back into the form.

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Button, Dialog, TextField } from '../../components/ui'
import { surface } from './account-surface'
import { useSaveSwaCredential, type SwaApp } from './swa-apps-queries'
import { useActionError } from './use-security-action-error'

export type SwaCredentialDialogProps = {
  app: SwaApp
  appName: string
  onClose: () => void
}

export function SwaCredentialDialog({
  app,
  appName,
  onClose,
}: SwaCredentialDialogProps): ReactNode {
  const { t } = useLingui()
  const save = useSaveSwaCredential()
  const actionError = useActionError()
  const [open, setOpen] = useState(true)
  const [username, setUsername] = useState(app.username ?? '')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const formId = `swa-credential-${app.id}`

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    setError(null)
    if (!username.trim() || !password) {
      setError(t`Enter the username and password you use for ${appName}.`)
      return
    }
    save.mutate(
      { connectionId: app.id, username: username.trim(), password },
      {
        onSuccess: () => setOpen(false),
        onError: (err) => setError(actionError(err, t`We couldn't save this sign-in. Try again.`)),
      },
    )
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !save.isPending) setOpen(false)
      }}
      onOpenChangeComplete={(isOpen) => {
        if (!isOpen) onClose()
      }}
      title={
        app.stored ? (
          <Trans>Update sign-in for {appName}</Trans>
        ) : (
          <Trans>Save sign-in for {appName}</Trans>
        )
      }
      description={
        <Trans>
          Enter the username and password you use on {app.targetOrigin}. They are stored encrypted
          and sent only to that site when you open the app.
        </Trans>
      }
      footer={
        <>
          <Button variant="secondary" disabled={save.isPending} onClick={() => setOpen(false)}>
            <Trans>Cancel</Trans>
          </Button>
          <Button variant="accent" type="submit" form={formId} isLoading={save.isPending}>
            <Trans>Save</Trans>
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={handleSubmit} noValidate {...stylex.props(surface.formStack)}>
        <TextField
          label={<Trans>Username</Trans>}
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          autoComplete="off"
          autoFocus
        />
        <TextField
          label={<Trans>Password</Trans>}
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="new-password"
          hint={
            app.stored ? (
              <Trans>Enter the password again to replace the saved one.</Trans>
            ) : undefined
          }
          error={error ?? undefined}
        />
      </form>
    </Dialog>
  )
}
