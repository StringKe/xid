// 新组织引导:验证域名、决定登录方式、邀请成员。第一个未完成的步骤是当前步骤,动作放在说明下方;
// 其余未完成步骤的动作在桌面靠右,手机上隐藏,避免一屏出现多个主次难分的按钮。

import { Trans } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Icon } from '@xid-kit/web-ui/ui'
import { Link } from '@xid-kit/web-ui/tanstack-router'
import { leading, text, weight } from '@xid-kit/web-ui/styles/scale.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { actionLink, orgPath, section } from './AttentionList'
import type { SetupProgress } from './overview-queries'

type StepAction = { label: ReactNode; to: string }

type Step = {
  key: string
  done: boolean
  title: ReactNode
  detail: ReactNode
  detailNarrow: ReactNode
  actions: StepAction[]
  secondary?: StepAction
}

const styles = stylex.create({
  step: {
    display: 'flex',
    gap: { default: '0.75rem', '@media (min-width: 48rem)': '1.25rem' },
    paddingBlock: { default: '1rem', '@media (min-width: 48rem)': '1.25rem' },
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  marker: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    width: '1.75rem',
    height: '1.75rem',
    borderRadius: tokens['--xid-radius-full'],
    boxShadow: `inset 0 0 0 1px ${tokens['--xid-border-strong']}`,
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
    fontWeight: weight.medium,
    fontVariantNumeric: 'tabular-nums',
  },
  markerCurrent: {
    boxShadow: 'none',
    backgroundColor: tokens['--xid-primary'],
    color: tokens['--xid-primary-foreground'],
  },
  markerDone: {
    boxShadow: 'none',
    backgroundColor: tokens['--xid-success-bg'],
    color: tokens['--xid-success'],
  },
  main: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.625rem',
    flex: '1 1 auto',
    minWidth: 0,
  },
  copy: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.25rem',
  },
  title: {
    margin: 0,
    color: tokens['--xid-fg'],
    fontSize: text.md,
    fontWeight: weight.medium,
    lineHeight: '1.375rem',
  },
  titleDone: {
    color: tokens['--xid-muted-foreground'],
  },
  detail: {
    margin: 0,
    maxWidth: '38.75rem',
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
    lineHeight: leading.base,
  },
  wideOnly: {
    display: { default: 'none', '@media (min-width: 48rem)': 'inline' },
  },
  narrowOnly: {
    display: { default: 'inline', '@media (min-width: 48rem)': 'none' },
  },
  currentActions: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '0.75rem',
  },
  sideActions: {
    display: { default: 'none', '@media (min-width: 48rem)': 'flex' },
    alignItems: 'flex-start',
    gap: '0.5rem',
    flexShrink: 0,
  },
})

function buildSteps(progress: SetupProgress, orgId: string): Step[] {
  const domain = progress.pendingDomain
  return [
    {
      key: 'domain',
      done: progress.domainVerified,
      title: domain ? <Trans>Verify {domain}</Trans> : <Trans>Verify your domain</Trans>,
      detail: domain ? (
        <Trans>
          Proves you own the domain. After that, people who sign in with an @{domain} address are
          sent to the right organization, and SSO can route them to your IdP. You add one DNS TXT
          record.
        </Trans>
      ) : (
        <Trans>
          Proves you own the domain. After that, people who sign in with an address at that domain
          are sent to the right organization, and SSO can route them to your IdP. You add one DNS
          TXT record.
        </Trans>
      ),
      detailNarrow: domain ? (
        <Trans>
          Add one DNS TXT record. Then people with @{domain} addresses land in this organization and
          SSO can route them.
        </Trans>
      ) : (
        <Trans>
          Add one DNS TXT record. Then people with addresses at that domain land in this
          organization and SSO can route them.
        </Trans>
      ),
      actions: [
        { label: <Trans>Verify domain…</Trans>, to: orgPath('/console/org/domains', orgId) },
      ],
      secondary: domain
        ? {
            label: <Trans>Use a different domain</Trans>,
            to: orgPath('/console/org/domains', orgId),
          }
        : undefined,
    },
    {
      key: 'sign-in',
      done: progress.signInDecided,
      title: <Trans>Decide how people sign in</Trans>,
      detail: (
        <Trans>
          Either connect Okta or Microsoft Entra ID for single sign-on, or require two-step
          verification for everyone who uses a password.
        </Trans>
      ),
      detailNarrow: (
        <Trans>
          Connect Okta or Microsoft Entra ID, or require two-step verification for passwords.
        </Trans>
      ),
      actions: [
        { label: <Trans>Connect SSO</Trans>, to: orgPath('/console/org/sso?step=new', orgId) },
        { label: <Trans>Require two-step</Trans>, to: orgPath('/console/org/auth-policy', orgId) },
      ],
    },
    {
      key: 'members',
      done: progress.membersInvited,
      title: <Trans>Invite members</Trans>,
      detail: (
        <Trans>
          Paste up to 50 email addresses at once. Doing the first two steps before this means nobody
          has to set up their sign-in twice.
        </Trans>
      ),
      detailNarrow: (
        <Trans>
          Up to 50 addresses at once. Doing steps 1 and 2 first means nobody sets up their sign-in
          twice.
        </Trans>
      ),
      actions: [
        {
          label: <Trans>Invite members…</Trans>,
          to: orgPath('/console/org/members?tab=invitations', orgId),
        },
      ],
    },
  ]
}

