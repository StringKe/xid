// GuestConversionBanner:guest 用户在 account 区的转正引导横幅。
// 判定:isGuestUser(provisioned_by === 'anonymous');非 guest 不渲染。
// 关闭仅本次会话记忆(sessionStorage),不持久化到服务端;整页刷新后同 tab 内不再出现。
// 引导链向既有凭证设置入口 /account/security(转正 = 走任一既有凭证仪式,sub 不变,UI 无新流程)。
// band 口径与 console verificationBand 一致:全宽 section(aria-label)+ gutter + 下沿 hairline,
// band 本体无色,warning tone 由 Alert 持有,CTA 与关闭右置成行,不再是悬浮卡片。

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'
import { Alert } from '../../components/ui/Alert'
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

const GUTTER = 'clamp(1rem, 2.5vw, 4rem)'

const styles = stylex.create({
  band: {
    paddingBlock: '0.75rem',
    paddingInline: GUTTER,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
    backgroundColor: tokens['--xid-bg'],
  },
  notice: {
    display: 'flex',
    flexDirection: { default: 'column', '@media (min-width: 48rem)': 'row' },
    alignItems: { default: 'stretch', '@media (min-width: 48rem)': 'center' },
    gap: '0.75rem',
  },
  message: {
    flexGrow: 1,
    minWidth: 0,
  },
  actions: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    flexShrink: 0,
  },
  // CTA 镜像 Button secondary 口径(surface 底 + strong 描边),导航语义保留 <a>。
  actionLink: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    // 桌面密度与 Button 一致;触屏抬到 44px 触控目标。
    minHeight: {
      default: '2.375rem',
      '@media (pointer: coarse)': '2.75rem',
    },
    paddingBlock: 0,
    paddingInline: '0.875rem',
    borderRadius: tokens['--xid-radius'],
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: tokens['--xid-border-strong'],
    backgroundColor: {
      default: tokens['--xid-surface'],
      ':hover': tokens['--xid-muted'],
      ':active': tokens['--xid-muted'],
    },
    color: tokens['--xid-fg'],
    fontSize: '0.875rem',
    fontWeight: 560,
    whiteSpace: 'nowrap',
    textDecoration: 'none',
    transitionProperty: {
      default: 'background-color, border-color',
      '@media (prefers-reduced-motion: reduce)': 'none',
    },
    transitionDuration: '0.12s',
    transitionTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)',
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
      ':hover': tokens['--xid-muted'],
    },
    borderWidth: 0,
    borderStyle: 'none',
    borderRadius: tokens['--xid-radius-sm'],
    color: tokens['--xid-muted-foreground'],
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
    <section aria-label={t`Guest account`} {...stylex.props(styles.band)}>
      <div {...stylex.props(styles.notice)}>
        <div {...stylex.props(styles.message)}>
          <Alert tone="warning" title={<Trans>Guest account</Trans>}>
            <Trans>
              You are signed in as a guest. Sign out and this account and its data cannot be
              recovered.
            </Trans>
          </Alert>
        </div>
        <div {...stylex.props(styles.actions)}>
          <Link to="/account/security" {...stylex.props(styles.actionLink)}>
            <Trans>Set up a sign-in method</Trans>
          </Link>
          <button
            type="button"
            aria-label={t`Dismiss guest notice`}
            onClick={handleDismiss}
            {...stylex.props(styles.dismiss)}
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>
      </div>
    </section>
  )
}
