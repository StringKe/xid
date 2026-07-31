// 登录页共享逻辑测试:OTP 聚合入口按启用渠道解析,避免未启用 SMS 出现在 UI。

import { describe, expect, it } from 'vitest'
import { DEFAULT_PUBLIC_AUTH_CONFIG } from './auth-config'
import {
  enabledSignInMethods,
  getEnabledOtpMethods,
  identifierPrompt,
  initialSignInMethod,
  isOtpMethod,
  resolveHostedReturn,
  resolveOtpMethod,
  requiredProfileFields,
  shouldShowOtpMethodSwitch,
  organizationSignInUrl,
  visibleProfileFields,
} from './shared'
import type { SignInMethod } from './shared'
import type { PublicHostedAuthConfig } from './auth-config'

function withIdentifierMode(
  identifierMode: PublicHostedAuthConfig['identifierMode'],
): PublicHostedAuthConfig {
  return { ...DEFAULT_PUBLIC_AUTH_CONFIG, identifierMode }
}

function withAllLocalMethods(
  identifierMode: PublicHostedAuthConfig['identifierMode'],
): PublicHostedAuthConfig {
  return {
    ...DEFAULT_PUBLIC_AUTH_CONFIG,
    identifierMode,
    methods: {
      ...DEFAULT_PUBLIC_AUTH_CONFIG.methods,
      password: { enabled: true, allowLogin: true, allowUserCreation: true },
      magicLink: { enabled: true, allowLogin: true, allowUserCreation: true },
      emailOtp: { enabled: true, allowLogin: true, allowUserCreation: true },
      whatsappOtp: { enabled: true, allowLogin: true, allowUserCreation: true },
      smsOtp: { enabled: true, allowLogin: true, allowUserCreation: true },
      passkey: { enabled: true, allowLogin: true, allowUserCreation: true },
    },
  }
}

describe('OTP sign-in method helpers', () => {
  it('只返回已启用的 OTP 渠道', () => {
    const methods: readonly SignInMethod[] = ['magic-link', 'otp-email']

    expect(getEnabledOtpMethods(methods)).toEqual(['otp-email'])
  })

  it('支持只有 WhatsApp OTP 启用', () => {
    const methods: readonly SignInMethod[] = ['magic-link', 'otp-whatsapp']

    expect(getEnabledOtpMethods(methods)).toEqual(['otp-whatsapp'])
    expect(resolveOtpMethod('magic-link', methods)).toBe('otp-whatsapp')
  })

  it('保留当前已启用的 OTP 渠道', () => {
    const methods: readonly SignInMethod[] = ['otp-email', 'otp-whatsapp', 'otp-sms']

    expect(resolveOtpMethod('otp-whatsapp', methods)).toBe('otp-whatsapp')
  })

  it('当前 OTP 渠道被禁用时回落到第一个已启用渠道', () => {
    const methods: readonly SignInMethod[] = ['otp-email']

    expect(resolveOtpMethod('otp-sms', methods)).toBe('otp-email')
  })

  it('识别 OTP 方法', () => {
    expect(isOtpMethod('otp-email')).toBe(true)
    expect(isOtpMethod('otp-whatsapp')).toBe(true)
    expect(isOtpMethod('otp-sms')).toBe(true)
    expect(isOtpMethod('magic-link')).toBe(false)
  })

  it('只有一个 OTP 渠道时不显示二级渠道菜单', () => {
    expect(shouldShowOtpMethodSwitch(['otp-email'])).toBe(false)
    expect(shouldShowOtpMethodSwitch(['otp-whatsapp'])).toBe(false)
    expect(shouldShowOtpMethodSwitch(['otp-sms'])).toBe(false)
    expect(shouldShowOtpMethodSwitch(['otp-whatsapp', 'otp-sms'])).toBe(true)
  })
})

