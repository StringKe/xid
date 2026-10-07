// passkey 插页的各屏:邀请创建、系统窗口被取消、需要先重新验证、创建成功。

import { Trans } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Button, Icon, type IconName } from '../../components/ui'
import { AuthHeading } from '../../components/hosted/AuthHeading'
import { hosted } from '../../components/hosted/hosted-styles'
import { text, weight } from '@xid-kit/web-ui/styles/scale.stylex'
import { tokens } from '../../styles/tokens.stylex'

const styles = stylex.create({
  benefits: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
    margin: 0,
    paddingBlock: '1.25rem',
    paddingInline: 0,
    listStyle: 'none',
    borderBlockWidth: '1px',
    borderBlockStyle: 'solid',
    borderBlockColor: tokens['--xid-border'],
  },
  benefit: {
    display: 'flex',
    gap: '0.75rem',
  },
  benefitIcon: {
    flexShrink: 0,
    marginTop: '0.0625rem',
    color: tokens['--xid-fg'],
  },
  benefitBody: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.125rem',
  },
  benefitTitle: {
    fontSize: text.base,
    fontWeight: weight.medium,
    color: tokens['--xid-fg'],
  },
  tips: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
    padding: '1rem',
    borderRadius: tokens['--xid-radius'],
    backgroundColor: tokens['--xid-sidebar'],
  },
})

function Benefit(props: { icon: IconName; title: ReactNode; detail: ReactNode }): ReactNode {
  return (
    <li {...stylex.props(styles.benefit)}>
      <span aria-hidden="true" {...stylex.props(styles.benefitIcon)}>
        <Icon name={props.icon} size={16} />
      </span>
      <span {...stylex.props(styles.benefitBody)}>
        <span {...stylex.props(styles.benefitTitle)}>{props.title}</span>
        <span {...stylex.props(hosted.note)}>{props.detail}</span>
      </span>
    </li>
  )
}

type Actions = {
  isCreating: boolean
  onCreate: () => void
  onNotNow: () => void
}

export function OfferView(props: Actions & { account: string | null; host: string }): ReactNode {
  return (
    <div {...stylex.props(hosted.screen)}>
      <AuthHeading
        title={<Trans>Sign in faster next time with a passkey</Trans>}
        lead={props.account ? <Trans>For {props.account} on this device.</Trans> : undefined}
      />
      <ul {...stylex.props(styles.benefits)}>
        <Benefit
          icon="scan-face"
          title={<Trans>Use your face, fingerprint or screen lock</Trans>}
          detail={<Trans>The same way you unlock this device. No code to type.</Trans>}
        />
        <Benefit
          icon="globe"
          title={<Trans>Works only on {props.host}</Trans>}
          detail={<Trans>It can't be guessed, and look-alike sites can't use it.</Trans>}
        />
        <Benefit
          icon="cloud"
          title={<Trans>Saved in your password manager</Trans>}
          detail={<Trans>It can sync to your other devices through your password manager.</Trans>}
        />
      </ul>
      <div {...stylex.props(hosted.actions)}>
        <Button
          variant="accent"
          size="lg"
          fullWidth
          isLoading={props.isCreating}
          onClick={props.onCreate}
        >
          <Trans>Create a passkey</Trans>
        </Button>
        <Button
          variant="secondary"
          size="lg"
          fullWidth
          disabled={props.isCreating}
          onClick={props.onNotNow}
        >
          <Trans>Not now</Trans>
        </Button>
      </div>
      <p {...stylex.props(hosted.note)}>
        <Trans>
          Your current sign-in method keeps working. You can remove the passkey any time in your
          account.
        </Trans>
      </p>
    </div>
  )
}

export function CancelledView(props: Actions & { appName: string | null }): ReactNode {
  return (
    <div {...stylex.props(hosted.screen)}>
      <AuthHeading
        title={<Trans>Passkey not created</Trans>}
        lead={
          <Trans>The prompt closed before it finished, so nothing was saved on this device.</Trans>
        }
      />
      <div {...stylex.props(styles.tips)}>
        <span {...stylex.props(styles.benefitTitle)}>
          <Trans>If no prompt appeared</Trans>
        </span>
        <p {...stylex.props(hosted.note)}>
          <Trans>
            Turn on a screen lock or fingerprint in your device settings, then try again.
          </Trans>
        </p>
        <p {...stylex.props(hosted.note)}>
          <Trans>Private windows in some browsers can't save passkeys. Use a regular window.</Trans>
        </p>
      </div>
      <div {...stylex.props(hosted.actions)}>
        <Button
          variant="accent"
          size="lg"
          fullWidth
          isLoading={props.isCreating}
          onClick={props.onCreate}
        >
          <Trans>Try again</Trans>
        </Button>
        <Button
          variant="secondary"
          size="lg"
          fullWidth
          disabled={props.isCreating}
          onClick={props.onNotNow}
        >
          <Trans>Not now</Trans>
        </Button>
      </div>
      <p {...stylex.props(hosted.note)}>
        {props.appName ? (
          <Trans>
            You'll continue to {props.appName} either way. You can create a passkey later in your
            account.
          </Trans>
        ) : (
          <Trans>You'll continue either way. You can create a passkey later in your account.</Trans>
        )}
      </p>
    </div>
  )
}

export function StepUpView(props: { onVerify: () => void; onNotNow: () => void }): ReactNode {
  return (
    <div {...stylex.props(hosted.screen)}>
      <AuthHeading
        title={<Trans>Confirm it's you first</Trans>}
        lead={
          <Trans>
            Adding a passkey changes how you sign in, so we need a fresh check before saving it.
          </Trans>
        }
      />
      <div {...stylex.props(hosted.actions)}>
        <Button variant="accent" size="lg" fullWidth onClick={props.onVerify}>
          <Trans>Verify and continue</Trans>
        </Button>
        <Button variant="secondary" size="lg" fullWidth onClick={props.onNotNow}>
          <Trans>Not now</Trans>
        </Button>
      </div>
    </div>
  )
}

export function CreatedView(props: { appName: string | null; onContinue: () => void }): ReactNode {
  return (
    <div {...stylex.props(hosted.screen)}>
      <AuthHeading
        title={<Trans>Your passkey is ready</Trans>}
        lead={
          <Trans>
            Next time, pick your passkey when you sign in. You won't need to type anything.
          </Trans>
        }
      />
      <Button variant="accent" size="lg" fullWidth onClick={props.onContinue}>
        {props.appName ? <Trans>Continue to {props.appName}</Trans> : <Trans>Continue</Trans>}
      </Button>
      <p {...stylex.props(hosted.note)}>
        <Trans>Manage your passkeys any time in your account under Security.</Trans>
      </p>
    </div>
  )
}
