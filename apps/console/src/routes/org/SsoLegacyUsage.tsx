// 旧协议连接不参与邮箱域名路由:SWA 由成员在账户页保存凭据后打开,LDAP、WS-Fed 与请求头连接由应用或代理直接调用登录地址。

import { Trans, useLingui } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import type { SsoConnectionView } from './auth-queries'
import { DetailSection, ValueRows } from './AuthDetailParts'

const ENTRY_PATHS: Partial<Record<string, string>> = {
  ldap: 'login',
  wsfed: 'login',
  header: 'authenticate',
}

function legacyEntryUrl(connection: SsoConnectionView): string | null {
  const path = ENTRY_PATHS[connection.type]
  if (!path) return null
  const origin = globalThis.location?.origin ?? ''
  return `${origin}/sso/${connection.type}/${encodeURIComponent(connection.id)}/${path}`
}

export function LegacyUsageText({ connection }: { connection: SsoConnectionView }): ReactNode {
  const name = connection.name
  if (connection.type === 'swa') {
    return (
      <Trans>
        Each member saves the username and password they use for {name} on their account security
        page, then opens it from App sign-ins. Email domains are not routed to {name}.
      </Trans>
    )
  }
  return (
    <Trans>
      Email domains are not routed to {name}. Point the app or proxy that signs people in at the
      address below.
    </Trans>
  )
}

export function LegacyEntryRows({ connection }: { connection: SsoConnectionView }): ReactNode {
  const { t } = useLingui()
  const entry = legacyEntryUrl(connection)
  if (!entry) return null
  return (
    <ValueRows
      rows={[
        {
          key: 'entry',
          label: <Trans>Sign-in address</Trans>,
          value: entry,
          mono: true,
          copyValue: entry,
          copySubject: t`sign-in address`,
        },
      ]}
    />
  )
}

export function LegacyUsageSection({ connection }: { connection: SsoConnectionView }): ReactNode {
  return (
    <DetailSection
      title={<Trans>How people sign in</Trans>}
      description={<LegacyUsageText connection={connection} />}
    >
      <LegacyEntryRows connection={connection} />
    </DetailSection>
  )
}