describe('Hosted Auth method helpers', () => {
  it('默认公开配置首屏使用 magic link 而不是 password', () => {
    expect(enabledSignInMethods(DEFAULT_PUBLIC_AUTH_CONFIG)).toEqual(['magic-link', 'otp-email'])
    expect(initialSignInMethod(DEFAULT_PUBLIC_AUTH_CONFIG)).toBe('magic-link')
  })

  it('ambiguous resolver 不展示默认 root 登录方法', () => {
    expect(
      enabledSignInMethods({
        ...DEFAULT_PUBLIC_AUTH_CONFIG,
        resolution: {
          status: 'ambiguous',
          matchedBy: 'username',
          matches: [
            {
              organizationId: 'org_default',
              slug: 'default',
              name: 'Default Organization',
              issuer: 'https://xid.dev',
            },
          ],
        },
      }),
    ).toEqual([])
  })

  it('force SSO 命中时只展示 enterprise SSO', () => {
    const config = {
      ...DEFAULT_PUBLIC_AUTH_CONFIG,
      forceSso: true,
      methods: {
        ...DEFAULT_PUBLIC_AUTH_CONFIG.methods,
        enterpriseSso: {
          enabled: true,
          allowLogin: true,
          allowJitUserCreation: true,
          domainDiscovery: true,
          allowedEmailDomains: ['example.com'],
          blockedEmailDomains: [],
        },
        magicLink: { enabled: true, allowLogin: true, allowUserCreation: true },
        emailOtp: { enabled: true, allowLogin: true, allowUserCreation: true },
      },
    }

    expect(enabledSignInMethods(config)).toEqual(['enterprise-sso'])
    expect(initialSignInMethod(config)).toBe('enterprise-sso')
  })

  it('force SSO 命中但 enterprise SSO 不可用时不展示本地方法', () => {
    const config = {
      ...DEFAULT_PUBLIC_AUTH_CONFIG,
      forceSso: true,
      methods: {
        ...DEFAULT_PUBLIC_AUTH_CONFIG.methods,
        magicLink: { enabled: true, allowLogin: true, allowUserCreation: true },
        emailOtp: { enabled: true, allowLogin: true, allowUserCreation: true },
        password: { enabled: true, allowLogin: true, allowUserCreation: true },
        enterpriseSso: {
          enabled: false,
          allowLogin: false,
          allowJitUserCreation: false,
          domainDiscovery: false,
          allowedEmailDomains: [],
          blockedEmailDomains: [],
        },
      },
      socialProviders: [
        {
          provider: 'google',
          allowLogin: true,
          allowUserCreation: true,
          requireVerifiedEmail: true,
          allowedEmailDomains: [],
          blockedEmailDomains: [],
        },
      ],
    }

    expect(enabledSignInMethods(config)).toEqual([])
    expect(initialSignInMethod(config)).toBe('enterprise-sso')
  })

  it('username identifier 不展示 email 或 phone passwordless 方法', () => {
    expect(enabledSignInMethods(withAllLocalMethods('username'))).toEqual(['passkey', 'password'])
  })

  it('phone identifier 按 WhatsApp 再 SMS 展示 phone OTP 方法', () => {
    expect(enabledSignInMethods(withAllLocalMethods('phone'))).toEqual([
      'passkey',
      'password',
      'otp-whatsapp',
      'otp-sms',
    ])
  })

  it('external_id identifier 不展示 email 或 phone passwordless 方法', () => {
    expect(enabledSignInMethods(withAllLocalMethods('external_id'))).toEqual([
      'passkey',
      'password',
    ])
  })

  it('email_or_username identifier 保留 email passwordless 方法但隐藏 phone OTP', () => {
    expect(enabledSignInMethods(withAllLocalMethods('email_or_username'))).toEqual([
      'passkey',
      'password',
      'magic-link',
      'otp-email',
    ])
  })

  it('默认 profileFields 不额外渲染 identifier email 字段', () => {
    expect(visibleProfileFields(DEFAULT_PUBLIC_AUTH_CONFIG, 'magic-link')).toEqual([])
    expect(requiredProfileFields(DEFAULT_PUBLIC_AUTH_CONFIG, 'magic-link')).toEqual([])
  })

  it('required profileFields 渲染非 identifier 字段', () => {
    const config = {
      ...DEFAULT_PUBLIC_AUTH_CONFIG,
      profileFields: {
        ...DEFAULT_PUBLIC_AUTH_CONFIG.profileFields,
        username: 'required' as const,
        name: 'optional' as const,
      },
    }

    expect(visibleProfileFields(config, 'magic-link')).toEqual(['username', 'name'])
    expect(requiredProfileFields(config, 'magic-link')).toEqual(['username'])
  })

  it('identifierMode 决定密码和 passkey 的输入提示', () => {
    expect(identifierPrompt(withIdentifierMode('email'))).toMatchObject({
      mode: 'email',
      type: 'email',
      autoComplete: 'email',
    })
    expect(identifierPrompt(withIdentifierMode('username'))).toMatchObject({
      mode: 'username',
      type: 'text',
      autoComplete: 'username',
    })
    expect(identifierPrompt(withIdentifierMode('email_or_username'))).toMatchObject({
      mode: 'email_or_username',
      type: 'text',
      autoComplete: 'username',
    })
    expect(identifierPrompt(withIdentifierMode('phone'))).toMatchObject({
      mode: 'phone',
      type: 'tel',
      autoComplete: 'tel',
    })
    expect(identifierPrompt(withIdentifierMode('external_id'))).toMatchObject({
      mode: 'external_id',
      type: 'text',
      autoComplete: 'off',
    })
  })
})

