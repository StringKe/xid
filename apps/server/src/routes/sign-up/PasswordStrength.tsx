// zxcvbn score 可视化;强度色用语义 token,不写裸色值。

import { useLingui } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Trans } from '@lingui/react/macro'
import { tokens } from '../../styles/tokens.stylex'

export type PasswordStrengthProps = {
  score: 0 | 1 | 2 | 3 | 4
}

const styles = stylex.create({
  wrapper: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.25rem',
  },
  track: {
    height: '4px',
    borderRadius: tokens['--xid-radius-sm'],
    backgroundColor: tokens['--xid-border'],
    overflow: 'hidden',
  },
  fill: {
    height: '100%',
    transitionProperty: {
      default: 'width, background-color',
      '@media (prefers-reduced-motion: reduce)': 'none',
    },
    transitionDuration: '0.2s',
    transitionTimingFunction: 'ease-out',
  },
  width0: { width: '20%' },
  width1: { width: '40%' },
  width2: { width: '60%' },
  width3: { width: '80%' },
  width4: { width: '100%' },
  fillDanger: { backgroundColor: tokens['--xid-danger'] },
  fillWarning: { backgroundColor: tokens['--xid-warning'] },
  fillSuccess: { backgroundColor: tokens['--xid-success'] },
  label: {
    fontSize: '0.75rem',
    fontFamily: tokens['--xid-font'],
  },
  labelDanger: { color: tokens['--xid-danger'] },
  labelWarning: { color: tokens['--xid-warning'] },
  labelSuccess: { color: tokens['--xid-success'] },
})

type ScoreTier = 'danger' | 'warning' | 'success'

function scoreTier(score: 0 | 1 | 2 | 3 | 4): ScoreTier {
  if (score <= 1) return 'danger'
  if (score === 2) return 'warning'
  return 'success'
}

const widthStyles = {
  0: styles.width0,
  1: styles.width1,
  2: styles.width2,
  3: styles.width3,
  4: styles.width4,
} as const satisfies Record<0 | 1 | 2 | 3 | 4, object>

const fillColorStyles = {
  danger: styles.fillDanger,
  warning: styles.fillWarning,
  success: styles.fillSuccess,
} as const satisfies Record<ScoreTier, object>

const labelColorStyles = {
  danger: styles.labelDanger,
  warning: styles.labelWarning,
  success: styles.labelSuccess,
} as const satisfies Record<ScoreTier, object>

export function PasswordStrength({ score }: PasswordStrengthProps): ReactNode {
  const { t } = useLingui()
  const tier = scoreTier(score)

  const labelMap: Record<0 | 1 | 2 | 3 | 4, ReactNode> = {
    0: <Trans>Very weak</Trans>,
    1: <Trans>Weak</Trans>,
    2: <Trans>Fair</Trans>,
    3: <Trans>Good</Trans>,
    4: <Trans>Strong</Trans>,
  }

  return (
    <div {...stylex.props(styles.wrapper)} aria-label={t`Password strength`}>
      <div
        role="meter"
        aria-valuenow={score}
        aria-valuemin={0}
        aria-valuemax={4}
        aria-label={t`Password strength meter`}
        {...stylex.props(styles.track)}
      >
        <div {...stylex.props(styles.fill, widthStyles[score], fillColorStyles[tier])} />
      </div>
      <span {...stylex.props(styles.label, labelColorStyles[tier])}>{labelMap[score]}</span>
    </div>
  )
}
