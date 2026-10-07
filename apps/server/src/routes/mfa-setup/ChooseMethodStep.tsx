// 强制绑定第一步:平台固定只提供验证器与 passkey,短信不能成为唯一因子,不在这里出现。

import { Trans, useLingui } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Button } from '@xid-kit/web-ui/ui/Button'
import { text, weight } from '@xid-kit/web-ui/styles/scale.stylex'
import { AuthHeading } from '../../components/hosted/AuthHeading'
import { hosted } from '../../components/hosted/hosted-styles'
import { page } from '../../styles/product-surface.stylex'
import { tokens } from '../../styles/tokens.stylex'
import type { SetupMethod } from './setup-steps'

const styles = stylex.create({
  group: {
    display: 'flex',
    flexDirection: 'column',
    margin: 0,
    padding: 0,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: tokens['--xid-border'],
    borderRadius: tokens['--xid-radius-lg'],
    overflow: 'hidden',
  },
  option: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '0.75rem',
    paddingBlock: '1rem',
    paddingInline: '1rem',
    borderTopWidth: { default: '1px', ':first-of-type': 0 },
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
    cursor: 'pointer',
    backgroundColor: { default: 'transparent', ':hover': tokens['--xid-muted'] },
  },
  optionSelected: {
    backgroundColor: tokens['--xid-accent-wash'],
  },
  radio: {
    flexShrink: 0,
    width: '1.125rem',
    height: '1.125rem',
    margin: 0,
    marginTop: '0.0625rem',
    accentColor: tokens['--xid-accent'],
  },
  body: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.25rem',
    minWidth: 0,
  },
  title: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '0.5rem',
    color: tokens['--xid-fg'],
    fontSize: text.base,
    fontWeight: weight.medium,
    lineHeight: '1.125rem',
  },
  tag: {
    paddingInline: '0.375rem',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: tokens['--xid-accent'],
    borderRadius: tokens['--xid-radius-sm'],
    color: tokens['--xid-accent'],
    fontSize: text.xs,
    lineHeight: '1.125rem',
  },
  description: {
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
    lineHeight: 1.45,
  },
})

export type ChooseMethodStepProps = {
  organizationName: string | null
  passkeyAvailable: boolean
  selected: SetupMethod
  onSelect: (method: SetupMethod) => void
  onContinue: () => void
}

export function ChooseMethodStep(props: ChooseMethodStepProps): ReactNode {
  const { t } = useLingui()
  const { organizationName, passkeyAvailable, selected, onSelect, onContinue } = props
  const options: {
    value: SetupMethod
    title: ReactNode
    tag?: ReactNode
    description: ReactNode
  }[] = [
    ...(passkeyAvailable
      ? [
          {
            value: 'passkey' as const,
            title: <Trans>Passkey</Trans>,
            tag: <Trans>Fastest</Trans>,
            description: (
              <Trans>
                Confirm with Face ID, your fingerprint or a security key. Nothing to type.
              </Trans>
            ),
          },
        ]
      : []),
    {
      value: 'totp',
      title: <Trans>Authenticator app</Trans>,
      description: (
        <Trans>Enter a 6-digit code from an app like 1Password or Google Authenticator.</Trans>
      ),
    },
  ]

  return (
    <div {...stylex.props(hosted.screen)}>
      <AuthHeading
        eyebrow={<Trans>Step 1 of 3</Trans>}
        title={<Trans>Choose your second step</Trans>}
        lead={
          organizationName ? (
            <Trans>
              You'll use it each time you sign in to {organizationName}. You can add more methods
              later in your account.
            </Trans>
          ) : (
            <Trans>
              You'll use it each time you sign in. You can add more methods later in your account.
            </Trans>
          )
        }
      />
      <fieldset {...stylex.props(styles.group)}>
        <legend {...stylex.props(page.visuallyHidden)}>{t`Second step`}</legend>
        {options.map((option) => (
          <label
            key={option.value}
            {...stylex.props(styles.option, selected === option.value && styles.optionSelected)}
          >
            <input
              type="radio"
              name="mfa-method"
              value={option.value}
              checked={selected === option.value}
              onChange={() => onSelect(option.value)}
              {...stylex.props(styles.radio)}
            />
            <span {...stylex.props(styles.body)}>
              <span {...stylex.props(styles.title)}>
                {option.title}
                {option.tag ? <span {...stylex.props(styles.tag)}>{option.tag}</span> : null}
              </span>
              <span {...stylex.props(styles.description)}>{option.description}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <div {...stylex.props(hosted.group)}>
        <Button variant="accent" size="lg" fullWidth onClick={onContinue}>
          {selected === 'passkey' ? (
            <Trans>Set up passkey</Trans>
          ) : (
            <Trans>Set up authenticator app</Trans>
          )}
        </Button>
        <p {...stylex.props(hosted.note)}>
          <Trans>After this you'll save 10 backup codes, in case you lose your device.</Trans>
        </p>
      </div>
    </div>
  )
}
