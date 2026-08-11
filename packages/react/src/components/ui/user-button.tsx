import { type ReactNode, type CSSProperties, useCallback, useEffect, useRef, useState } from 'react'

import { useLingui } from '@lingui/react'
import { AnimatePresence, MotionConfig, motion } from 'motion/react'
import type { Transition } from 'motion/react'

import type { Appearance } from '../../appearance'
import { buildCssVariables, cx } from '../../appearance'
import { useXidContext } from '../../context/xid-context'
import { useXidStore } from '../../hooks/use-xid-store'
import { Rt, rt, sdkMessages } from '../../i18n-runtime'
import { UserAvatar } from './user-avatar'

// 与 apps/server lib/motion 同值;SDK 不能依赖 app 内部模块,故包内复制。
const popoverTransition = { type: 'spring', bounce: 0, duration: 0.3 } as const satisfies Transition
const popoverMotion = {
  initial: { opacity: 0, scale: 0.96, y: -4 },
  animate: { opacity: 1, scale: 1, y: 0 },
  exit: { opacity: 0, scale: 0.96, y: -4 },
} as const

export type UserButtonProps = {
  userProfileUrl?: string
  signOutRedirectUrl?: string
  appearance?: Appearance
  className?: string
}

export function UserButton({
  userProfileUrl = '/account',
  signOutRedirectUrl,
  appearance,
  className,
}: UserButtonProps): ReactNode {
  const { client } = useXidContext()
  const { _ } = useLingui()
  const state = useXidStore()
  const [open, setOpen] = useState(false)
  const [signingOut, setSigningOut] = useState(false)
  const [signOutError, setSignOutError] = useState<string | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)

  const cssVars = buildCssVariables(appearance?.variables)
  const triggerClass = cx(
    'xid-user-button__trigger',
    appearance?.elements?.userButtonTrigger,
    className,
  )
  const popoverClass = cx('xid-user-button__popover', appearance?.elements?.userButtonPopover)

  // 关闭后焦点回 trigger,避免焦点落在已卸载的菜单节点上
  const closePopover = useCallback(() => {
    setOpen(false)
    triggerRef.current?.focus()
  }, [])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (triggerRef.current?.contains(target) || popoverRef.current?.contains(target)) return
      closePopover()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closePopover()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, closePopover])

  const handleSignOut = useCallback(async () => {
    if (signingOut) return
    setSigningOut(true)
    setSignOutError(null)
    try {
      const result = await client.signOut()
      if (!result.ok) {
        setSignOutError(result.error.message)
        return
      }
      setOpen(false)
      if (signOutRedirectUrl) window.location.assign(signOutRedirectUrl)
    } catch {
      setSignOutError(rt(_, sdkMessages.signOutFailed))
    } finally {
      setSigningOut(false)
    }
  }, [_, client, signOutRedirectUrl, signingOut])

  if (!state.isLoaded || !state.isSignedIn || !state.user) return null

  const { user } = state

  return (
    <div className="xid-user-button" style={cssVars as CSSProperties}>
      <button
        ref={triggerRef}
        type="button"
        className={triggerClass}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={user.fullName ?? user.primaryEmailAddress ?? rt(_, sdkMessages.userMenu)}
      >
        <UserAvatar
          imageUrl={user.imageUrl}
          firstName={user.firstName}
          lastName={user.lastName}
          username={user.username}
          size={32}
          appearance={appearance}
        />
      </button>

      {/* 消费者未必挂 MotionConfig;包在内部并 reducedMotion="user" 跟随系统设置 */}
      <MotionConfig reducedMotion="user">
        <AnimatePresence>
          {open && (
            <motion.div
              ref={popoverRef}
              className={popoverClass}
              role="menu"
              aria-label={rt(_, sdkMessages.userMenu)}
              {...popoverMotion}
              transition={popoverTransition}
              style={{ position: 'absolute', zIndex: 1000, transformOrigin: 'top right' }}
            >
              <div className="xid-user-button__user-info" role="menuitem" aria-disabled>
                <UserAvatar
                  imageUrl={user.imageUrl}
                  firstName={user.firstName}
                  lastName={user.lastName}
                  username={user.username}
                  size={40}
                />
                <div className="xid-user-button__user-details">
                  {user.fullName && (
                    <span className="xid-user-button__full-name">{user.fullName}</span>
                  )}
                  {user.primaryEmailAddress && (
                    <span className="xid-user-button__email">{user.primaryEmailAddress}</span>
                  )}
                </div>
              </div>

              <hr role="separator" />

              <a
                href={userProfileUrl}
                className="xid-user-button__menu-item"
                role="menuitem"
                onClick={() => setOpen(false)}
              >
                <Rt {...sdkMessages.manageAccount} />
              </a>

              {state.sessions.length > 1 && (
                <>
                  <hr role="separator" />
                  {state.sessions
                    .filter((s) => s.id !== state.session?.id)
                    .map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        className="xid-user-button__menu-item"
                        role="menuitem"
                        onClick={() => {
                          void client.setActiveSession({ sessionId: s.id })
                          setOpen(false)
                        }}
                      >
                        <Rt {...sdkMessages.switchSession} />
                      </button>
                    ))}
                </>
              )}

              <hr role="separator" />

              {signOutError && (
                <p className="xid-user-button__sign-out-error" role="alert">
                  {signOutError}
                </p>
              )}
              <button
                type="button"
                className={cx(
                  'xid-user-button__menu-item xid-user-button__sign-out',
                  appearance?.elements?.buttonDanger,
                )}
                role="menuitem"
                onClick={() => void handleSignOut()}
                aria-busy={signingOut}
                disabled={signingOut}
              >
                <Rt {...sdkMessages.signOut} />
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </MotionConfig>
    </div>
  )
}
