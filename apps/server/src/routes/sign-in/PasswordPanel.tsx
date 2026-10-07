// 密码步骤:登录时只有密码(可显示),注册分支多出资料字段并改用「Create a password」与长度提示。

import { Trans } from '@lingui/react/macro'
import type { FormEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Button, PasswordField } from '../../components/ui'
import { Link } from '@xid-kit/web-ui/tanstack-router'
import { AuthHeading } from '../../components/hosted/AuthHeading'
import { hosted } from '../../components/hosted/hosted-styles'
import { ProfileFields } from './SignInFields'
import type { ProfileFieldKey } from './shared'
import type { SignInActions, SignInState } from './sign-in-types'

const MIN_PASSWORD_LENGTH = 12

export type PasswordPanelProps = {
  state: SignInState
  actions: SignInActions
  above: ReactNode
  createTitle: ReactNode
  forgotPasswordHref: string
  profileFields: readonly ProfileFieldKey[]
  requiredFields: readonly ProfileFieldKey[]
  inlineError: string | null
}

function LengthHint({ length }: { length: number }): ReactNode {
  if (length === 0) return <Trans>Use at least {MIN_PASSWORD_LENGTH} characters.</Trans>
  return (
    <Trans>
      Use at least {MIN_PASSWORD_LENGTH} characters. {length} so far.
    </Trans>
  )
}

export function PasswordPanel(props: PasswordPanelProps): ReactNode {
  const { state, actions } = props
  const creating = state.isSignUpFlow
  const profileComplete = props.requiredFields.every(
    (field) => state.profileValues[field].trim() !== '',
  )

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    actions.submitPassword()
  }

  return (
    <div {...stylex.props(hosted.screen)}>
      <AuthHeading
        above={props.above}
        title={creating ? props.createTitle : <Trans>Enter your password</Trans>}
        lead={
          creating ? (
            <Trans>Add your details and a password to create your account.</Trans>
          ) : undefined
        }
      />
      <form noValidate onSubmit={handleSubmit} {...stylex.props(hosted.form)}>
        {creating ? (
          <ProfileFields
            fields={props.profileFields}
            requiredFields={props.requiredFields}
            values={state.profileValues}
            disabled={state.isLoading}
            onChange={actions.setProfileValue}
          />
        ) : null}
        <PasswordField
          name="password"
          label={creating ? <Trans>Create a password</Trans> : <Trans>Password</Trans>}
          labelAction={
            creating ? undefined : (
              <Link to={props.forgotPasswordHref} {...stylex.props(hosted.textLink)}>
                <Trans>Forgot password?</Trans>
              </Link>
            )
          }
          autoComplete={creating ? 'new-password' : 'current-password'}
          value={state.password}
          onChange={(event) => actions.setPassword(event.target.value)}
          hint={creating ? <LengthHint length={state.password.length} /> : undefined}
          error={props.inlineError ?? undefined}
          autoFocus
        />
        <Button
          type="submit"
          variant="accent"
          size="lg"
          fullWidth
          isLoading={state.isLoading}
          disabled={!state.turnstileReady || state.password === '' || !profileComplete}
        >
          {creating ? <Trans>Create account</Trans> : <Trans>Sign in</Trans>}
        </Button>
      </form>
    </div>
  )
}
