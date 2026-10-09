// 第一步:一个标识符输入框(autocomplete 带 webauthn,passkey 从 autofill 出现)+ Continue。
// 浏览器不支持 Conditional UI 时才显示「Continue with a passkey」,与社交按钮同级。

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Button, Field, Icon, Input } from '../../components/ui'
import { AuthHeading } from '../../components/hosted/AuthHeading'
import { hosted } from '../../components/hosted/hosted-styles'
import { Link } from '@xid-kit/web-ui/tanstack-router'
import { IdentifierLabel, useIdentifierPlaceholder } from './SignInFields'
import { SignInSocialButtons } from './SignInSocialButtons'
import { SignInTurnstileSlot } from './SignInTurnstileSlot'
import { identifierPrompt } from './shared'
import type { SignInActions, SignInState } from './sign-in-types'

export type IdentifierStepProps = {
  state: SignInState
  actions: SignInActions
  title: ReactNode
  switchIntent: ReactNode
  forgotPasswordHref: string
}

function Separator(): ReactNode {
  return (
    <div role="separator" aria-hidden="true" {...stylex.props(hosted.separator)}>
      <span {...stylex.props(hosted.separatorRule)} />
      <Trans>or</Trans>
      <span {...stylex.props(hosted.separatorRule)} />
    </div>
  )
}

export function IdentifierStep(props: IdentifierStepProps): ReactNode {
  const { t } = useLingui()
  const { state, actions } = props
  const [ssoOnly, setSsoOnly] = useState(state.authConfig.forceSso)
  const prompt = identifierPrompt(state.authConfig)
  const placeholder = useIdentifierPlaceholder(prompt)
  const passkeyOffered = state.enabledMethods.includes('passkey')
  const earlierHost = state.authConfig.earlierPasskeyRpId ?? null
  const showPasskeyButton =
    passkeyOffered &&
    state.passkeySupport === 'yes' &&
    (!state.passkeyConditionalAvailable || state.authConfig.passkeyEntry.identifierRequired)
  // 自动填充只列当前 rpId 的 passkey,较早地址的 passkey 只能经这个按钮发起。
  const showEarlierPasskeyButton =
    passkeyOffered && state.passkeySupport === 'yes' && earlierHost !== null
  const hasSocial =
    !ssoOnly &&
    !state.excludesFederatedEntry &&
    !state.authConfig.forceSso &&
    state.authConfig.socialProviders.length > 0
  const ssoAvailable = state.enabledMethods.includes('enterprise-sso') && !state.authConfig.forceSso
  const autoComplete = passkeyOffered ? `${prompt.autoComplete} webauthn` : prompt.autoComplete

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    actions.submitIdentifier({ ssoOnly })
  }

  return (
    <div {...stylex.props(hosted.screen)}>
      <AuthHeading
        title={ssoOnly ? <Trans>Sign in with single sign-on</Trans> : props.title}
        lead={
          ssoOnly ? (
            <Trans>Enter your work email. We'll send you to your company's sign-in page.</Trans>
          ) : (
            props.switchIntent
          )
        }
      />

      <form noValidate onSubmit={handleSubmit} {...stylex.props(hosted.form)}>
        <Field label={ssoOnly ? <Trans>Work email</Trans> : <IdentifierLabel prompt={prompt} />}>
          <Input
            name="identifier"
            type={ssoOnly ? 'email' : prompt.type}
            inputSize="lg"
            autoComplete={autoComplete}
            autoCapitalize="none"
            spellCheck={false}
            placeholder={placeholder}
            value={state.identifier}
            onChange={(event) => actions.setIdentifier(event.target.value)}
            autoFocus
          />
        </Field>
        <SignInTurnstileSlot />
        <Button
          type="submit"
          variant="accent"
          size="lg"
          fullWidth
          isLoading={state.isLoading}
          disabled={!state.configSettled || state.turnstileGate === 'needs_interaction'}
        >
          <Trans>Continue</Trans>
        </Button>
      </form>

      {showPasskeyButton || showEarlierPasskeyButton || hasSocial ? (
        <div {...stylex.props(hosted.group)}>
          <Separator />
          {showPasskeyButton ? (
            <Button
              variant="secondary"
              size="lg"
              fullWidth
              disabled={state.isLoading || !state.turnstileReady}
              onClick={actions.triggerPasskeyButton}
            >
              <Icon name="passkey" size={18} />
              <Trans>Continue with a passkey</Trans>
            </Button>
          ) : null}
          {showEarlierPasskeyButton ? (
            <Button
              variant="secondary"
              size="lg"
              fullWidth
              disabled={state.isLoading || !state.turnstileReady}
              onClick={actions.triggerEarlierPasskeyButton}
            >
              <Trans>Use a passkey created on {earlierHost}</Trans>
            </Button>
          ) : null}
          {hasSocial ? (
            <SignInSocialButtons
              providers={state.authConfig.socialProviders}
              onSelect={actions.handleSocial}
              isLoading={state.isLoading}
              disabled={!state.turnstileReady}
            />
          ) : null}
        </div>
      ) : null}

      <div {...stylex.props(hosted.linkRow)}>
        {ssoAvailable ? (
          <button
            type="button"
            onClick={() => setSsoOnly((value) => !value)}
            {...stylex.props(hosted.quietLink)}
          >
            {ssoOnly ? (
              <Trans>Use another way to sign in</Trans>
            ) : (
              <Trans>Use single sign-on</Trans>
            )}
          </button>
        ) : (
          <span />
        )}
        {state.enabledMethods.includes('password') && !state.isSignUpFlow ? (
          <Link to={props.forgotPasswordHref} {...stylex.props(hosted.quietLink)}>
            {t`Can't sign in?`}
          </Link>
        ) : null}
      </div>
    </div>
  )
}
