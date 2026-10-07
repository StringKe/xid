// 挑战页底部:左侧切换方法(只在确有其他方法时出现),右侧登录时换账号、step-up 时取消。

import { Trans } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import { useSearch } from '@tanstack/react-router'
import * as stylex from '@stylexjs/stylex'
import { normalizeLocalPath } from '@xid-kit/types'
import { hosted } from '../../components/hosted/hosted-styles'
import { useAuth } from '../../lib/auth-context'
import { useDefaultLandingPath } from '../../lib/default-landing'
import { Link, useNavigate } from '@xid-kit/web-ui/tanstack-router'
import { mfaMethodSearch, type MfaMethod, type MfaSearch } from './mfa-search'

// 登出后回到登录页;来自 /authorize 时重新进入授权请求,由它带着原参数跳到登录页。
export function CancelSignOut(): ReactNode {
  const { signOut } = useAuth()
  const navigate = useNavigate()
  const search = useSearch({ strict: false }) as MfaSearch
  const resume = normalizeLocalPath(search.redirect_to)
  const target = resume?.startsWith('/authorize?') ? resume : '/sign-in'

  async function signOutAndRestart(): Promise<void> {
    await signOut()
    navigate(target, { replace: true })
  }

  return (
    <button
      type="button"
      onClick={() => void signOutAndRestart()}
      {...stylex.props(hosted.quietLink)}
    >
      <Trans>Sign in as someone else</Trans>
    </button>
  )
}

function CancelStepUp(): ReactNode {
  const navigate = useNavigate()
  const search = useSearch({ strict: false }) as MfaSearch
  const fallback = useDefaultLandingPath()
  return (
    <button
      type="button"
      onClick={() =>
        navigate(normalizeLocalPath(search.redirect_to) ?? fallback, { replace: true })
      }
      {...stylex.props(hosted.quietLink)}
    >
      <Trans>Cancel</Trans>
    </button>
  )
}

export function ChallengeExits({
  methods,
  isStepUp,
}: {
  methods: readonly MfaMethod[]
  isStepUp: boolean
}): ReactNode {
  const search = useSearch({ strict: false }) as MfaSearch
  return (
    <div {...stylex.props(hosted.group)}>
      <hr {...stylex.props(hosted.rule)} />
      <div {...stylex.props(hosted.linkRow)}>
        {methods.length > 1 ? (
          <Link
            to={{ pathname: '/mfa', search: mfaMethodSearch(null, search) }}
            replace
            {...stylex.props(hosted.textLink)}
          >
            <Trans>Try another way</Trans>
          </Link>
        ) : (
          <span />
        )}
        {isStepUp ? <CancelStepUp /> : <CancelSignOut />}
      </div>
    </div>
  )
}
