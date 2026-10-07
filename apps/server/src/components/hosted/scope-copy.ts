// 标准 scope 的人话说明:与 discovery 公布的 scope 一致;自定义 scope 只显示 scope 名。

import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import { useLingui } from '@lingui/react/macro'
import type { IconName } from '../ui'

export type ScopeCopy = { label: MessageDescriptor; icon: IconName }

export const SCOPE_COPY: Readonly<Record<string, ScopeCopy>> = {
  openid: { label: msg`Know who you are`, icon: 'user' },
  profile: { label: msg`See your name and profile photo`, icon: 'user' },
  email: { label: msg`See your email address`, icon: 'mail' },
  phone: { label: msg`See your phone number`, icon: 'smartphone' },
  offline_access: { label: msg`Keep access when you're not using it`, icon: 'refresh' },
  organization: { label: msg`See your organization and role`, icon: 'building' },
}

export function useScopeLabel(): (scope: string) => string {
  const { i18n } = useLingui()
  return (scope) => {
    const copy = SCOPE_COPY[scope]
    return copy ? i18n._(copy.label) : scope
  }
}
