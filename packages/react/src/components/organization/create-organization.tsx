// CreateOrganization:创建新 org 组件(对标 Clerk <CreateOrganization>)。
// redirect 模式跳转 Hosted UI 创建页。

import type { ReactNode, CSSProperties } from 'react'

import { useLingui } from '@lingui/react'

import type { Appearance } from '../../appearance'
import { buildCssVariables, cx } from '../../appearance'
import { useXidContext } from '../../context/xid-context'
import { Rt, rt, sdkMessages } from '../../i18n-runtime'

export type CreateOrganizationProps = {
  // Hosted UI 创建 org 页 URL
  createOrganizationUrl?: string
  // 创建成功后跳转
  redirectUrl?: string
  appearance?: Appearance
  className?: string
}

export function CreateOrganization({
  createOrganizationUrl = '/create-organization',
  redirectUrl,
  appearance,
  className,
}: CreateOrganizationProps): ReactNode {
  const { publishableKey } = useXidContext()
  const { _ } = useLingui()
  const cssVars = buildCssVariables(appearance?.variables)
  const cardClass = cx('xid-create-org', appearance?.elements?.card, className)

  const target = redirectUrl
    ? `${createOrganizationUrl}?redirect_url=${encodeURIComponent(redirectUrl)}&pk=${encodeURIComponent(publishableKey)}`
    : `${createOrganizationUrl}?pk=${encodeURIComponent(publishableKey)}`

  return (
    <div
      className={cardClass}
      style={cssVars as CSSProperties}
      role="region"
      aria-label={rt(_, sdkMessages.createOrganization)}
    >
      <div className={cx('xid-create-org__header', appearance?.elements?.cardHeader)}>
        <h2>
          <Rt {...sdkMessages.createOrganization} />
        </h2>
      </div>
      <div className="xid-create-org__body">
        <a
          href={target}
          className={cx('xid-button xid-button--primary', appearance?.elements?.buttonPrimary)}
          role="button"
        >
          <Rt {...sdkMessages.continue} />
        </a>
      </div>
    </div>
  )
}
