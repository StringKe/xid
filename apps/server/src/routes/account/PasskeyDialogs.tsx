// 重命名与删除 passkey 的对话框。删除最后一个时写明之后用什么登录;删除需要 step-up。

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Alert, Button, Dialog, TextField } from '../../components/ui'
import { useAuth } from '../../lib/auth-context'
import { useAccountBrand } from './use-account-brand'
import { surface } from './account-surface'
import { PasskeyIcon, PasskeyMeta } from './PasskeyCard'
import { passkeyName, passkeyStyles as styles } from './passkey-section-styles'
import {
  useMfaFactorsQuery,
  useRemovePasskey,
  useRenamePasskey,
  useSocialConnectionsQuery,
} from './queries'
import { useStepUpGuard } from './step-up'
import type { PasskeyCredential } from './types'
import { errorCode, useActionError } from './use-security-action-error'

export function RenamePasskeyDialog({
  passkey,
  onClose,
  onRenamed,
}: {
  passkey: PasskeyCredential
  onClose: () => void
  onRenamed: () => void
}): ReactNode {
  const { t } = useLingui()
  const rename = useRenamePasskey()
  const actionError = useActionError()
  const [open, setOpen] = useState(true)
  const [name, setName] = useState(passkey.deviceName ?? '')
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    setError(null)
    try {
      await rename.mutateAsync({ id: passkey.id, deviceName: name.trim() })
      onRenamed()
      setOpen(false)
    } catch (err) {
      setError(actionError(err, t`We couldn't rename this passkey. Try again.`))
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !rename.isPending) setOpen(false)
      }}
      onOpenChangeComplete={(isOpen) => {
        if (!isOpen) onClose()
      }}
      title={<Trans>Rename passkey</Trans>}
      description={<Trans>Pick a name you'll recognize, like the device it's saved on.</Trans>}
      footer={
        <>
          <Button variant="secondary" disabled={rename.isPending} onClick={() => setOpen(false)}>
            <Trans>Cancel</Trans>
          </Button>
          <Button variant="accent" type="submit" form="rename-passkey" isLoading={rename.isPending}>
            <Trans>Save name</Trans>
          </Button>
        </>
      }
    >
      <form id="rename-passkey" onSubmit={(event) => void handleSubmit(event)}>
        <TextField
          label={<Trans>Name</Trans>}
          value={name}
          maxLength={64}
          onChange={(event) => setName(event.target.value)}
          autoFocus
        />
      </form>
      {error ? <Alert tone="error">{error}</Alert> : null}
    </Dialog>
  )
}

function useRemainingSignInDescription(): ReactNode {
  const { user } = useAuth()
  const factors = useMfaFactorsQuery()
  const social = useSocialConnectionsQuery()
  const appName = useAccountBrand().name
  const hasTotp = factors.data?.some((factor) => factor.type === 'totp') ?? false
  const provider = social.data?.[0]?.provider
  if (user?.hasPassword && hasTotp) {
    return (
      <Trans>
        After this, you'll sign in to {appName} with your password and a code from your
        authenticator app.
      </Trans>
    )
  }
  if (user?.hasPassword) {
    return <Trans>After this, you'll sign in to {appName} with your password.</Trans>
  }
  if (provider) {
    return (
      <Trans>
        After this, you'll sign in to {appName} with your {provider} account.
      </Trans>
    )
  }
  return <Trans>After this, you'll sign in to {appName} with a code sent to your email.</Trans>
}

export function RemovePasskeyDialog({
  passkey,
  isLast,
  onClose,
  onRemoved,
  onOnlyMethod,
}: {
  passkey: PasskeyCredential
  isLast: boolean
  onClose: () => void
  onRemoved: (name: string) => void
  onOnlyMethod: () => void
}): ReactNode {
  const { t } = useLingui()
  const remove = useRemovePasskey()
  const guard = useStepUpGuard()
  const actionError = useActionError()
  const remaining = useRemainingSignInDescription()
  const [open, setOpen] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const name = passkeyName(passkey, t`Passkey`)
  const appName = useAccountBrand().name

  const handleRemove = async (): Promise<void> => {
    setError(null)
    try {
      await guard(
        () => remove.mutateAsync(passkey.id),
        <Trans>You're about to remove the passkey {name}.</Trans>,
      )
      onRemoved(name)
      setOpen(false)
    } catch (err) {
      if (errorCode(err) === 'sign_in_method_required') {
        setOpen(false)
        onOnlyMethod()
        return
      }
      setError(actionError(err, t`We couldn't remove this passkey. Try again.`))
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !remove.isPending) setOpen(false)
      }}
      onOpenChangeComplete={(isOpen) => {
        if (!isOpen) onClose()
      }}
      title={isLast ? <Trans>Remove your only passkey?</Trans> : <Trans>Remove {name}?</Trans>}
      footer={
        <>
          <Button variant="secondary" disabled={remove.isPending} onClick={() => setOpen(false)}>
            <Trans>Cancel</Trans>
          </Button>
          <Button variant="danger" isLoading={remove.isPending} onClick={() => void handleRemove()}>
            <Trans>Remove passkey</Trans>
          </Button>
        </>
      }
    >
      <div {...stylex.props(styles.removedCard)}>
        <PasskeyIcon passkey={passkey} />
        <div {...stylex.props(styles.cardBody)}>
          <span {...stylex.props(surface.rowTitle)}>{name}</span>
          <PasskeyMeta passkey={passkey} />
        </div>
      </div>
      {isLast ? <p {...stylex.props(styles.consequence)}>{remaining}</p> : null}
      <p {...stylex.props(styles.fineprint)}>
        <Trans>
          This only removes it from your {appName} account. The passkey stays in the password
          manager or on the security key where you created it until you delete it there.
        </Trans>
      </p>
      {error ? <Alert tone="error">{error}</Alert> : null}
    </Dialog>
  )
}
