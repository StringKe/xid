// 内置社交登录提供方的端点模板;客户端密钥由实例运营方配置为 Workers Secret,Console 只显示绑定名。

import type { OrgSocialProviderPolicy } from './types'

export const KNOWN_SOCIAL_PROVIDERS = ['google', 'microsoft', 'github', 'apple'] as const
export type KnownSocialProvider = (typeof KNOWN_SOCIAL_PROVIDERS)[number]

export const PROVIDER_NAMES: Record<string, string> = {
  google: 'Google',
  microsoft: 'Microsoft',
  github: 'GitHub',
  apple: 'Apple',
  github_emu: 'GitHub Enterprise Managed Users',
}

export function providerName(key: string): string {
  return PROVIDER_NAMES[key] ?? key
}

export function providerMonogram(key: string): string {
  const name = providerName(key)
  if (key === 'github') return 'GH'
  return name.slice(0, 1).toUpperCase()
}

export const EMPTY_SOCIAL_PROVIDER: OrgSocialProviderPolicy = {
  authorizationEndpoint: '',
  tokenEndpoint: '',
  clientId: '',
  clientSecretRef: '',
  userInfoEndpoint: '',
  scopes: ['openid', 'email', 'profile'],
  usesPkce: true,
  enabled: false,
  allowLogin: false,
  allowUserCreation: false,
  requireVerifiedEmail: true,
  allowedEmailDomains: [],
  blockedEmailDomains: [],
  hasClientSecret: false,
  credentialsReady: false,
}

export const SOCIAL_PROVIDER_TEMPLATES: Record<KnownSocialProvider, OrgSocialProviderPolicy> = {
  google: {
    ...EMPTY_SOCIAL_PROVIDER,
    authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenEndpoint: 'https://oauth2.googleapis.com/token',
    clientSecretRef: 'GOOGLE_CLIENT_SECRET',
    userInfoEndpoint: 'https://openidconnect.googleapis.com/v1/userinfo',
    issuer: 'https://accounts.google.com',
    jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
    scopes: ['openid', 'email', 'profile'],
  },
  microsoft: {
    ...EMPTY_SOCIAL_PROVIDER,
    authorizationEndpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenEndpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    clientSecretRef: 'MICROSOFT_CLIENT_SECRET',
    userInfoEndpoint: 'https://graph.microsoft.com/oidc/userinfo',
    issuer: 'https://login.microsoftonline.com/{tenantid}/v2.0',
    jwksUri: 'https://login.microsoftonline.com/common/discovery/v2.0/keys',
    scopes: ['openid', 'email', 'profile'],
  },
  github: {
    ...EMPTY_SOCIAL_PROVIDER,
    authorizationEndpoint: 'https://github.com/login/oauth/authorize',
    tokenEndpoint: 'https://github.com/login/oauth/access_token',
    clientSecretRef: 'GITHUB_CLIENT_SECRET',
    scopes: ['read:user', 'user:email'],
  },
  apple: {
    ...EMPTY_SOCIAL_PROVIDER,
    authorizationEndpoint: 'https://appleid.apple.com/auth/authorize',
    tokenEndpoint: 'https://appleid.apple.com/auth/token',
    clientSecretRef: 'APPLE_CLIENT_SECRET',
    issuer: 'https://appleid.apple.com',
    jwksUri: 'https://appleid.apple.com/auth/keys',
    scopes: ['openid', 'email', 'name'],
  },
}

export function isKnownProvider(key: string): key is KnownSocialProvider {
  return (KNOWN_SOCIAL_PROVIDERS as readonly string[]).includes(key)
}
