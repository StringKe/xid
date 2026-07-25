// RedirectToOrganizationProfile:挂载即跳转到组织管理页(对标 Clerk <RedirectToOrganizationProfile>)。

import { useEffect } from 'react'
import type { ReactNode } from 'react'

export type RedirectToOrganizationProfileProps = {
  // 组织资料页路径,默认 /organization
  organizationProfileUrl?: string
}

export function RedirectToOrganizationProfile({
  organizationProfileUrl = '/organization',
}: RedirectToOrganizationProfileProps): ReactNode {
  useEffect(() => {
    window.location.replace(organizationProfileUrl)
  }, [organizationProfileUrl])

  return null
}
