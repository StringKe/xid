// 没有 passkey 时的引导卡片,以及常驻的 FIDO 三段说明。

import { Trans } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Button } from '../../components/ui'
import { passkeyStyles as styles } from './passkey-section-styles'

export function PasskeyHero({
  pendingSecurityKey,
  onCreate,
}: {
  pendingSecurityKey: boolean | undefined
  onCreate: (options: { securityKey: boolean }) => void
}): ReactNode {
  return (
    <div {...stylex.props(styles.hero)}>
      <h3 {...stylex.props(styles.heroTitle)}>
        <Trans>Use your face or fingerprint to sign in</Trans>
      </h3>
      <p {...stylex.props(styles.heroBody)}>
        <Trans>
          A passkey replaces your password and counts as two-step verification. It takes a few
          seconds on this device.
        </Trans>
      </p>
      <div {...stylex.props(styles.heroActions)}>
        <Button
          variant="accent"
          isLoading={pendingSecurityKey === false}
          onClick={() => onCreate({ securityKey: false })}
        >
          <Trans>Create a passkey</Trans>
        </Button>
        <Button
          variant="secondary"
          isLoading={pendingSecurityKey === true}
          onClick={() => onCreate({ securityKey: true })}
        >
          <Trans>Use a security key</Trans>
        </Button>
      </div>
    </div>
  )
}

export function PasskeyExplainer({ host }: { host: string }): ReactNode {
  return (
    <div {...stylex.props(styles.explainer)}>
      <div>
        <p {...stylex.props(styles.explainerTitle)}>
          <Trans>What they are</Trans>
        </p>
        <p {...stylex.props(styles.explainerBody)}>
          <Trans>
            You sign in with your fingerprint, face or screen lock instead of a password.
          </Trans>
        </p>
      </div>
      <div>
        <p {...stylex.props(styles.explainerTitle)}>
          <Trans>Why use them</Trans>
        </p>
        <p {...stylex.props(styles.explainerBody)}>
          <Trans>A passkey only works on {host}, so a look-alike sign-in page can't use it.</Trans>
        </p>
      </div>
      <div>
        <p {...stylex.props(styles.explainerTitle)}>
          <Trans>Where they're saved</Trans>
        </p>
        <p {...stylex.props(styles.explainerBody)}>
          <Trans>
            In your password manager or on a security key. Anyone who can unlock that device can
            sign in.
          </Trans>
        </p>
      </div>
    </div>
  )
}
