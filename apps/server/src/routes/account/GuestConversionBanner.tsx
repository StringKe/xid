// GuestConversionBanner:guest 用户在 account 区的转正引导横幅。
// 判定:isGuestUser(provisioned_by === 'anonymous');非 guest 不渲染。
// 关闭仅本次会话记忆(sessionStorage),不持久化到服务端;整页刷新后同 tab 内不再出现。
// 引导链向既有凭证设置入口 /account/security(转正 = 走任一既有凭证仪式,sub 不变,UI 无新流程)。

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'
import { isGuestUser, useAuth } from '../../lib/auth-context'
import { Link } from '../../lib/router'

const DISMISS_KEY = 'xid.guest-banner.dismissed'

function readDismissed(): boolean {
  try {
    return globalThis.sessionStorage?.getItem(DISMISS_KEY) === '1'
  } catch {
    return false
  }
}

function writeDismissed(): void {
  try {
    globalThis.sessionStorage?.setItem(DISMISS_KEY, '1')
  } catch {
    // sessionStorage 不可用(隐私模式)时横幅保持 React state 级关闭,不阻断。
  }
}

const styles = stylex.create({
  // 与 Alert warning 同 token 口径;横向布局:文案 + 引导链接 + 关闭。
  banner: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '0.75rem',
    marginInline: 'clamp(1rem, 2.5vw, 4rem)',
    marginTop: 'clamp(1.25rem, 1.6vw, 2rem)',
    paddingBlock: '0.625rem',
    paddingInline: '0.75rem',
    borderRadius: tokens['--xid-radius-sm'],
    borderWidth: '1px',
    borderStyle: 'solid',
    backgroundColor: tokens['--xid-warning-bg'],
    borderColor: tokens['--xid-warning'],
    color: tokens['--xid-fg'],
    fontFamily: tokens['--xid-font'],
    fontSize: '0.875rem',
    lineHeight: 1.5,
  },
  body: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.25rem',
    minWidth: 0,
    flex: 1,
  },
  title: {
    fontWeight: 600,
    color: tokens['--xid-warning-foreground'],
  },
  link: {
    alignSelf: 'flex-start',
    color: tokens['--xid-fg'],
    fontWeight: 560,
    fontSize: '0.8125rem',
    textDecorationLine: 'underline',
    textDecorationColor: {
      default: `color-mix(in oklch, ${tokens['--xid-fg']} 35%, transparent)`,
      ':hover': tokens['--xid-fg'],
    },
    textUnderlineOffset: '0.1875rem',
    transitionProperty: {
      default: 'text-decoration-color',
      '@media (prefers-reduced-motion: reduce)': 'none',
    },
    transitionDuration: '0.12s',
    transitionTimingFunction: 'ease-out',
  },
  dismiss: {
    flexShrink: 0,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: '1.75rem',
    minHeight: '1.75rem',
    padding: 0,
    backgroundColor: {
      default: 'transparent',
      ':hover': `color-mix(in oklch, ${tokens['--xid-fg']} 8%, transparent)`,
    },
    borderWidth: 0,
    borderStyle: 'none',
    borderRadius: tokens['--xid-radius-sm'],
    color: tokens['--xid-fg'],
    cursor: 'pointer',
    fontSize: '1rem',
    lineHeight: 1,
    fontFamily: tokens['--xid-font'],
  },
})

export function GuestConversionBanner(): ReactNode {
  const { t } = useLingui()
  const { user } = useAuth()
  const [dismissed, setDismissed] = useState(readDismissed)

  if (!isGuestUser(user) || dismissed) return null

  function handleDismiss(): void {
    writeDismissed()
    setDismissed(true)
  }

  return (
    <div role="status" {...stylex.props(styles.banner)}>
      <div {...stylex.props(styles.body)}>
        <strong {...stylex.props(styles.title)}>
          <Trans>Guest account</Trans>
        </strong>
        <span>
          <Trans>
            You are signed in as a guest. Sign out and this account and its data cannot be
            recovered.
          </Trans>
        </span>
        <Link to="/account/security" {...stylex.props(styles.link)}>
          <Trans>Set up a sign-in method</Trans>
        </Link>
      </div>
      <button
        type="button"
        aria-label={t`Dismiss guest notice`}
        onClick={handleDismiss}
        {...stylex.props(styles.dismiss)}
      >
        <span aria-hidden="true">×</span>
      </button>
    </div>
  )
}