describe('Hosted Auth return target helpers', () => {
  const originalLocation = globalThis.location

  function withLocationOrigin(origin: string): void {
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: new URL(origin),
    })
  }

  it('OIDC authorize context 优先回到 server authorize 续跑', () => {
    expect(resolveHostedReturn('/account', 'authz_123')).toBe(
      '/authorize?authz_request_id=authz_123',
    )
  })

  it('没有 OIDC authorize context 时使用普通 continue', () => {
    withLocationOrigin('https://acme.xid.dev/')
    try {
      expect(resolveHostedReturn('/console', null)).toBe('/console')
    } finally {
      Object.defineProperty(globalThis, 'location', {
        configurable: true,
        value: originalLocation,
      })
    }
  })

  it('没有 continue 时默认进入统一 console', () => {
    withLocationOrigin('https://xid.dev/')
    try {
      expect(resolveHostedReturn(null, null)).toBe('/console')
    } finally {
      Object.defineProperty(globalThis, 'location', {
        configurable: true,
        value: originalLocation,
      })
    }
  })

  it('非法 continue 回落统一 console', () => {
    withLocationOrigin('https://xid.dev/')
    try {
      expect(resolveHostedReturn('https://evil.example/steal', null)).toBe('/console')
    } finally {
      Object.defineProperty(globalThis, 'location', {
        configurable: true,
        value: originalLocation,
      })
    }
  })

  it('organizationSignInUrl 保留登录上下文并用 organization_id resolver hint 选择 organization', () => {
    withLocationOrigin('https://xid.dev/')
    try {
      expect(
        organizationSignInUrl(
          {
            organizationId: 'org_default',
            slug: 'default',
            name: 'Default Organization',
            issuer: 'https://xid.dev',
          },
          {
            loginHint: 'shared',
            continueParam: '/console',
            redirect: null,
            authzRequestId: 'authz_123',
            intent: 'sign-up',
            invitationToken: 'invite-token',
          },
        ),
      ).toBe(
        'https://xid.dev/sign-in?organization_id=org_default&login_hint=shared&authz_request_id=authz_123&continue=%2Fconsole&intent=sign-up&invitation_token=invite-token',
      )
    } finally {
      Object.defineProperty(globalThis, 'location', {
        configurable: true,
        value: originalLocation,
      })
    }
  })
})
