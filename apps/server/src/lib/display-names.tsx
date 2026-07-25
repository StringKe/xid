import { Trans } from '@lingui/react/macro'
import type { ReactNode } from 'react'

const DEFAULT_ORGANIZATION_SLUG = 'default'
const DEFAULT_ORGANIZATION_NAME = 'Default Organization'

export function organizationDisplayName(input: {
  slug?: string | null
  name: string | null
}): ReactNode {
  if (input.name === DEFAULT_ORGANIZATION_NAME && input.slug !== undefined) {
    if (input.slug === null || input.slug === DEFAULT_ORGANIZATION_SLUG) {
      return <Trans>Default organization</Trans>
    }
  }
  if (input.name === DEFAULT_ORGANIZATION_NAME && input.slug === undefined) {
    return <Trans>Default organization</Trans>
  }
  return input.name ?? '-'
}
