// OrganizationList:当前用户所有 org 成员关系列表(对标 Clerk <OrganizationList>)。

import type { ReactNode, CSSProperties } from 'react'

import { useLingui } from '@lingui/react'

import type { Appearance } from '../../appearance'
import { buildCssVariables, cx } from '../../appearance'
import { useXidContext } from '../../context/xid-context'
import { useXidStore } from '../../hooks/use-xid-store'
import { Rt, rt, sdkMessages } from '../../i18n-runtime'

export type OrganizationListProps = {
  // 点击某 org 后的跳转模板("/:slug" 会被替换)
  organizationProfileUrl?: string
  hidePersonal?: boolean
  createOrganizationUrl?: string
  appearance?: Appearance
  className?: string
}

export function OrganizationList({
  organizationProfileUrl = '/organization/:slug',
  createOrganizationUrl = '/create-organization',
  appearance,
  className,
}: OrganizationListProps): ReactNode {
  const { client } = useXidContext()
  const state = useXidStore()
  const { _ } = useLingui()
  const cssVars = buildCssVariables(appearance?.variables)
  const listClass = cx('xid-org-list', appearance?.elements?.card, className)

  if (!state.isLoaded) {
    return (
      <div
        className={listClass}
        style={cssVars as CSSProperties}
        aria-busy="true"
        aria-live="polite"
      >
        <Rt {...sdkMessages.loading} />
      </div>
    )
  }

  if (!state.isSignedIn) return null

  const memberships = state.user?.organizationMemberships ?? []

  function orgUrl(slug: string): string {
    return organizationProfileUrl.replace(':slug', encodeURIComponent(slug))
  }

  return (
    <div
      className={listClass}
      style={cssVars as CSSProperties}
      role="list"
      aria-label={rt(_, sdkMessages.organizationList)}
    >
      {memberships.length === 0 && (
        <p className="xid-org-list__empty">
          <Rt {...sdkMessages.noOrganizationsYet} />
        </p>
      )}

      {memberships.map((m) => (
        <div key={m.id} className="xid-org-list__item" role="listitem">
          {m.organization.imageUrl && (
            <img
              src={m.organization.imageUrl}
              alt={m.organization.name}
              width={32}
              height={32}
              className="xid-org-list__logo"
              style={{ borderRadius: 4 }}
            />
          )}
          <div className="xid-org-list__info">
            <a
              href={orgUrl(m.organization.slug)}
              className="xid-org-list__name"
              onClick={() => {
                void client.setActiveOrganization({ organizationId: m.organization.id })
              }}
            >
              {m.organization.name}
            </a>
            <span className="xid-org-list__role">{m.role}</span>
          </div>
        </div>
      ))}

      <div className="xid-org-list__actions">
        <a href={createOrganizationUrl} className="xid-org-list__create">
          <Rt {...sdkMessages.createOrganizationWithPrefix} />
        </a>
      </div>
    </div>
  )
}
