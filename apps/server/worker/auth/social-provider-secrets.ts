// Social provider 的 client 凭据只来自 Workers Secret:内置 provider 用固定绑定名,自定义 provider
// 用运营方声明的 SOCIAL_*_CLIENT_SECRET。Apple 另外支持用 Team ID + Key ID + .p8 私钥按需签发。

import type { SocialProviderPolicy } from '@xid-kit/types'
import { AppError } from '../lib/errors'
import { appleSigningState } from './apple-client-secret'
import type { AppleSigningConfig } from './apple-client-secret'

export const BUILT_IN_SOCIAL_PROVIDER_SECRET_BINDINGS = {
  google: 'GOOGLE_CLIENT_SECRET',
  github: 'GITHUB_CLIENT_SECRET',
  microsoft: 'MICROSOFT_CLIENT_SECRET',
  apple: 'APPLE_CLIENT_SECRET',
  github_emu: 'GITHUB_EMU_CLIENT_SECRET',
} as const

const CUSTOM_SOCIAL_SECRET_BINDING = /^SOCIAL_[A-Z0-9_]+_CLIENT_SECRET$/
const PROVIDER_KEY = /^[a-z0-9_-]+$/

function operatorSocialProviderBindings(env: Env): Readonly<Record<string, string>> {
  const raw = env.SOCIAL_PROVIDER_SECRET_BINDINGS
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, string] =>
          PROVIDER_KEY.test(entry[0]) &&
          typeof entry[1] === 'string' &&
          CUSTOM_SOCIAL_SECRET_BINDING.test(entry[1]),
      ),
    )
  } catch {
    return {}
  }
}

// Secret binding names are deployment-controlled. Tenant policy can select a provider but cannot
// turn an arbitrary Env key into a credential oracle.
export function socialProviderSecretBinding(env: Env, provider: string): string | undefined {
  const builtIn =
    BUILT_IN_SOCIAL_PROVIDER_SECRET_BINDINGS[
      provider as keyof typeof BUILT_IN_SOCIAL_PROVIDER_SECRET_BINDINGS
    ]
  return builtIn ?? operatorSocialProviderBindings(env)[provider]
}

function staticSecret(env: Env, provider: string): string | null {
  const secretRef = socialProviderSecretBinding(env, provider)
  if (!secretRef) return null
  const value = (env as unknown as Record<string, unknown>)[secretRef]
  return typeof value === 'string' ? value : null
}

export type ProviderClientCredential =
  | { kind: 'static'; clientSecret: string }
  | { kind: 'apple_signed'; signing: AppleSigningConfig }

// Apple 三个签发变量只配了一部分时是部署配置错误,fail closed 而不是静默回落到静态 Secret。
export function providerClientCredential(env: Env, provider: string): ProviderClientCredential {
  if (provider === 'apple') {
    const signing = appleSigningState(env)
    if (signing.kind === 'complete') return { kind: 'apple_signed', signing: signing.config }
    if (signing.kind === 'partial') throw new AppError('server_error')
  }
  const clientSecret = staticSecret(env, provider)
  if (clientSecret === null) throw new AppError('invalid_request')
  return { kind: 'static', clientSecret }
}

export function hasProviderSecret(
  env: Env,
  _policy: SocialProviderPolicy,
  provider: string,
): boolean {
  if (provider === 'apple') {
    const signing = appleSigningState(env)
    if (signing.kind === 'complete') return true
    if (signing.kind === 'partial') return false
  }
  return staticSecret(env, provider) !== null
}
