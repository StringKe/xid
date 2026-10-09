// 在组织地址用 passkey 完成身份确认后回到这里时(带 stepped_up=1),提示已验证、可以继续刚才的操作。
// 确认有效期由服务端 step-up cookie 决定,本提示只说明结果;关闭后从地址里去掉标记。

import { Trans } from '@lingui/react/macro'
import { useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Button, Notice } from '../../components/ui'
import { surface } from './account-surface'

const STEPPED_UP_PARAM = 'stepped_up'

function hasSteppedUpMarker(): boolean {
  if (typeof window === 'undefined') return false
  return new URLSearchParams(window.location.search).get(STEPPED_UP_PARAM) === '1'
}

function removeMarkerFromAddress(): void {
  const url = new URL(window.location.href)
  url.searchParams.delete(STEPPED_UP_PARAM)
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
}

export function SteppedUpNotice(): ReactNode {
  const [visible, setVisible] = useState(hasSteppedUpMarker)
  if (!visible) return null
  const dismiss = (): void => {
    removeMarkerFromAddress()
    setVisible(false)
  }
  return (
    <div {...stylex.props(surface.note)}>
      <Notice
        tone="success"
        action={
          <Button variant="ghost" onClick={dismiss}>
            <Trans>Dismiss</Trans>
          </Button>
        }
      >
        <Trans>You've confirmed it's you. Continue with your change.</Trans>
      </Notice>
    </div>
  )
}