function StepRow({
  step,
  index,
  current,
}: {
  step: Step
  index: number
  current: boolean
}): ReactNode {
  return (
    <li {...stylex.props(styles.step)}>
      <span
        {...stylex.props(
          styles.marker,
          current && styles.markerCurrent,
          step.done && styles.markerDone,
        )}
      >
        {step.done ? <Icon name="check" size={14} /> : index + 1}
      </span>
      <div {...stylex.props(styles.main)}>
        <div {...stylex.props(styles.copy)}>
          <p {...stylex.props(styles.title, step.done && styles.titleDone)}>
            {step.title}
            {step.done ? (
              <span {...stylex.props(visuallyHidden.text)}>
                {' '}
                <Trans>(done)</Trans>
              </span>
            ) : null}
          </p>
          <p {...stylex.props(styles.detail)}>
            <span {...stylex.props(styles.wideOnly)}>{step.detail}</span>
            <span {...stylex.props(styles.narrowOnly)}>{step.detailNarrow}</span>
          </p>
        </div>
        {current ? (
          <div {...stylex.props(styles.currentActions)}>
            {step.actions.map((action, actionIndex) => (
              <Link
                key={actionIndex}
                to={action.to}
                {...stylex.props(
                  actionLink.base,
                  actionIndex === 0 && actionLink.primary,
                  actionIndex === 0 && actionLink.fullNarrow,
                )}
              >
                {action.label}
              </Link>
            ))}
            {step.secondary ? (
              <Link to={step.secondary.to} {...stylex.props(actionLink.text)}>
                {step.secondary.label}
              </Link>
            ) : null}
          </div>
        ) : null}
      </div>
      {!current && !step.done ? (
        <div {...stylex.props(styles.sideActions)}>
          {step.actions.map((action, actionIndex) => (
            <Link key={actionIndex} to={action.to} {...stylex.props(actionLink.base)}>
              {action.label}
            </Link>
          ))}
        </div>
      ) : null}
    </li>
  )
}

export function isSetupComplete(progress: SetupProgress): boolean {
  return progress.domainVerified && progress.signInDecided && progress.membersInvited
}

export function SetupChecklist({
  progress,
  orgId,
}: {
  progress: SetupProgress
  orgId: string
}): ReactNode {
  const steps = buildSteps(progress, orgId)
  const done = steps.filter((step) => step.done).length
  const total = steps.length
  const currentIndex = steps.findIndex((step) => !step.done)
  return (
    <section aria-labelledby="setup-heading" {...stylex.props(section.root)}>
      <header {...stylex.props(section.head)}>
        <h2 id="setup-heading" {...stylex.props(section.title)}>
          <Trans>Get ready to invite your team</Trans>
        </h2>
        <p {...stylex.props(section.meta)}>
          <Trans>
            {done} of {total} done
          </Trans>
        </p>
      </header>
      <ol {...stylex.props(listReset.ol)}>
        {steps.map((step, index) => (
          <StepRow key={step.key} step={step} index={index} current={index === currentIndex} />
        ))}
      </ol>
    </section>
  )
}

const listReset = stylex.create({
  ol: { margin: 0, padding: 0, listStyle: 'none' },
})

const visuallyHidden = stylex.create({
  text: {
    position: 'absolute',
    width: '1px',
    height: '1px',
    overflow: 'hidden',
    clipPath: 'inset(50%)',
    whiteSpace: 'nowrap',
  },
})
