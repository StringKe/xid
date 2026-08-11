import { useEffect } from 'react'
import type { ReactNode } from 'react'

export type RedirectToCreateOrganizationProps = {
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
