// 吊销单个 passkey 的确认框:设备丢失或被盗时使用,用户随后被登出所有设备。

import { Trans, useLingui } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import { ConfirmDialog } from '@xid-kit/web-ui/ConfirmDialog'
import { useManagementErrorMessage } from '@xid-kit/web-ui/api-error-message'
import { useToast } from '@xid-kit/web-ui/ui'
import { useRevokeUserPasskey } from '../user-api'

export function RevokePasskeyDialog({
  userId,
  name,
  passkey,
  onDone,
}: {
  userId: string
  name: string
  passkey: { id: string; deviceName: string | null }
  onDone: () => void
}): ReactNode {
  const { t } = useLingui()
  const { notify } = useToast()
  const errorMessage = useManagementErrorMessage()
  const mutation = useRevokeUserPasskey(userId)
  const device = passkey.deviceName ?? t`this passkey`
  return (
    <ConfirmDialog
      title={<Trans>Remove {device}?</Trans>}
      description={
        <Trans>
          {name} can no longer sign in with this passkey and is signed out everywhere. Other
          passkeys and sign-in methods keep working. {name} can add a new passkey from the Security
          page of their account after signing in another way.
        </Trans>
      }
      confirmLabel={<Trans>Remove passkey</Trans>}
      confirmVariant="danger"
      isLoading={mutation.isPending}
      error={errorMessage(mutation.error)}
      onConfirm={() =>
        mutation.mutate(passkey.id, {
          onSuccess: () => {
            notify({ title: t`Passkey removed for ${name}` })
            onDone()
          },
        })
      }
      onCancel={onDone}
    />
  )
}
