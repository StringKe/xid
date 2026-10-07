// 第二步:回显用户输入的标识符(可更换),展示一个默认方法,其余方法收在「Try another way」里。

import type { ReactNode } from 'react'
import { useMemo } from 'react'
import * as stylex from '@stylexjs/stylex'
import { IdentifierChip } from '../../components/hosted/IdentityChip'
import { hosted } from '../../components/hosted/hosted-styles'
import { CodeStartPanel, MagicLinkPanel, PasskeyPanel } from './DeliveryPanels'
import { browserStorage, readLastAuthMethod } from './method-order'
import { OtpPanel } from './OtpPanel'
import { PasswordPanel } from './PasswordPanel'
import { isOtpMethod, requiredProfileFields, visibleProfileFields } from './shared'
import type { SignInActions, SignInState } from './sign-in-types'
import { TryAnotherWay } from './TryAnotherWay'

export type MethodStepProps = {
  state: SignInState
  actions: SignInActions
  createTitle: ReactNode
  forgotPasswordHref: string
  inlineError: string | null
}

function MethodPanel(props: MethodStepProps & { above: ReactNode }): ReactNode {
  const { state, actions, above } = props
  const method = state.method
  const profileFields = state.isSignUpFlow ? visibleProfileFields(state.authConfig, method) : []
  const requiredFields = state.isSignUpFlow ? requiredProfileFields(state.authConfig, method) : []
  if (isOtpMethod(method)) {
    if (state.isSignUpFlow && state.otpSentAt === null && !state.isSendingOtp) {
      return (
        <CodeStartPanel
          state={state}
          actions={actions}
          above={above}
          createTitle={props.createTitle}
          profileFields={profileFields}
          requiredFields={requiredFields}
        />
      )
    }
    return <OtpPanel method={method} state={state} actions={actions} above={above} />
  }
  if (method === 'magic-link') {
    return (
      <MagicLinkPanel
        state={state}
        actions={actions}
        above={above}
        profileFields={profileFields}
        requiredFields={requiredFields}
      />
    )
  }
  if (method === 'passkey') return <PasskeyPanel state={state} actions={actions} above={above} />
  return (
    <PasswordPanel
      state={state}
      actions={actions}
      above={above}
      createTitle={props.createTitle}
      forgotPasswordHref={props.forgotPasswordHref}
      profileFields={profileFields}
      requiredFields={requiredFields}
      inlineError={props.inlineError}
    />
  )
}

export function MethodStep(props: MethodStepProps): ReactNode {
  const { state, actions } = props
  const lastUsed = useMemo(() => readLastAuthMethod(browserStorage()), [])
  const above = <IdentifierChip value={state.identifier} onChange={actions.changeIdentifier} />
  return (
    <div {...stylex.props(hosted.screen)}>
      <MethodPanel {...props} above={above} />
      <TryAnotherWay
        methods={state.methods}
        current={state.method}
        lastUsed={lastUsed}
        identifier={state.identifier}
        kind={state.identifierKind}
        defaultOpen={state.error === 'rate_limited'}
        disabled={state.isLoading}
        onChoose={actions.chooseMethod}
      />
    </div>
  )
}
