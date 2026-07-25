// RedirectToCreateOrganization:挂载即跳转到创建组织页(对标 Clerk <RedirectToCreateOrganization>)。

import { useEffect } from 'react'
import type { ReactNode } from 'react'

export type RedirectToCreateOrganizationProps = {
  // 创建组织页路径,默认 /create-organization
  createOrganizationUrl?: string
}

export function RedirectToCreateOrganization({
  createOrganizationUrl = '/create-organization',
}: RedirectToCreateOrganizationProps): ReactNode {
  useEffect(() => {
    window.location.replace(createOrganizationUrl)
  }, [createOrganizationUrl])

  return null
}
