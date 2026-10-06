import { Trans } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import { useSearch } from '@tanstack/react-router'
import * as stylex from '@stylexjs/stylex'
import { useAuth } from '../../lib/auth-context'
import { Link } from '../../lib/router'
import { mfaMethodSearch, type MfaMethod, type MfaSearch } from './mfa-search'
import { styles } from './styles'

// 取消并登出,避免守卫循环。
export function CancelSignOut(): ReactNode {
  const { signOut } = useAuth()
  return (
    <p {...stylex.props(styles.helperText)}>
      <button
        type="button"
        {...stylex.props(styles.buttonReset, styles.switchLink)}
        onClick={() => void signOut()}
      >
        <Trans>Cancel and sign out</Trans>
      </button>
    </p>
  )
}

// 只有用户确实拥有其他方法时才出现,回到只列出可用方法的选择页。
export function OtherMethodLink({ methods }: { methods: readonly MfaMethod[] }): ReactNode {
  const search = useSearch({ strict: false }) as MfaSearch
  if (methods.length < 2) return null
  return (
    <p {...stylex.props(styles.helperText)}>
      <Link
        to={{ pathname: '/mfa', search: mfaMethodSearch(null, search) }}
        replace
        {...stylex.props(styles.switchLink)}
      >
        <Trans>Try another method</Trans>
      </Link>
    </p>
  )
}

export function ChallengeExits({ methods }: { methods: readonly MfaMethod[] }): ReactNode {
  return (
    <>
      <OtherMethodLink methods={methods} />
      <CancelSignOut />
    </>
  )
}
