// 上下文栏文案:页面可整体覆盖;缺省按 /auth/config 的应用名与组织名说明「登录后继续到哪里」。

import { useLingui } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import { useHostedAuthConfig } from './use-hosted-auth-config'

export type AuthContextCopy = {
  lead?: ReactNode
  title: ReactNode
  description?: ReactNode
  // <64rem 时表单上方的一行摘要;省略则不显示。
  line?: ReactNode
}

export function useHostedContextCopy(override: AuthContextCopy | undefined): AuthContextCopy {
  const { t } = useLingui()
  const { config } = useHostedAuthConfig()
  if (override) return override
  const { applicationName, organizationName } = config.context
  if (applicationName) {
    return {
      lead: t`You are signing in to continue to`,
      title: applicationName,
      line: organizationName
        ? t`Continue to ${applicationName} by ${organizationName}`
        : t`Continue to ${applicationName}`,
    }
  }
  if (organizationName) {
    return { lead: t`You are signing in to`, title: organizationName }
  }
  return { lead: t`You are signing in to`, title: t`your XID account` }
}

// 注册流每一步都说明在创建账户,不沿用登录的缺省说法。
export function useSignUpContextCopy(context: {
  applicationName: string | null
  organizationName: string | null
}): AuthContextCopy {
  const { t } = useLingui()
  const line = useContinueLine()
  const target = context.applicationName ?? context.organizationName
  if (target) return { lead: t`You are creating an account to continue to`, title: target, line }
  return { lead: t`You are creating`, title: t`your XID account` }
}

// 已知应用时的一行摘要,供页面自定义上下文时复用。
export function useContinueLine(): string | undefined {
  const { t } = useLingui()
  const { config } = useHostedAuthConfig()
  const { applicationName, organizationName } = config.context
  if (!applicationName) return undefined
  return organizationName
    ? t`Continue to ${applicationName} by ${organizationName}`
    : t`Continue to ${applicationName}`
}
