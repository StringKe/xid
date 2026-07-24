// OrganizationSwitcher:切换活跃 org 下拉选择器(对标 Clerk <OrganizationSwitcher>)。

import { type ReactNode, type CSSProperties, useCallback, useEffect, useRef, useState } from 'react'

import { useLingui } from '@lingui/react'
import { AnimatePresence, MotionConfig, motion } from 'motion/react'
import type { Transition } from 'motion/react'

import type { Appearance } from '../../appearance'
import { buildCssVariables, cx } from '../../appearance'
import { useXidContext } from '../../context/xid-context'
import { useXidStore } from '../../hooks/use-xid-store'
import { Rt, rt, sdkMessages } from '../../i18n-runtime'

// 弹出层弹簧:与 apps/server lib/motion 的 springSnappy/popoverMotion 同值;
// 包内复制一份,SDK 不依赖 app 内部模块。
const popoverTransition = { type: 'spring', bounce: 0, duration: 0.3 } as const satisfies Transition
const popoverMotion = {
  initial: { opacity: 0, scale: 0.96, y: -4 },
  animate: { opacity: 1, scale: 1, y: 0 },
  exit: { opacity: 0, scale: 0.96, y: -4 },
} as const

export type OrganizationSwitcherProps = {
  // 创建新 org 的链接
  createOrganizationUrl?: string
  // 切换到个人上下文时的 label
  personalWorkspaceLabel?: string
  appearance?: Appearance
  className?: string
}

export function OrganizationSwitcher({
  createOrganizationUrl = '/create-organization',
  appearance,
  className,
}: OrganizationSwitcherProps): ReactNode {
  const { client } = useXidContext()
  const state = useXidStore()
  const { _ } = useLingui()
  const [open, setOpen] = useState(false)
  const [switching, setSwitching] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)

  const cssVars = buildCssVariables(appearance?.variables)
  const triggerClass = cx(
    'xid-org-switcher__trigger',
    appearance?.elements?.organizationSwitcherTrigger,
    className,
  )
  const popoverClass = cx(
    'xid-org-switcher__popover',
    appearance?.elements?.organizationSwitcherPopover,
  )

  // 外部点击 / Escape 关闭后焦点回 trigger:弹层关闭后焦点不能丢在已卸载节点里。
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

  const switchOrg = useCallback(
    async (organizationId: string | null) => {
      if (switching) return
      setSwitching(true)
      try {
        await client.setActiveOrganization({ organizationId })
        setOpen(false)
      } finally {
        setSwitching(false)
      }
    },
    [client, switching],
  )

  if (!state.isLoaded || !state.isSignedIn) return null

  const memberships = state.user?.organizationMemberships ?? []
  const activeOrg = state.organization

  return (
    <div className="xid-org-switcher" style={cssVars as CSSProperties}>
      <button
        ref={triggerRef}
        type="button"
        className={triggerClass}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={activeOrg?.name ?? rt(_, sdkMessages.personalAccount)}
      >
        {activeOrg ? (
          <span>{activeOrg.name}</span>
        ) : (
          <span>
            <Rt {...sdkMessages.personalAccount} />
          </span>
        )}
        <span aria-hidden="true"> v</span>
      </button>

      {/* MotionConfig 包在组件内部:SDK 消费者不一定挂 MotionConfig,
          reducedMotion="user" 保证跟随系统减少动态效果设置。 */}
      <MotionConfig reducedMotion="user">
        <AnimatePresence>
          {open && (
            <motion.div
              ref={popoverRef}
              className={popoverClass}
              role="listbox"
              aria-label={rt(_, sdkMessages.selectOrganization)}
              {...popoverMotion}
              transition={popoverTransition}
              style={{ transformOrigin: 'top left' }}
            >
              {/* 个人上下文选项 */}
              <button
                type="button"
                role="option"
                aria-selected={activeOrg === null}
                className={cx(
                  'xid-org-switcher__option',
                  activeOrg === null && 'xid-org-switcher__option--active',
                )}
                onClick={() => void switchOrg(null)}
                disabled={switching}
              >
                <Rt {...sdkMessages.personalAccount} />
              </button>

              {/* org 列表 */}
              {memberships.map((m) => (
                <button
                  key={m.organization.id}
                  type="button"
                  role="option"
                  aria-selected={activeOrg?.id === m.organization.id}
                  className={cx(
                    'xid-org-switcher__option',
                    activeOrg?.id === m.organization.id && 'xid-org-switcher__option--active',
                  )}
                  onClick={() => void switchOrg(m.organization.id)}
                  disabled={switching}
                >
                  {m.organization.name}
                </button>
              ))}

              <hr role="separator" />

              {/* 创建新 org */}
              <a
                href={createOrganizationUrl}
                className="xid-org-switcher__create"
                onClick={() => setOpen(false)}
              >
                <Rt {...sdkMessages.createOrganization} />
              </a>
            </motion.div>
          )}
        </AnimatePresence>
      </MotionConfig>
    </div>
  )
}
