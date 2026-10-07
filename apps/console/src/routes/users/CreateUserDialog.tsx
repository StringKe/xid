// 创建用户:姓名、邮箱、手机号,可选发送设置密码邮件。租户内邮箱或手机号已存在时在对应字段提示。

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { errorTargetsField, useManagementErrorMessage } from '@xid-kit/web-ui/api-error-message'
import { Alert, Button, CheckboxField, Dialog, Field, Input, useToast } from '@xid-kit/web-ui/ui'
import { useCreateUser } from './user-api'

const styles = stylex.create({
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(10rem, 1fr))',
    gap: '0.75rem',
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
  },
})

export function CreateUserDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean
  onClose: () => void
  onCreated: (userId: string) => void
}): ReactNode {
  const { t } = useLingui()
  const { notify } = useToast()
  const errorMessage = useManagementErrorMessage()
  const create = useCreateUser()
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [sendSetup, setSendSetup] = useState(true)
  const error = create.error
  const fieldError = (field: string) =>
    errorTargetsField(error, field) ? errorMessage(error) : undefined
  const generalError =
    error && !['email', 'phone', 'username'].some((field) => errorTargetsField(error, field))
      ? errorMessage(error)
      : undefined

  function submit(event: FormEvent): void {
    event.preventDefault()
    create.mutate(
      {
        ...(firstName.trim() ? { first_name: firstName.trim() } : {}),
        ...(lastName.trim() ? { last_name: lastName.trim() } : {}),
        ...(email.trim() ? { email: email.trim() } : {}),
        ...(phone.trim() ? { phone: phone.trim() } : {}),
        send_password_setup: Boolean(email.trim()) && sendSetup,
      },
      {
        onSuccess: (user) => {
          notify({ title: t`User created` })
          onCreated(user.id)
        },
      },
    )
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => (next || create.isPending ? undefined : onClose())}
      title={<Trans>Create user</Trans>}
      description={
        <Trans>
          The user can sign in with any method your sign-in policy allows. Add an email to send a
          password setup link.
        </Trans>
      }
      position={{ narrow: 'fullscreen', regular: 'center' }}
      size="md"
      footer={
        <>
          <Button variant="secondary" disabled={create.isPending} onClick={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button type="submit" form="create-user-form" isLoading={create.isPending}>
            <Trans>Create user</Trans>
          </Button>
        </>
      }
    >
      <form id="create-user-form" onSubmit={submit} noValidate {...stylex.props(styles.form)}>
        <div {...stylex.props(styles.grid)}>
          <Field label={<Trans>First name</Trans>}>
            <Input
              value={firstName}
              onChange={(e) => setFirstName(e.currentTarget.value)}
              autoComplete="off"
            />
          </Field>
          <Field label={<Trans>Last name</Trans>}>
            <Input
              value={lastName}
              onChange={(e) => setLastName(e.currentTarget.value)}
              autoComplete="off"
            />
          </Field>
        </div>
        <Field label={<Trans>Email</Trans>} error={fieldError('email')}>
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.currentTarget.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
        <Field
          label={<Trans>Phone number</Trans>}
          hint={<Trans>Include the country code, for example +1 415 555 0100.</Trans>}
          error={fieldError('phone')}
        >
          <Input
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.currentTarget.value)}
            autoComplete="off"
          />
        </Field>
        <CheckboxField
          checked={sendSetup && Boolean(email.trim())}
          disabled={!email.trim()}
          onCheckedChange={setSendSetup}
          label={<Trans>Email a link to set a password</Trans>}
        />
        {generalError ? <Alert tone="error">{generalError}</Alert> : null}
      </form>
    </Dialog>
  )
}
