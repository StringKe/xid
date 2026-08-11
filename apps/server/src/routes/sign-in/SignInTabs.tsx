// tab + 面板:passkey 探测前 opacity:0 占位;非激活面板 absolute 脱流,切换只动 opacity。

import { Trans, useLingui } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { motion, springDefault } from '../../lib/motion'
import { styles } from './styles'
import { isOtpMethod, resolveOtpMethod, type SignInMethod } from './shared'
import type { PasskeySupport } from './usePasskeySignIn'

type TabDef = {
  id: SignInMethod
  label: ReactNode
  // 探测成功前始终占位但不可见。
  passkeyOnly: boolean
}

const TABS: readonly TabDef[] = [
  { id: 'enterprise-sso', label: <Trans>SSO</Trans>, passkeyOnly: false },
  { id: 'passkey', label: <Trans>Passkey</Trans>, passkeyOnly: true },
  { id: 'password', label: <Trans>Password</Trans>, passkeyOnly: false },
  { id: 'magic-link', label: <Trans>Magic link</Trans>, passkeyOnly: false },
  { id: 'otp-email', label: <Trans>OTP</Trans>, passkeyOnly: false },
]

export type SignInTabsProps = {
  method: SignInMethod
  passkeySupport: PasskeySupport
  enabledMethods: readonly SignInMethod[]
  isSignUpFlow: boolean
  onSelect: (method: SignInMethod) => void
}

export function SignInTabs({
  method,
  passkeySupport,
  enabledMethods,
  isSignUpFlow,
  onSelect,
}: SignInTabsProps): ReactNode {
  const { t } = useLingui()
  const isOtp = isOtpMethod(method)
  const hasOtp =
    enabledMethods.includes('otp-email') ||
    enabledMethods.includes('otp-whatsapp') ||
    enabledMethods.includes('otp-sms')
  const tabs = TABS.filter(
    (tab) =>
      (!isSignUpFlow || tab.id !== 'passkey') &&
      (enabledMethods.includes(tab.id) || (tab.id === 'otp-email' && hasOtp)),
  )

  return (
    <div
      role="tablist"
      aria-label={isSignUpFlow ? t`Create your account` : t`Sign-in method`}
      {...stylex.props(styles.tablist)}
    >
      {tabs.map((tab) => {
        const visible = !tab.passkeyOnly || passkeySupport === 'yes'
        const active = tab.id === method || (tab.id === 'otp-email' && isOtp)
        return (
          <button
            key={tab.id}
            role="tab"
            type="button"
            aria-selected={active && visible}
            aria-hidden={!visible || undefined}
            tabIndex={visible ? 0 : -1}
            onClick={() => {
              if (!visible) return
              onSelect(tab.id === 'otp-email' ? resolveOtpMethod(method, enabledMethods) : tab.id)
            }}
            {...stylex.props(
              styles.tab,
              active && visible ? styles.tabActive : styles.tabInactive,
              visible ? styles.tabVisible : styles.tabHidden,
            )}
          >
            {active && visible ? (
              // layoutId 共享药丸滑动,absolute 脱流零 CLS。
              <motion.span
                layoutId="signin-tab-pill"
                transition={springDefault}
                aria-hidden="true"
                {...stylex.props(styles.tabPill)}
              />
            ) : null}
            <span {...stylex.props(styles.tabLabel)}>{tab.label}</span>
          </button>
        )
      })}
    </div>
  )
}

export type SignInPanelProps = {
  active: boolean
  children: ReactNode
}

// inert 从 tab order/a11y 树移除非激活面板(优于仅 aria-hidden)。
export function SignInPanel({ active, children }: SignInPanelProps): ReactNode {
  return (
    <motion.div
      aria-hidden={!active || undefined}
      inert={!active || undefined}
      initial={false}
      animate={{ opacity: active ? 1 : 0 }}
      transition={springDefault}
      {...stylex.props(styles.panel, active ? styles.panelActive : styles.panelInactive)}
    >
      {children}
    </motion.div>
  )
}
