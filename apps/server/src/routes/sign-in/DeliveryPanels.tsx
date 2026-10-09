// 第二步里不需要输入凭证的方式:邮件登录链接、注册分支先收资料再发码、passkey。

import { Trans } from '@lingui/react/macro'
import type { FormEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Button, Icon, Notice } from '../../components/ui'
import { AuthHeading } from '../../components/hosted/AuthHeading'
import { hosted } from '../../components/hosted/hosted-styles'
import { maskEmail } from './identifier-mask'
import { useTargetLabel } from './OtpPanel'
import { ProfileFields } from './SignInFields'
import { SignInTurnstileSlot } from './SignInTurnstileSlot'
import type { OtpSignInMethod, ProfileFieldKey } from './shared'
import type { SignInActions, SignInState } from './sign-in-types'

type PanelProps = {
  state: SignInState
  actions: SignInActions
  above: ReactNode
}

type ProfileProps = {
  profileFields: readonly ProfileFieldKey[]
  requiredFields: readonly ProfileFieldKey[]
}

function profileComplete(state: SignInState, required: readonly ProfileFieldKey[]): boolean {
  return required.every((field) => state.profileValues[field].trim() !== '')
}

export function MagicLinkPanel(props: PanelProps & ProfileProps): ReactNode {
  const { state, actions } = props
  const target = maskEmail(state.identifier.trim())

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    actions.submitMagicLink()
  }

  if (state.magicLinkSent) {
    return (
      <div {...stylex.props(hosted.screen)}>
        <AuthHeading
          above={props.above}
          title={<Trans>Check your email</Trans>}
          lead={
            <Trans>
              We sent a sign-in link to {target}. It works once and expires in 15 minutes. Open it
              on this device to continue.
            </Trans>
          }
        />
        <SignInTurnstileSlot />
        <p {...stylex.props(hosted.note)}>
          <Trans>No email after a minute? Check spam, or send the link again.</Trans>{' '}
          <button
            type="button"
            disabled={state.isLoading || !state.turnstileReady}
            onClick={actions.submitMagicLink}
            {...stylex.props(hosted.textLink)}
          >
            <Trans>Send again</Trans>
          </button>
        </p>
      </div>
    )
  }

  return (
    <div {...stylex.props(hosted.screen)}>
      <AuthHeading
        above={props.above}
        title={<Trans>Get a sign-in link</Trans>}
        lead={
          <Trans>We'll email a link to {target}. Open it to sign in, no password needed.</Trans>
        }
      />
      <form noValidate onSubmit={handleSubmit} {...stylex.props(hosted.form)}>
        {state.isSignUpFlow ? (
          <ProfileFields
            fields={props.profileFields}
            requiredFields={props.requiredFields}
            values={state.profileValues}
            disabled={state.isLoading}
            onChange={actions.setProfileValue}
          />
        ) : null}
        <SignInTurnstileSlot />
        <Button
          type="submit"
          variant="accent"
          size="lg"
          fullWidth
          isLoading={state.isLoading}
          disabled={!state.turnstileReady || !profileComplete(state, props.requiredFields)}
        >
          <Trans>Email me a link</Trans>
        </Button>
      </form>
    </div>
  )
}

export function CodeStartPanel(
  props: PanelProps & ProfileProps & { method: OtpSignInMethod; createTitle: ReactNode },
): ReactNode {
  const { state, actions } = props
  const target = useTargetLabel(state.identifier, props.method)

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    actions.requestOtp()
  }

  return (
    <div {...stylex.props(hosted.screen)}>
      <AuthHeading
        above={props.above}
        title={props.createTitle}
        lead={
          props.profileFields.length > 0 ? (
            <Trans>Add your details, and we'll send you a code to confirm it's you.</Trans>
          ) : (
            <Trans>We'll send a 6-digit code to {target} to confirm it's you.</Trans>
          )
        }
      />
      <form noValidate onSubmit={handleSubmit} {...stylex.props(hosted.form)}>
        <ProfileFields
          fields={props.profileFields}
          requiredFields={props.requiredFields}
          values={state.profileValues}
          disabled={state.isLoading}
          onChange={actions.setProfileValue}
        />
        <SignInTurnstileSlot />
        <Button
          type="submit"
          variant="accent"
          size="lg"
          fullWidth
          isLoading={state.isSendingOtp}
          disabled={!state.turnstileReady || !profileComplete(state, props.requiredFields)}
        >
          <Trans>Create account</Trans>
        </Button>
      </form>
    </div>
  )
}

export function PasskeyPanel(props: PanelProps): ReactNode {
  const { state, actions } = props
  return (
    <div {...stylex.props(hosted.screen)}>
      <AuthHeading
        above={props.above}
        title={<Trans>Sign in with your passkey</Trans>}
        lead={
          <Trans>
            Use your fingerprint, face or screen lock, the same way you unlock your device.
          </Trans>
        }
      />
      {state.authConfig.passkeyEntry.reregistrationRequired ? (
        <Notice tone="warning" title={<Trans>Your passkey may need to be created again</Trans>}>
          <Trans>
            This sign-in address changed. If your passkey isn't offered, sign in another way and
            create a new one.
          </Trans>
        </Notice>
      ) : null}
      <div {...stylex.props(hosted.group)}>
        <SignInTurnstileSlot />
        <Button
          variant="accent"
          size="lg"
          fullWidth
          isLoading={state.isLoading}
          disabled={!state.turnstileReady}
          onClick={actions.triggerPasskeyButton}
        >
          <Icon name="passkey" size={18} />
          <Trans>Use passkey</Trans>
        </Button>
        <p {...stylex.props(hosted.note)}>
          <Trans>
            On a different computer, your browser can show a QR code to scan with your phone.
          </Trans>
        </p>
      </div>
    </div>
  )
}
