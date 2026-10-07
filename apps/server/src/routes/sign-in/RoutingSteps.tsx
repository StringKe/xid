// 标识符提交后的分流屏:企业 SSO 跳转过渡、根入口多组织选择、账户无法登录。

import { Trans, useLingui } from '@lingui/react/macro'
import { useEffect } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Button, Notice } from '../../components/ui'
import { AuthHeading } from '../../components/hosted/AuthHeading'
import { hosted } from '../../components/hosted/hosted-styles'
import { initialsOf } from '../../components/hosted/IdentityChip'
import { OptionList } from '../../components/hosted/OptionList'
import { tokens } from '../../styles/tokens.stylex'
import type { PublicInstanceLoginMatch } from './auth-config'
import type { SsoTarget } from './useSsoDiscovery'

// 自动跳转前留一小段时间让人读到去向;跳不过去时手动链接兜底。
const SSO_REDIRECT_DELAY_MS = 1200

const slide = stylex.keyframes({
  from: { transform: 'translateX(-100%)' },
  to: { transform: 'translateX(250%)' },
})

const styles = stylex.create({
  progress: {
    position: 'relative',
    height: '3px',
    borderRadius: tokens['--xid-radius-full'],
    backgroundColor: tokens['--xid-muted'],
    overflow: 'hidden',
  },
  bar: {
    position: 'absolute',
    insetBlock: 0,
    insetInlineStart: 0,
    width: '40%',
    borderRadius: tokens['--xid-radius-full'],
    backgroundColor: tokens['--xid-muted-foreground'],
    animationName: slide,
    animationDuration: { default: '1.4s', '@media (prefers-reduced-motion: reduce)': '0s' },
    animationIterationCount: 'infinite',
    animationTimingFunction: 'ease-in-out',
  },
})

export function SsoRedirectStep(props: {
  target: SsoTarget
  above: ReactNode
  applicationName: string | null
  onUseDifferentEmail: () => void
}): ReactNode {
  const { t } = useLingui()
  const { target } = props
  const idp = target.connectionName ?? t`your identity provider`
  const org = target.organizationName
  const app = props.applicationName

  useEffect(() => {
    const timer = setTimeout(() => {
      globalThis.location.href = target.url
    }, SSO_REDIRECT_DELAY_MS)
    return () => clearTimeout(timer)
  }, [target.url])

  return (
    <div {...stylex.props(hosted.screen)} aria-live="polite">
      <AuthHeading
        above={props.above}
        title={
          <Trans>
            Redirecting to {idp} for {target.domain}
          </Trans>
        }
        lead={
          org && app ? (
            <Trans>
              {org} signs in people with {target.domain} addresses through {idp}. After {idp}, you
              come straight back to {app}.
            </Trans>
          ) : org ? (
            <Trans>
              {org} signs in people with {target.domain} addresses through {idp}.
            </Trans>
          ) : (
            <Trans>
              People with {target.domain} addresses sign in through {idp}.
            </Trans>
          )
        }
      />
      <div role="progressbar" aria-label={t`Redirecting`} {...stylex.props(styles.progress)}>
        <span {...stylex.props(styles.bar)} />
      </div>
      <div {...stylex.props(hosted.group)}>
        <p {...stylex.props(hosted.note)}>
          <Trans>Nothing happening?</Trans>{' '}
          <a href={target.url} {...stylex.props(hosted.textLink)}>
            <Trans>Continue to {idp}</Trans>
          </a>
        </p>
        <p {...stylex.props(hosted.note)}>
          <Trans>Not your work account?</Trans>{' '}
          <button
            type="button"
            onClick={props.onUseDifferentEmail}
            {...stylex.props(hosted.textLink)}
          >
            <Trans>Use a different email</Trans>
          </button>
        </p>
      </div>
    </div>
  )
}

export function OrganizationStep(props: {
  matches: readonly PublicInstanceLoginMatch[]
  above: ReactNode
  applicationName: string | null
  onSelect: (organizationId: string) => void
}): ReactNode {
  const { t } = useLingui()
  const count = props.matches.length
  const app = props.applicationName
  return (
    <div {...stylex.props(hosted.screen)}>
      <AuthHeading
        above={props.above}
        title={<Trans>Choose an organization</Trans>}
        lead={
          app ? (
            <Trans>
              This address is used in {count} organizations. {app} opens in the one you choose.
            </Trans>
          ) : (
            <Trans>This address is used in {count} organizations. Choose where to sign in.</Trans>
          )
        }
      />
      <OptionList
        label={t`Organizations`}
        items={props.matches.map((match) => ({
          key: match.organizationId,
          title: match.name,
          description: match.slug,
          monogram: initialsOf(match.name),
          onSelect: () => props.onSelect(match.organizationId),
        }))}
      />
    </div>
  )
}

export function AccountLockedStep(props: {
  identifier: string
  organizationName: string | null
  applicationName: string | null
  onUseDifferentAccount: () => void
}): ReactNode {
  const org = props.organizationName
  const app = props.applicationName
  return (
    <div {...stylex.props(hosted.screen)}>
      <AuthHeading title={<Trans>You can't sign in right now</Trans>} lead={props.identifier} />
      <Notice tone="danger" title={<Trans>This account is locked</Trans>}>
        {org ? (
          <Trans>
            Try again later. If you need access sooner, ask your {org} administrator to unlock it.
          </Trans>
        ) : (
          <Trans>
            Try again later. If you need access sooner, ask your administrator to unlock it.
          </Trans>
        )}
      </Notice>
      <Button variant="secondary" size="lg" fullWidth onClick={props.onUseDifferentAccount}>
        <Trans>Use a different account</Trans>
      </Button>
      {app ? (
        <p {...stylex.props(hosted.note)}>
          <Trans>{app} did not receive any of your details.</Trans>
        </p>
      ) : null}
    </div>
  )
}
