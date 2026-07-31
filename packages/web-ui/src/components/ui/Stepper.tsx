// Stepper:线性流程的步骤指示(mono microlabel),供 AuthLayout steps 与向导页使用。
// 纯展示,不承担导航;步骤切换由页面状态机驱动。

import { Trans } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { page } from '../../styles/product-surface.stylex'

export type StepperProps = {
  // 当前步骤(1 起)。
  current: number
  total: number
  // 当前步骤名(已本地化)。
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
