// SignInTabs:登录方式 tab 栏(分段控制器) + 面板包裹器。
// CLS 防护:tab 栏初始渲染全部 tab(高度稳定),passkey tab 探测完成前 opacity:0 占位;
// 面板全部挂载,非激活面板绝对定位脱流(容器高度 = 激活面板高度),切换只动 opacity。
// 动效:面板 crossfade 与激活药丸滑动由 motion 弹簧驱动(可中断、可反向),
// StyleX 不再持有这两处的 transition(分工见 lib/motion)。

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
  // 仅在 passkey 探测成功后对用户可见(但始终占位)。
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
              // 共享药丸:layoutId 让切换 tab 时滑向新位置;absolute 脱流,零 CLS。
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

// 面板包裹:激活相对定位决定高度,非激活绝对定位脱流;切换只动 opacity,CLS ~= 0。
// inert:非激活面板从 tab order + a11y 树移除,内部 input 不再可聚焦(优于仅 aria-hidden+pointerEvents)。
// opacity 由 motion 驱动(initial=false 首帧即终态,切换从当前值续播,天然可中断)。
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
