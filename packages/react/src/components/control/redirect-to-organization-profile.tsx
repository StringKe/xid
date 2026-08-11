import { useEffect } from 'react'
import type { ReactNode } from 'react'

export type RedirectToOrganizationProfileProps = {
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
