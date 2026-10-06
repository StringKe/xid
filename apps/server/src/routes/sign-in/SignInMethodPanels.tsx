// 登录页面板:企业 SSO、passkey、magic link 与多组织选择。

import { Trans, useLingui } from '@lingui/react/macro'
import type { FormEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Alert, Button, Field, Input } from '../../components/ui'
import { IdentifierLabel, ProfileFields } from './SignInFields'
import { styles } from './styles'
import type { IdentifierPrompt, ProfileFieldKey } from './shared'
import type { PublicInstanceLoginMatch } from './auth-config'
import type { SignInActions, SignInState } from './useSignIn'

type PanelProps = { state: SignInState; actions: SignInActions }

function submitWith(action: () => void): (event: FormEvent<HTMLFormElement>) => void {
  return (event) => {
    event.preventDefault()
    action()
  }
}

export function EnterpriseSsoPanel({ state, actions }: PanelProps): ReactNode {
  const { t } = useLingui()
  return (
    <form
      onSubmit={submitWith(actions.submitEnterpriseSso)}
      noValidate
      {...stylex.props(styles.panel)}
      aria-label={t`Continue with SSO`}
    >
      <Field label={<Trans>Work email</Trans>} required>
        <Input
          type="email"
          autoComplete="email"
          placeholder={t`you@example.com`}
          value={state.identifier}
          onChange={(e) => actions.setIdentifier(e.target.value)}
          disabled={state.isLoading}
        />
      </Field>
      <Button
        type="submit"
        variant="accent"
        fullWidth
        isLoading={state.isLoading}
        disabled={!state.identifier.trim() || !state.turnstileReady}
      >
        <Trans>Continue with SSO</Trans>
      </Button>
    </form>
  )
}

export function PasskeyPanel(
  props: PanelProps & {
    prompt: IdentifierPrompt
    identifierPlaceholder: string
    identifierAriaLabel: string
    identifierAutoComplete: string
    reregistrationRequired: boolean
  },
): ReactNode {
  const { state, actions, prompt } = props
  const { t } = useLingui()
  return (
    <>
      {props.reregistrationRequired ? (
        <Alert tone="info">
          <Trans>
            Passkeys created on a different address do not work here. Sign in another way, then add
            a passkey for this address from your account security page.
          </Trans>
        </Alert>
      ) : null}
      <Field label={<IdentifierLabel prompt={prompt} />}>
        <Input
          type={prompt.type}
          autoComplete={props.identifierAutoComplete}
          placeholder={props.identifierPlaceholder}
          value={state.identifier}
          onChange={(e) => actions.setIdentifier(e.target.value)}
          aria-label={props.identifierAriaLabel}
        />
      </Field>
      <p
        role="status"
        aria-live="polite"
        {...stylex.props(
          styles.conditionalHint,
          state.conditionalUiRunning ? styles.hintVisible : styles.hintHidden,
        )}
      >
        {state.conditionalUiRunning ? <Trans>Waiting for passkey selection...</Trans> : null}
      </p>
      <Button
        variant="accent"
        fullWidth
        isLoading={state.isLoading}
        disabled={!state.turnstileReady}
        onClick={actions.triggerPasskeyButton}
        aria-label={t`Sign in with passkey`}
      >
        <Trans>Sign in with passkey</Trans>
      </Button>
    </>
  )
}

export function MagicLinkPanel(
  props: PanelProps & {
    isSignUpFlow: boolean
    profileFields: readonly ProfileFieldKey[]
    requiredFields: readonly ProfileFieldKey[]
    requiredProfileComplete: boolean
  },
): ReactNode {
  const { state, actions } = props
  const { t } = useLingui()
  return (
    <form
      onSubmit={submitWith(actions.submitMagicLink)}
      noValidate
      {...stylex.props(styles.panel)}
      aria-label={props.isSignUpFlow ? t`Create your account` : t`Sign in with magic link`}
    >
      <Field label={<Trans>Email address</Trans>} required>
        <Input
          type="email"
          autoComplete="email"
          placeholder={t`you@example.com`}
          value={state.identifier}
          onChange={(e) => actions.setIdentifier(e.target.value)}
          disabled={state.isLoading}
        />
      </Field>
      <ProfileFields
        fields={props.profileFields}
        requiredFields={props.requiredFields}
        values={state.profileValues}
        disabled={state.isLoading}
        onChange={actions.setProfileValue}
      />
      <Button
        type="submit"
        variant="accent"
        fullWidth
        isLoading={state.isLoading}
        disabled={
          !state.identifier.trim() || !props.requiredProfileComplete || !state.turnstileReady
        }
      >
        <Trans>Send magic link</Trans>
      </Button>
    </form>
  )
}

export function OrganizationChooser({
  matches,
  onSelect,
}: {
  matches: readonly PublicInstanceLoginMatch[]
  onSelect: (organizationId: string) => void
}): ReactNode {
  return (
    <div {...stylex.props(styles.panel)}>
      <Alert tone="info">
        <Trans>Choose an organization to continue.</Trans>
      </Alert>
      {matches.map((match) => (
        <Button
          key={match.organizationId}
          type="button"
          variant="accent"
          fullWidth
          onClick={() => onSelect(match.organizationId)}
        >
          {match.name}
        </Button>
      ))}
    </div>
  )
}
