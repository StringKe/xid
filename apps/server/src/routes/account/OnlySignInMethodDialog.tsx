// 移除最后一种登录方式被拒时的说明:按钮不禁用,点了才解释原因,并直接给出先添加哪种方式。

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { leading, text } from '@xid-kit/web-ui/styles/scale.stylex'
import { Alert, Button, Dialog } from '../../components/ui'
import { useAuth } from '../../lib/auth-context'
import { tokens } from '../../styles/tokens.stylex'
import { PasswordDialog } from './PasswordSection'
import { useRegisterPasskey } from './queries'
import { useStepUpGuard } from './step-up'
import { useActionError } from './use-security-action-error'

const styles = stylex.create({
  consequence: {
    margin: 0,
    fontSize: text.base,
    lineHeight: '1.375rem',
    color: tokens['--xid-fg'],
  },
  next: {
    margin: 0,
    fontSize: text.base,
    lineHeight: leading.md,
    color: tokens['--xid-muted-foreground'],
  },
  actions: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '0.5rem',
  },
})

export function OnlySignInMethodDialog({
  title,
  consequence,
  onClose,
}: {
  title: ReactNode
  consequence: ReactNode
  onClose: () => void
}): ReactNode {
  const { t } = useLingui()
  const { user } = useAuth()
  const registerPasskey = useRegisterPasskey()
  const guard = useStepUpGuard()
  const actionError = useActionError()
  const [open, setOpen] = useState(true)
  const [settingPassword, setSettingPassword] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const createPasskey = async (): Promise<void> => {
    setError(null)
    try {
      await guard(
        () => registerPasskey.mutateAsync({}),
        <Trans>You're about to add a passkey to your account.</Trans>,
      )
      setOpen(false)
    } catch (err) {
      if (err instanceof DOMException) return
      setError(actionError(err, t`The passkey wasn't created. Try again.`))
    }
  }

  return (
    <>
      <Dialog
        open={open && !settingPassword}
        onOpenChange={(next) => {
          if (!next) setOpen(false)
        }}
        onOpenChangeComplete={(isOpen) => {
          if (!isOpen && !settingPassword) onClose()
        }}
        title={title}
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              <Trans>Close</Trans>
            </Button>
            <div {...stylex.props(styles.actions)}>
              {user?.hasPassword ? null : (
                <Button variant="secondary" onClick={() => setSettingPassword(true)}>
                  <Trans>Set a password…</Trans>
                </Button>
              )}
              <Button isLoading={registerPasskey.isPending} onClick={() => void createPasskey()}>
                <Trans>Create a passkey</Trans>
              </Button>
            </div>
          </>
        }
      >
        <p {...stylex.props(styles.consequence)}>{consequence}</p>
        <p {...stylex.props(styles.next)}>
          <Trans>
            Add another way to sign in first. Then you can remove this one from this page.
          </Trans>
        </p>
        {error ? <Alert tone="error">{error}</Alert> : null}
      </Dialog>
      {settingPassword ? (
        <PasswordDialog
          hasPassword={false}
          onClose={() => {
            setSettingPassword(false)
            setOpen(false)
            onClose()
          }}
        />
      ) : null}
    </>
  )
}
