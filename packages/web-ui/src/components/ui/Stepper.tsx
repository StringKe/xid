// 纯展示不导航;步骤切换由页面状态机驱动。

import { Trans } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { page } from '../../styles/product-surface.stylex'

export type StepperProps = {
  current: number
  total: number
  label?: ReactNode
}

export function Stepper({ current, total, label }: StepperProps): ReactNode {
  return (
    <p {...stylex.props(page.sectionLabel)}>
      {label != null ? (
        <Trans>
          Step {current} of {total} · {label}
        </Trans>
      ) : (
        <Trans>
          Step {current} of {total}
        </Trans>
      )}
    </p>
  )
}
