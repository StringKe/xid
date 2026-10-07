// 用户管理动作:列表行菜单与详情页「Actions」共用同一顺序与同一组确认框。
// 顺序:Reset password、Reset MFA、Sign out everywhere、Suspend / Resume、Delete(最后,需输入邮箱 + step-up)。

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { ConfirmDialog } from '@xid-kit/web-ui/ConfirmDialog'
import { useManagementErrorMessage } from '@xid-kit/web-ui/api-error-message'
import { Dropdown, Icon, useToast } from '@xid-kit/web-ui/ui'
import type { DropdownItem } from '@xid-kit/web-ui/ui'
import type { UserAction, UserStatus } from './user-api'
import { useUserAction } from './user-api'
import { list } from '../../components/page/list-styles'
import { DeleteUserDialog } from './DeleteUserDialog'

export type ActionTarget = {
  id: string
  name: string
  email: string | null
  status: UserStatus
  activeSessions?: number
}

export function userActionItems(
  target: ActionTarget,
  onSelect: (action: UserAction) => void,
): DropdownItem[] {
  if (target.status === 'deleted') return []
  return [
    {
      key: 'password_reset',
      label: <Trans>Reset password…</Trans>,
      disabled: target.email === null,
      onSelect: () => onSelect('password_reset'),
    },
    { key: 'mfa_reset', label: <Trans>Reset MFA…</Trans>, onSelect: () => onSelect('mfa_reset') },
    {
      key: 'sign_out',
      label: <Trans>Sign out everywhere</Trans>,
      onSelect: () => onSelect('sign_out'),
    },
    target.status === 'banned'
      ? {
          key: 'resume',
          label: <Trans>Resume user</Trans>,
          separatorBefore: true,
          onSelect: () => onSelect('resume'),
        }
      : {
          key: 'suspend',
          label: <Trans>Suspend user…</Trans>,
          separatorBefore: true,
          onSelect: () => onSelect('suspend'),
        },
    {
      key: 'delete',
      label: <Trans>Delete user…</Trans>,
      tone: 'danger',
      separatorBefore: true,
      onSelect: () => onSelect('delete'),
    },
  ]
}

function ActionConfirm({
  action,
  target,
  onDone,
}: {
  action: Exclude<UserAction, 'delete'>
  target: ActionTarget
  onDone: () => void
}): ReactNode {
  const { t } = useLingui()
  const { notify } = useToast()
  const errorMessage = useManagementErrorMessage()
  const mutation = useUserAction()
  const name = target.name
  const email = target.email ?? ''
  const copy: Record<
    typeof action,
    { title: ReactNode; description: ReactNode; confirm: ReactNode }
  > = {
    password_reset: {
      title: <Trans>Send a password reset link to {name}?</Trans>,
      description: (
        <Trans>
          XID emails a reset link to {email}. It works once and expires in 15 minutes. The current
          password keeps working until it is changed.
        </Trans>
      ),
      confirm: <Trans>Send reset link</Trans>,
    },
    mfa_reset: {
      title: <Trans>Reset two-step verification for {name}?</Trans>,
      description: (
        <Trans>
          This removes the authenticator app, text message codes and backup codes. Passkeys stay.{' '}
          {name} is signed out everywhere and sets up two-step verification again at the next
          sign-in if the organization requires it.
        </Trans>
      ),
      confirm: <Trans>Reset MFA</Trans>,
    },
    sign_out: {
      title: <Trans>Sign {name} out everywhere?</Trans>,
      description: (
        <Trans>
          Every session ends right away and refresh tokens stop working. Access tokens already
          issued stay valid until they expire.
        </Trans>
      ),
      confirm: <Trans>Sign out everywhere</Trans>,
    },
    suspend: {
      title: <Trans>Suspend {name}?</Trans>,
      description: (
        <Trans>
          {name} cannot sign in until you resume the account. Nothing is deleted. Existing sessions
          end the next time they refresh.
        </Trans>
      ),
      confirm: <Trans>Suspend user</Trans>,
    },
    resume: {
      title: <Trans>Resume {name}?</Trans>,
      description: <Trans>{name} can sign in again with the methods already set up.</Trans>,
      confirm: <Trans>Resume user</Trans>,
    },
  }
  const done: Record<typeof action, string> = {
    password_reset: t`Reset link sent to ${email}`,
    mfa_reset: t`Two-step verification reset for ${name}`,
    sign_out: t`${name} was signed out everywhere`,
    suspend: t`${name} is suspended`,
    resume: t`${name} can sign in again`,
  }
  return (
    <ConfirmDialog
      title={copy[action].title}
      description={copy[action].description}
      confirmLabel={copy[action].confirm}
      confirmVariant={action === 'resume' || action === 'password_reset' ? 'primary' : 'danger'}
      isLoading={mutation.isPending}
      error={errorMessage(mutation.error)}
      onConfirm={() =>
        mutation.mutate(
          { action, userId: target.id },
          {
            onSuccess: () => {
              notify({ title: done[action] })
              onDone()
            },
          },
        )
      }
      onCancel={onDone}
    />
  )
}

export function UserActionDialogs({
  action,
  target,
  onClose,
  onDeleted,
}: {
  action: UserAction | null
  target: ActionTarget | null
  onClose: () => void
  onDeleted?: () => void
}): ReactNode {
  if (!action || !target) return null
  if (action === 'delete') {
    return (
      <DeleteUserDialog
        target={target}
        onClose={onClose}
        onDeleted={() => {
          onClose()
          onDeleted?.()
        }}
        onSuspendInstead={() => onClose()}
      />
    )
  }
  return <ActionConfirm action={action} target={target} onDone={onClose} />
}

export function UserRowMenu({
  target,
  onSelect,
}: {
  target: ActionTarget
  onSelect: (action: UserAction) => void
}): ReactNode {
  const { t } = useLingui()
  const items = userActionItems(target, onSelect)
  if (items.length === 0) return null
  const name = target.name
  return (
    <Dropdown
      ariaLabel={t`Actions for ${name}`}
      align="end"
      triggerStyle={list.iconButton}
      trigger={<Icon name="more-horizontal" size={16} />}
      items={items}
    />
  )
}

export function useUserActionState(): {
  action: UserAction | null
  target: ActionTarget | null
  open: (target: ActionTarget, action: UserAction) => void
  close: () => void
} {
  const [state, setState] = useState<{ action: UserAction; target: ActionTarget } | null>(null)
  return {
    action: state?.action ?? null,
    target: state?.target ?? null,
    open: (target, action) => setState({ target, action }),
    close: () => setState(null),
  }
}
