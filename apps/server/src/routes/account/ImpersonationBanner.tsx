// 模拟登录会话在账户门户顶部常驻:谁在以谁的身份查看、只读、剩余时间,并能直接结束。
// 结束后只回到同源规则允许的 Console 平台用户页(https 或本机 http,路径固定,无 query 与 hash)。

import { Trans, useLingui } from '@lingui/react/macro'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { leading, text, weight } from '@xid-kit/web-ui/styles/scale.stylex'
import { Button } from '../../components/ui'
import { useAuth } from '../../lib/auth-context'
import { tokens } from '../../styles/tokens.stylex'

type ImpersonationEndResponse = {
  ok: true
  redirectUrl: string
}

const RETURN_PATH = '/console/platform/users'

const styles = stylex.create({
  band: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '0.75rem 1.5rem',
    minHeight: '3rem',
    paddingBlock: '0.5rem',
    paddingInline: { default: '1rem', '@media (min-width: 48rem)': '1.5rem' },
    backgroundColor: tokens['--xid-warning-bg'],
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
    color: tokens['--xid-fg'],
    fontFamily: tokens['--xid-font'],
  },
  message: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
    minWidth: 0,
  },
  icon: {
    display: { default: 'none', '@media (min-width: 48rem)': 'inline-flex' },
    flexShrink: 0,
    color: tokens['--xid-warning'],
  },
  wide: {
    display: { default: 'none', '@media (min-width: 48rem)': 'inline' },
    margin: 0,
    fontSize: text.sm,
    lineHeight: leading.sm,
  },
  narrow: {
    display: { default: 'flex', '@media (min-width: 48rem)': 'none' },
    flexDirection: 'column',
    gap: '0.125rem',
    minWidth: 0,
  },
  narrowTitle: {
    fontSize: text.base,
    lineHeight: leading.base,
    fontWeight: weight.medium,
  },
  narrowSub: {
    fontSize: text.sm,
    lineHeight: leading.sm,
    color: tokens['--xid-warning'],
  },
  end: {
    display: 'flex',
    alignItems: 'center',
    gap: '1rem',
    flexShrink: 0,
  },
  remaining: {
    display: { default: 'none', '@media (min-width: 48rem)': 'inline' },
    fontSize: text.sm,
    fontVariantNumeric: 'tabular-nums',
    color: tokens['--xid-warning'],
  },
  error: {
    margin: 0,
    fontSize: text.sm,
    color: tokens['--xid-danger'],
  },
  wideLabel: {
    display: { default: 'none', '@media (min-width: 48rem)': 'inline' },
  },
  narrowLabel: {
    display: { default: 'inline', '@media (min-width: 48rem)': 'none' },
  },
})

function isAllowedReturnUrl(value: string): boolean {
  let target: URL
  try {
    target = new URL(value)
  } catch {
    return false
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)
  return (
    (target.protocol === 'https:' || (loopback && target.protocol === 'http:')) &&
    target.pathname === RETURN_PATH &&
    target.search === '' &&
    target.hash === ''
  )
}

function useRemaining(expiresAt: string): string {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const seconds = Math.max(0, Math.floor((new Date(expiresAt).getTime() - now) / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export function ImpersonationBanner(): ReactNode {
  const { session, user } = useAuth()
  if (!session?.isImpersonation || !user) return null
  return <ImpersonationNotice expiresAt={session.expiresAt} />
}

function ImpersonationNotice({ expiresAt }: { expiresAt: string }): ReactNode {
  const { t } = useLingui()
  const { api, session, user, activeOrg } = useAuth()
  const [ending, setEnding] = useState(false)
  const [failed, setFailed] = useState(false)
  const remaining = useRemaining(expiresAt)
  const manager =
    session?.impersonator?.displayName ?? session?.impersonator?.email ?? t`An instance manager`
  const viewed = user?.name ?? user?.email ?? ''
  const organization = activeOrg?.name ?? ''

  async function end(): Promise<void> {
    if (ending) return
    setEnding(true)
    setFailed(false)
    const result = await api.post<ImpersonationEndResponse>('/auth/impersonation/end')
    if (result.ok && isAllowedReturnUrl(result.value.redirectUrl)) {
      globalThis.location.assign(result.value.redirectUrl)
      return
    }
    setEnding(false)
    setFailed(true)
  }

  return (
    <section aria-label={t`Impersonation session`} {...stylex.props(styles.band)}>
      <div {...stylex.props(styles.message)}>
        <svg
          aria-hidden="true"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          {...stylex.props(styles.icon)}
        >
          <circle cx="12" cy="8" r="4" />
          <path d="M4 21a8 8 0 0 1 16 0" />
        </svg>
        <p {...stylex.props(styles.wide)}>
          <Trans>
            {manager} is viewing {organization} as {viewed}. Read-only: changes are blocked.
          </Trans>
        </p>
        <span {...stylex.props(styles.narrow)}>
          <span {...stylex.props(styles.narrowTitle)}>
            <Trans>Viewing as {viewed}</Trans>
          </span>
          <span {...stylex.props(styles.narrowSub)}>
            <Trans>
              {manager}, read-only, {remaining} left
            </Trans>
          </span>
        </span>
        {failed ? (
          <p role="alert" {...stylex.props(styles.error)}>
            <Trans>The session could not be ended. Try again.</Trans>
          </p>
        ) : null}
      </div>
      <div {...stylex.props(styles.end)}>
        <span {...stylex.props(styles.remaining)}>
          <Trans>{remaining} left</Trans>
        </span>
        <Button variant="primary" isLoading={ending} onClick={() => void end()}>
          <span {...stylex.props(styles.wideLabel)}>
            <Trans>End impersonation</Trans>
          </span>
          <span {...stylex.props(styles.narrowLabel)}>
            <Trans context="impersonation">End</Trans>
          </span>
        </Button>
      </div>
    </section>
  )
}
