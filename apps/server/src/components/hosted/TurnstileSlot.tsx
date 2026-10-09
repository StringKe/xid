// Turnstile 挂载点,放在受保护的主操作正上方;需要人工点选时才显示说明。

import { Trans } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import type { TurnstileHandle } from '../../routes/sign-in/useTurnstile'
import { hosted } from './hosted-styles'

export function TurnstileSlot({ turnstile }: { turnstile: TurnstileHandle }): ReactNode {
  return (
    <>
      {turnstile.needsInteraction ? (
        <p role="status" {...stylex.props(hosted.note, hosted.noteStrong)}>
          <Trans>Complete the check below to continue.</Trans>
        </p>
      ) : null}
      <div ref={turnstile.containerRef} {...stylex.props(hosted.widgetSlot)} />
    </>
  )
}
