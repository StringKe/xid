// 第二步各方法的名称、图标与目标说明;目标只来自用户自己输入的标识符。

import { Trans } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import type { IconName } from '../../components/ui'
import type { IdentifierKind } from './method-order'
import { maskEmail, phoneLastDigits } from './identifier-mask'
import type { SignInMethod } from './shared'

export type MethodCopy = {
  title: ReactNode
  icon: IconName
  description?: ReactNode
}

function targetLine(identifier: string, kind: IdentifierKind): ReactNode {
  if (kind === 'email') {
    const masked = maskEmail(identifier.trim())
    return <Trans>To {masked}</Trans>
  }
  if (kind === 'phone') {
    const last = phoneLastDigits(identifier)
    return <Trans>To the number ending in {last}</Trans>
  }
  return undefined
}

export function methodCopy(
  method: SignInMethod,
  input: { identifier: string; kind: IdentifierKind },
): MethodCopy {
  const target = targetLine(input.identifier, input.kind)
  switch (method) {
    case 'otp-email':
      return { title: <Trans>Email a code</Trans>, icon: 'mail', description: target }
    case 'otp-sms':
      return { title: <Trans>Text a code</Trans>, icon: 'smartphone', description: target }
    case 'otp-whatsapp':
      return { title: <Trans>Send a code on WhatsApp</Trans>, icon: 'message', description: target }
    case 'magic-link':
      return { title: <Trans>Email a sign-in link</Trans>, icon: 'link', description: target }
    case 'passkey':
      return {
        title: <Trans>Use a passkey</Trans>,
        icon: 'passkey',
        description: <Trans>Face ID, fingerprint or a security key</Trans>,
      }
    case 'password':
      return { title: <Trans>Enter your password</Trans>, icon: 'password' }
    case 'enterprise-sso':
    default:
      return { title: <Trans>Use single sign-on</Trans>, icon: 'building' }
  }
}
