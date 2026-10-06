// 密码面板:登录与注册共用。注册模式在提交前校验 12-128 位并显示强度提示;登录模式不按长度拦截,
// 避免历史短密码账户无法登录。

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { useApiErrorMessage } from '@xid-kit/web-ui/api-error-message'
import { Button, Field, Input } from '../../components/ui'
import { PasswordStrength, scorePassword } from '../sign-up/PasswordStrength'
import { IdentifierLabel, ProfileFields } from './SignInFields'
import { styles } from './styles'
import type { IdentifierPrompt, ProfileFieldKey } from './shared'
import type { SignInActions, SignInState } from './useSignIn'

const MIN_SIGN_UP_PASSWORD_LENGTH = 12
const MAX_SIGN_UP_PASSWORD_LENGTH = 128

export type SignInPasswordPanelProps = {
  state: SignInState
  actions: SignInActions
  prompt: IdentifierPrompt
  identifierPlaceholder: string
  // 浏览器只在带 webauthn 的输入框上弹出 passkey 建议,提供 passkey 时密码面板也要带上。
  identifierAutoComplete: string
  isSignUpFlow: boolean
  profileFields: readonly ProfileFieldKey[]
  requiredFields: readonly ProfileFieldKey[]
  requiredProfileComplete: boolean
  forgotPasswordHref: string
}

function signUpPasswordLengthValid(password: string): boolean {
  return (
    password.length >= MIN_SIGN_UP_PASSWORD_LENGTH && password.length <= MAX_SIGN_UP_PASSWORD_LENGTH
  )
}

export function SignInPasswordPanel(props: SignInPasswordPanelProps): ReactNode {
  const { state, actions, prompt, isSignUpFlow } = props
  const { t } = useLingui()
  const apiErrorMessage = useApiErrorMessage()
  const [lengthError, setLengthError] = useState<string | null>(null)

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (isSignUpFlow && !signUpPasswordLengthValid(state.password)) {
      setLengthError(
        apiErrorMessage(
          { code: 'validation_failed', meta: { paramName: 'password' } },
          { surface: 'general' },
        ),
      )
      return
    }
    setLengthError(null)
    actions.submitPassword()
  }

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      {...stylex.props(styles.panel)}
      aria-label={isSignUpFlow ? t`Create your account` : t`Sign in with password`}
    >
      <Field label={<IdentifierLabel prompt={prompt} />} required>
        <Input
          type={prompt.type}
          autoComplete={props.identifierAutoComplete}
          placeholder={props.identifierPlaceholder}
          value={state.identifier}
          onChange={(e) => actions.setIdentifier(e.target.value)}
          disabled={state.isLoading}
        />
      </Field>
      <Field label={<Trans>Password</Trans>} error={lengthError ?? undefined} required>
        <Input
          type="password"
          autoComplete={isSignUpFlow ? 'new-password' : 'current-password'}
          placeholder={isSignUpFlow ? t`Minimum 12 characters` : t`Your password`}
          value={state.password}
          onChange={(e) => {
            setLengthError(null)
            actions.setPassword(e.target.value)
          }}
          disabled={state.isLoading}
        />
      </Field>
      {isSignUpFlow && state.password.length > 0 ? (
        <PasswordStrength score={scorePassword(state.password)} />
      ) : null}
      <ProfileFields
        fields={props.profileFields}
        requiredFields={props.requiredFields}
        values={state.profileValues}
        disabled={state.isLoading}
        onChange={actions.setProfileValue}
      />
      <div {...stylex.props(styles.rememberRow)}>
        <label {...stylex.props(styles.checkLabel)}>
          <input
            type="checkbox"
            checked={state.rememberMe}
            onChange={(e) => actions.setRememberMe(e.target.checked)}
            disabled={state.isLoading}
            {...stylex.props(styles.checkInput)}
          />
          <span>
            <Trans>Remember me</Trans>
          </span>
        </label>
        {isSignUpFlow ? null : (
          <a href={props.forgotPasswordHref} {...stylex.props(styles.textLink)}>
            <Trans>Forgot password?</Trans>
          </a>
        )}
      </div>
      <Button
        type="submit"
        variant="accent"
        fullWidth
        isLoading={state.isLoading}
        disabled={
          !state.identifier.trim() ||
          !state.password.trim() ||
          !props.requiredProfileComplete ||
          !state.turnstileReady
        }
      >
        {isSignUpFlow ? <Trans>Sign up</Trans> : <Trans>Sign in</Trans>}
      </Button>
    </form>
  )
}
