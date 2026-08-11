import { useEffect } from 'react'
import type { ReactNode } from 'react'

export type RedirectToUserProfileProps = {
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
