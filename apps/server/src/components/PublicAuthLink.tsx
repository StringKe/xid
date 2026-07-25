import { Trans } from '@lingui/react/macro'
import type { AnchorHTMLAttributes, ReactNode } from 'react'
import { useAuth } from '../lib/auth-context'

export type PublicAuthLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'>

export function PublicAuthLink(props: PublicAuthLinkProps): ReactNode {
  const { status } = useAuth()

  if (status === 'loading') return null

  if (status === 'authenticated') {
    return (
      <a {...props} href="/console">
        <Trans>Console</Trans>
      </a>
    )
  }

  return (
    <a {...props} href="/sign-in">
      <Trans>Sign in</Trans>
    </a>
  )
}
