// RedirectToUserProfile:挂载即跳转到用户账户管理页(对标 Clerk <RedirectToUserProfile>)。

import { useEffect } from 'react'
import type { ReactNode } from 'react'

export type RedirectToUserProfileProps = {
  // 用户资料页路径,默认 /account
  userProfileUrl?: string
}

export function RedirectToUserProfile({
  userProfileUrl = '/account',
}: RedirectToUserProfileProps): ReactNode {
  useEffect(() => {
    window.location.replace(userProfileUrl)
  }, [userProfileUrl])

  return null
}
