// SignOutButton:无样式登出触发按钮(对标 Clerk <SignOutButton>)。

import { type ReactNode, useCallback, useState } from 'react'

import { useLingui } from '@lingui/react'

import { useXidContext } from '../../context/xid-context'
import { rt, sdkMessages } from '../../i18n-runtime'

export type SignOutButtonProps = {
  children?: ReactNode
  // 指定浏览器持有的 sessionId;省略则登出当前 active session。
  sessionId?: string
  // 登出后跳转 URL;默认不跳转(由调用者处理状态变化)。
  redirectUrl?: string
  'aria-label'?: string
}

export function SignOutButton({
  children,
  sessionId,
  redirectUrl,
  'aria-label': ariaLabel,
}: SignOutButtonProps): ReactNode {
  const { client } = useXidContext()
  const { _ } = useLingui()
  const [pending, setPending] = useState(false)

  const handleClick = useCallback(async () => {
    if (pending) return
    setPending(true)
    try {
      const result = await client.signOut({ ...(sessionId ? { sessionId } : {}) })
      if (result.ok && redirectUrl) {
        window.location.assign(redirectUrl)
      }
    } finally {
      setPending(false)
    }
  }, [client, sessionId, redirectUrl, pending])

  return (
    <button
      type="button"
      onClick={() => void handleClick()}
      aria-label={ariaLabel}
      aria-busy={pending}
      disabled={pending}
    >
      {children ?? rt(_, sdkMessages.signOut)}
    </button>
  )
}
