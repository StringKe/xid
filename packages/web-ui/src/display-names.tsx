import { Trans, useLingui } from '@lingui/react/macro'
import { useCallback } from 'react'
import type { ReactNode } from 'react'

const DEFAULT_ORGANIZATION_SLUG = 'default'
const DEFAULT_ORGANIZATION_NAME = 'Default Organization'

type OrganizationNameInput = {
  slug?: string | null
  name: string | null
}

// 引导时写入的默认组织名按界面语言显示;slug 已知时只认 default 组织。
function isBootstrapDefaultOrganization(input: OrganizationNameInput): boolean {
  if (input.name !== DEFAULT_ORGANIZATION_NAME) return false
  return input.slug === undefined || input.slug === null || input.slug === DEFAULT_ORGANIZATION_SLUG
}

export function organizationDisplayName(input: OrganizationNameInput): ReactNode {
  if (isBootstrapDefaultOrganization(input)) return <Trans>Default organization</Trans>
  return input.name ?? '-'
}

export function useOrganizationLabel(): (input: OrganizationNameInput) => string {
  const { t } = useLingui()
  const defaultLabel = t`Default organization`
  return useCallback(
    (input: OrganizationNameInput) =>
      isBootstrapDefaultOrganization(input) ? defaultLabel : (input.name ?? '-'),
    [defaultLabel],
  )
}
