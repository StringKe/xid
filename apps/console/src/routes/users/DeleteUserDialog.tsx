// 删除用户:列出确定会发生的后果,输入邮箱(无邮箱时输入用户 ID)确认;cookie 会话需要 step-up,
// 收到 step_up_required 时去 Core /mfa 重新验证,带着 confirm=delete 回到当前页再次打开本对话框。

import { Plural, Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { useManagementErrorMessage } from '@xid-kit/web-ui/api-error-message'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { text, weight } from '@xid-kit/web-ui/styles/scale.stylex'
import { Alert, Button, Dialog, Field, Input, useToast } from '@xid-kit/web-ui/ui'
import { useUserAction } from './user-api'
import type { ActionTarget } from './UserActions'

const styles = stylex.create({
  list: {
    margin: 0,
    paddingInlineStart: '1.25rem',
    display: 'flex',
    flexDirection: 'column',
    gap: '0.375rem',
    fontSize: text.base,
  },
  subhead: {
    margin: 0,
    fontSize: text.base,
    fontWeight: weight.display,
  },
  stepUp: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '0.75rem',
    padding: '0.75rem',
    borderRadius: tokens['--xid-radius'],
    boxShadow: `inset 0 0 0 1px ${tokens['--xid-border']}`,
  },
  stepUpText: {
    margin: 0,
    flex: '1 1 14rem',
    fontSize: text.sm,
    color: tokens['--xid-muted-foreground'],
  },
  footerEnd: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '0.5rem',
    justifyContent: 'flex-end',
  },
})

export function stepUpUrl(returnTo: string): string {
  const params = new URLSearchParams({ step_up: '1', redirect_to: returnTo })
  return `/mfa?${params.toString()}`
}

function returnPathWithConfirm(): string {
  const { pathname, search } = globalThis.location
  const params = new URLSearchParams(search)
  params.set('confirm', 'delete')
  return `${pathname}?${params.toString()}`
}

export function DeleteUserDialog({
  target,
  onClose,
  onDeleted,
  onSuspendInstead,
  directoryManaged = false,
}: {
  target: ActionTarget
  onClose: () => void
  onDeleted: () => void
  onSuspendInstead: () => void
  directoryManaged?: boolean
}): ReactNode {
  const { t } = useLingui()
  const { notify } = useToast()
  const errorMessage = useManagementErrorMessage()
  const mutation = useUserAction()
  const suspend = useUserAction()
  const [typed, setTyped] = useState('')
  const expected = target.email ?? target.id
  const name = target.name
  const matches = typed.trim().toLowerCase() === expected.toLowerCase()
  const needsStepUp = mutation.error?.code === 'step_up_required'
  const sessions = target.activeSessions

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !mutation.isPending) onClose()
      }}
      title={<Trans>Delete {name}?</Trans>}
      description={
        <Trans>
          This cannot be undone from the Console. If {name} may come back, suspend the account
          instead; suspending keeps everything.
        </Trans>
      }
      position={{ narrow: 'fullscreen', regular: 'center' }}
      size="md"
      dismissible={!mutation.isPending}
      footer={
        <>
          <Button variant="secondary" disabled={mutation.isPending} onClick={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <div {...stylex.props(styles.footerEnd)}>
            {target.status === 'active' ? (
              <Button
                variant="ghost"
                isLoading={suspend.isPending}
                disabled={mutation.isPending}
                onClick={() =>
                  suspend.mutate(
                    { action: 'suspend', userId: target.id },
                    {
                      onSuccess: () => {
                        notify({ title: t`${name} is suspended` })
                        onSuspendInstead()
                      },
                    },
                  )
                }
              >
                <Trans>Suspend instead</Trans>
              </Button>
            ) : null}
            <Button
              variant="danger"
              disabled={!matches}
              isLoading={mutation.isPending}
              onClick={() =>
                mutation.mutate(
                  { action: 'delete', userId: target.id },
                  {
                    onSuccess: () => {
                      notify({ title: t`${name} was deleted` })
                      onDeleted()
                    },
                  },
                )
              }
            >
              <Trans>Delete user</Trans>
            </Button>
          </div>
        </>
      }
    >
      <p {...stylex.props(styles.subhead)}>
        <Trans>Deleting {name} will</Trans>
      </p>
      <ul {...stylex.props(styles.list)}>
        <li>
          {sessions === undefined || sessions === 0 ? (
            <Trans>End every active session right away</Trans>
          ) : (
            <Plural
              value={sessions}
              one="End # active session right away"
              other="End # active sessions right away"
            />
          )}
        </li>
        <li>
          <Trans>Stop sign-in with every method {name} has set up</Trans>
        </li>
        <li>
          <Trans>Keep audit log entries, which are never deleted</Trans>
        </li>
      </ul>
      {directoryManaged ? (
        <Alert tone="warning">
          <Trans>
            {name} is managed by directory sync. Unassign the user in your identity provider first,
            or the next sync creates the account again.
          </Trans>
        </Alert>
      ) : null}
      <Field label={<Trans>Type {expected} to confirm</Trans>}>
        <Input
          value={typed}
          onChange={(event) => setTyped(event.currentTarget.value)}
          autoComplete="off"
          spellCheck={false}
        />
      </Field>
      {needsStepUp ? (
        <div {...stylex.props(styles.stepUp)}>
          <p {...stylex.props(styles.stepUpText)}>
            <Trans>
              Deleting a user needs a fresh check that it is you. It stays valid for 5 minutes.
            </Trans>
          </p>
          <Button
            variant="secondary"
            onClick={() => globalThis.location.assign(stepUpUrl(returnPathWithConfirm()))}
          >
            <Trans>Confirm it is you</Trans>
          </Button>
        </div>
      ) : mutation.error ? (
        <Alert tone="error">{errorMessage(mutation.error)}</Alert>
      ) : suspend.error ? (
        <Alert tone="error">{errorMessage(suspend.error)}</Alert>
      ) : null}
    </Dialog>
  )
}
