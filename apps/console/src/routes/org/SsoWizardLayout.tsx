// 新建企业连接向导各步骤共用的版式:步骤标题、表单区与底部按钮栏。

import { Trans } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Breadcrumb } from '@xid-kit/web-ui/ui'
import { consoleShell } from '@xid-kit/web-ui/styles/product-surface.stylex'
import { leading, text, weight } from '@xid-kit/web-ui/styles/scale.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'

const WIDE = '@media (min-width: 48rem)'

export const wizardStyles = stylex.create({
  frame: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1.5rem',
    maxWidth: '45rem',
    fontFamily: tokens['--xid-font'],
  },
  heading: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.375rem',
  },
  step: {
    margin: 0,
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
  },
  title: {
    margin: 0,
    color: tokens['--xid-fg'],
    fontSize: { default: text.lg, [WIDE]: text.xl },
    lineHeight: { default: leading.lg, [WIDE]: leading.xl },
    fontWeight: weight.display,
    letterSpacing: tokens['--xid-tracking-heading'],
  },
  lead: {
    margin: 0,
    color: tokens['--xid-muted-foreground'],
    fontSize: text.base,
    lineHeight: leading.base,
  },
  fields: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
    minWidth: 0,
    margin: 0,
    padding: 0,
    borderWidth: 0,
  },
  footer: {
    display: 'flex',
    flexDirection: { default: 'column-reverse', [WIDE]: 'row' },
    justifyContent: 'space-between',
    gap: '0.5rem',
    paddingTop: '1.25rem',
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
  },
})

export function StepHeading({
  step,
  title,
  lead,
}: {
  step: number
  title: ReactNode
  lead: ReactNode
}): ReactNode {
  return (
    <div {...stylex.props(wizardStyles.heading)}>
      <p {...stylex.props(wizardStyles.step)}>
        <Trans>Step {step} of 3</Trans>
      </p>
      <h1 {...stylex.props(wizardStyles.title)}>{title}</h1>
      <p {...stylex.props(wizardStyles.lead)}>{lead}</p>
    </div>
  )
}

export function WizardBreadcrumb({ current }: { current: ReactNode }): ReactNode {
  return (
    <div {...stylex.props(consoleShell.headerZone)}>
      <Breadcrumb
        items={[
          { key: 'sso', label: <Trans>Enterprise SSO</Trans>, href: '/console/org/sso' },
          { key: 'current', label: current },
        ]}
      />
    </div>
  )
}
