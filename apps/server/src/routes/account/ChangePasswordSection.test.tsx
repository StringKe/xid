// @vitest-environment jsdom
// ChangePasswordSection 分形态测试:有密码 -> 改密表单;passwordless -> 邮件仪式面板
// (已验证邮箱 setup link / 未验证 resend verification / 无邮箱 passkey 引导)。
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { AuthUser } from '../../lib/auth-context'

const authState = vi.hoisted(() => ({
  user: null as AuthUser | null,
}))

const mutationState = vi.hoisted(() => ({
  sendSetupLink: { mutateAsync: vi.fn(), isPending: false },
  resendVerification: { mutateAsync: vi.fn(), isPending: false },
  changePassword: { mutateAsync: vi.fn(), isPending: false },
}))

vi.mock('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings[0] }),
}))

vi.mock('../../lib/auth-context', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/auth-context')>()
  return {
    ...original,
    useAuth: () => ({ user: authState.user }),
  }
})

vi.mock('./queries', () => ({
  useChangePassword: () => mutationState.changePassword,
  useSendPasswordSetupLink: () => mutationState.sendSetupLink,
  useResendVerificationEmail: () => mutationState.resendVerification,
}))

import { ChangePasswordSection } from './ChangePasswordSection'

function userWith(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: 'user_1',
    email: 'user@example.com',
    emailVerified: true,
    name: null,
    imageUrl: null,
    locale: null,
    hasMfa: false,
    instanceManager: false,
    ...overrides,
  }
}

describe('ChangePasswordSection', () => {
  beforeEach(() => {
    authState.user = null
    vi.clearAllMocks()
  })

  it('renders the change-password form when the user has a password', () => {
    authState.user = userWith({ hasPassword: true })

    const html = renderToStaticMarkup(<ChangePasswordSection />)

    expect(html).toContain('Change password')
    expect(html).toContain('Current password')
    expect(html).not.toContain('Set a password')
  })

  it('falls back to the change-password form when hasPassword is missing (older Core)', () => {
    authState.user = userWith()

    const html = renderToStaticMarkup(<ChangePasswordSection />)

    expect(html).toContain('Current password')
  })

  it('offers the setup-link ceremony to a passwordless user with a verified email', () => {
    authState.user = userWith({ hasPassword: false, emailVerified: true })

    const html = renderToStaticMarkup(<ChangePasswordSection />)

    expect(html).toContain('Set a password')
    expect(html).toContain('Email me a setup link')
    expect(html).toContain('user@example.com')
    expect(html).not.toContain('Current password')
  })

  it('requires email verification before setup for a passwordless user', () => {
    authState.user = userWith({ hasPassword: false, emailVerified: false })

    const html = renderToStaticMarkup(<ChangePasswordSection />)

    expect(html).toContain('Set a password')
    expect(html).toContain('Resend verification email')
    expect(html).not.toContain('Email me a setup link')
    expect(html).not.toContain('Current password')
  })

  it('guides a passwordless user without any email toward passkeys', () => {
    authState.user = userWith({ hasPassword: false, email: '', emailVerified: false })

    const html = renderToStaticMarkup(<ChangePasswordSection />)

    expect(html).toContain('No email address')
    expect(html).toContain('passkey')
    expect(html).not.toContain('Email me a setup link')
    expect(html).not.toContain('Resend verification email')
  })
})
