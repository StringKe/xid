import { msg } from '@lingui/core/macro'
import type { I18n } from '@lingui/core'

// 目录的 provider 是自由文本;已知身份提供商显示产品名,其余原样显示。
const PROVIDER_NAMES: Record<string, string> = {
  okta: 'Okta',
  'microsoft-entra': 'Microsoft Entra ID',
  entra: 'Microsoft Entra ID',
  azure: 'Microsoft Entra ID',
  'azure-ad': 'Microsoft Entra ID',
  'google-workspace': 'Google Workspace',
  google: 'Google Workspace',
  onelogin: 'OneLogin',
  jumpcloud: 'JumpCloud',
  pingone: 'PingOne',
  pingfederate: 'PingFederate',
  keycloak: 'Keycloak',
  rippling: 'Rippling',
}

export function scimProviderLabel(i18n: I18n, provider: string): string {
  const key = provider.trim().toLowerCase()
  if (key === 'generic') return i18n._(msg`Generic SCIM`)
  return PROVIDER_NAMES[key] ?? provider
}
