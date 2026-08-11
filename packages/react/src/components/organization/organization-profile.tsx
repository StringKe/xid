import type { ReactNode, CSSProperties } from 'react'

import { useLingui } from '@lingui/react'

import type { Appearance } from '../../appearance'
import { buildCssVariables, cx } from '../../appearance'
import { useXidStore } from '../../hooks/use-xid-store'
import { Rt, rt, sdkMessages } from '../../i18n-runtime'

export type OrganizationProfileProps = {
  organizationProfileUrl?: string
  appearance?: Appearance
  className?: string
}

export function OrganizationProfile({
  organizationProfileUrl = '/organization',
  appearance,
  className,
}: OrganizationProfileProps): ReactNode {
  const state = useXidStore()
  const { _ } = useLingui()
  const cssVars = buildCssVariables(appearance?.variables)
  const cardClass = cx('xid-org-profile', appearance?.elements?.card, className)

  if (!state.isLoaded) {
    return (
      <div
        className={cardClass}
        style={cssVars as CSSProperties}
        aria-busy="true"
        aria-live="polite"
      >
        <Rt {...sdkMessages.loading} />
      </div>
    )
  }

  if (!state.isSignedIn || !state.organization) {
    return null
  }

  const { organization } = state

  return (
    <div
      className={cardClass}
      style={cssVars as CSSProperties}
      role="region"
      aria-label={rt(_, sdkMessages.organizationProfile)}
    >
      <div className={cx('xid-org-profile__header', appearance?.elements?.cardHeader)}>
        {organization.imageUrl && (
          <img
            src={organization.imageUrl}
            alt={organization.name}
            width={64}
            height={64}
            className="xid-org-profile__logo"
            style={{ borderRadius: 8 }}
          />
        )}
        <div className="xid-org-profile__info">
          <h2 className="xid-org-profile__name">{organization.name}</h2>
          {organization.slug && <p className="xid-org-profile__slug">@{organization.slug}</p>}
          <p className="xid-org-profile__members">
            <Rt {...sdkMessages.members} values={{ count: organization.membersCount }} />
          </p>
        </div>
      </div>
      <div className={cx('xid-org-profile__footer', appearance?.elements?.cardFooter)}>
        <a
          href={organizationProfileUrl}
          className={cx('xid-button xid-button--secondary', appearance?.elements?.buttonSecondary)}
        >
          <Rt {...sdkMessages.manageOrganization} />
        </a>
      </div>
    </div>
  )
}
