// 通用菜单按钮:触发器 + 浮层;键盘/焦点对齐 WAI menu button 模式,浮层动效走 popoverMotion 预设。
// 不做 portal 与自动翻转:控制台菜单都在顶栏/尾栏,锚定父级即可,引入定位库是过度设计。

import { useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent, MouseEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import type { StyleXStyles } from '@stylexjs/stylex'
import { AnimatePresence, motion, popoverMotion } from '../../motion'
import { tokens } from '../../styles/tokens.stylex'
import { Icon } from './Icon'
import type { IconName } from './Icon'

export type DropdownItem = {
  key: string
  label: ReactNode
  icon?: IconName
  // 给出 checked 即视为可勾选项(menuitemcheckbox),当前项打勾。
  checked?: boolean
  disabled?: boolean
  onSelect?: () => void
  // href 项走文档导航(跨 Worker 表面,如 /account);SPA 内跳转用 onSelect + navigate。
  href?: string
}

export type DropdownProps = {
  // ReactNode 或 render prop(open 供触发器换 caret 方向等);外层恒为 button,获 aria 与焦点。
  trigger: ReactNode | ((state: { open: boolean }) => ReactNode)
  items: readonly DropdownItem[]
  header?: ReactNode
  align?: 'start' | 'end'
  // side=top 供侧栏底部等贴底触发器向上弹出;缺省向下。
  side?: 'bottom' | 'top'
  ariaLabel: string
  disabled?: boolean
  // 移动导航等单列场景让触发器与菜单跟随容器宽度。
  fullWidth?: boolean
  // 触发器视觉(hover 底、内距)归调用方;与重置样式同一次 stylex.props 合成,保证优先级确定。
  triggerStyle?: StyleXStyles
}

const styles = stylex.create({
  root: {
    position: 'relative',
    display: 'inline-flex',
    minWidth: 0,
  },
  rootFullWidth: {
    width: '100%',
  },
  trigger: {
    appearance: 'none',
    display: 'inline-flex',
    alignItems: 'center',
    minWidth: 0,
    margin: 0,
    padding: 0,
    borderWidth: 0,
    borderStyle: 'none',
    backgroundColor: 'transparent',
    color: 'inherit',
    fontFamily: 'inherit',
    fontSize: 'inherit',
    textAlign: 'start',
    borderRadius: tokens['--xid-radius-sm'],
    outlineColor: tokens['--xid-primary'],
    outlineOffset: '2px',
  },
  triggerEnabled: {
    cursor: 'pointer',
  },
  triggerDisabled: {
    cursor: 'not-allowed',
    opacity: 0.55,
  },
  triggerFullWidth: {
    width: '100%',
  },
  menu: {
    position: 'absolute',
    zIndex: 30,
    display: 'flex',
    flexDirection: 'column',
    minWidth: '12rem',
    maxWidth: '18rem',
    maxHeight: 'min(24rem, calc(100dvh - 6rem))',
    overflowY: 'auto',
    margin: 0,
    paddingBlock: '0.25rem',
    paddingInline: 0,
    listStyle: 'none',
    backgroundColor: tokens['--xid-surface'],
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: tokens['--xid-border'],
    borderRadius: tokens['--xid-radius'],
    boxShadow: tokens['--xid-shadow-md'],
    color: tokens['--xid-fg'],
    fontFamily: tokens['--xid-font'],
  },
  menuFullWidth: {
    width: '100%',
    minWidth: '100%',
    maxWidth: 'none',
  },
  sideBottom: {
    top: 'calc(100% + 0.25rem)',
    transformOrigin: 'top',
  },
  sideTop: {
    bottom: 'calc(100% + 0.25rem)',
    transformOrigin: 'bottom',
  },
  alignStart: {
    insetInlineStart: 0,
  },
  alignEnd: {
    insetInlineEnd: 0,
  },
  header: {
    marginBlockEnd: '0.25rem',
    paddingBlock: '0.375rem 0.5rem',
    paddingInline: '0.75rem',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
    fontSize: '0.75rem',
    lineHeight: 1.5,
    color: tokens['--xid-muted-foreground'],
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  item: {
    appearance: 'none',
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    width: '100%',
    margin: 0,
    minHeight: '2.75rem',
    paddingBlock: '0.4375rem',
    paddingInline: '0.75rem',
    borderWidth: 0,
    borderStyle: 'none',
    backgroundColor: {
      default: 'transparent',
      ':hover': tokens['--xid-muted'],
      ':focus-visible': tokens['--xid-muted'],
    },
    color: tokens['--xid-fg'],
    fontFamily: 'inherit',
    fontSize: '0.8125rem',
    lineHeight: 1.4,
    textAlign: 'start',
    textDecoration: 'none',
    cursor: 'pointer',
    outlineOffset: '2px',
    outlineColor: tokens['--xid-primary'],
  },
  itemDisabled: {
    cursor: 'not-allowed',
    opacity: 0.55,
  },
  itemIcon: {
    display: 'inline-flex',
    color: tokens['--xid-muted-foreground'],
  },
  itemLabel: {
    flexGrow: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  itemCheck: {
    display: 'inline-flex',
    marginInlineStart: 'auto',
    color: tokens['--xid-primary'],
  },
})

type ItemElement = HTMLButtonElement | HTMLAnchorElement

function DropdownMenuItem({
  item,
  registerItem,
  onActivate,
}: {
  item: DropdownItem
  registerItem: (element: ItemElement | null) => void
  onActivate: (item: DropdownItem) => void
}): ReactNode {
  const content = (
    <>
      {item.icon ? (
        <span aria-hidden="true" {...stylex.props(styles.itemIcon)}>
          <Icon name={item.icon} size={16} />
        </span>
      ) : null}
      <span {...stylex.props(styles.itemLabel)}>{item.label}</span>
      {item.checked ? (
        <span aria-hidden="true" {...stylex.props(styles.itemCheck)}>
          <Icon name="check" size={14} />
        </span>
      ) : null}
    </>
  )
  const role = item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'
  const shared = {
    role,
    'aria-checked': item.checked === undefined ? undefined : item.checked,
    'aria-disabled': item.disabled || undefined,
  } as const

  // button 的 Enter/Space 走原生 click;anchor 只原生 Enter,Space 在此补齐。
  // keydown preventDefault 抑制原生激活,避免重复触发。
  function handleKeyActivation(event: KeyboardEvent<HTMLAnchorElement>): void {
    if (event.key !== ' ' && event.key !== 'Enter') return
    event.preventDefault()
    event.currentTarget.click()
  }

  if (item.href) {
    return (
      <a
        {...shared}
        tabIndex={-1}
        href={item.href}
        ref={registerItem}
        {...stylex.props(styles.item, item.disabled && styles.itemDisabled)}
        onClick={(event: MouseEvent<HTMLAnchorElement>) => {
          if (item.disabled) {
            event.preventDefault()
            return
          }
          onActivate(item)
        }}
        onKeyDown={handleKeyActivation}
      >
        {content}
      </a>
    )
  }

  return (
    <button
      {...shared}
      tabIndex={-1}
      type="button"
      disabled={item.disabled}
      ref={registerItem}
      {...stylex.props(styles.item, item.disabled && styles.itemDisabled)}
      onClick={() => onActivate(item)}
    >
      {content}
    </button>
  )
}

// 向上弹出时入场方向镜像(浮层从触发器一侧长出)。
const popoverMotionTop = {
  initial: { opacity: 0, scale: 0.96, y: 4 },
  animate: popoverMotion.animate,
  exit: { opacity: 0, scale: 0.96, y: 4 },
  transition: popoverMotion.transition,
} as const

export function Dropdown({
  trigger,
  items,
  header,
  align = 'start',
  side = 'bottom',
  ariaLabel,
  disabled = false,
  fullWidth = false,
  triggerStyle,
}: DropdownProps): ReactNode {
  const [open, setOpen] = useState(false)
  const menuId = useId()
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const itemRefs = useRef<Array<ItemElement | null>>([])

  function closeMenu(returnFocus: boolean): void {
    setOpen(false)
    if (returnFocus) triggerRef.current?.focus()
  }

  function focusableIndexes(): number[] {
    const indexes: number[] = []
    items.forEach((item, index) => {
      if (!item.disabled) indexes.push(index)
    })
    return indexes
  }

  function focusItem(index: number): void {
    itemRefs.current[index]?.focus()
  }

  function focusStep(delta: 1 | -1): void {
    const enabled = focusableIndexes()
    if (enabled.length === 0) return
    const current = itemRefs.current.findIndex((element) => element === document.activeElement)
    const position = enabled.indexOf(current)
    const nextPosition =
      position === -1
        ? delta === 1
          ? 0
          : enabled.length - 1
        : (position + delta + enabled.length) % enabled.length
    focusItem(enabled[nextPosition] ?? enabled[0] ?? 0)
  }

  function focusEdge(edge: 'first' | 'last'): void {
    const enabled = focusableIndexes()
    const target = edge === 'first' ? enabled[0] : enabled[enabled.length - 1]
    if (target !== undefined) focusItem(target)
  }

  // 打开后把焦点交给首项,键盘用户不丢失上下文。
  useEffect(() => {
    if (!open) return
    focusEdge('first')
  }, [open])

  // 点击菜单外任意处关闭;mousedown 先于 click,避免选中动作后才关。
  useEffect(() => {
    if (!open) return
    function onPointerDown(event: globalThis.MouseEvent): void {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open])

  function onTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    if (disabled) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setOpen(true)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setOpen(true)
      requestAnimationFrame(() => focusEdge('last'))
    }
  }

  function onMenuKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closeMenu(true)
    } else if (event.key === 'Tab') {
      // Tab 让焦点自然离开,菜单只负责关。
      closeMenu(false)
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      focusStep(1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      focusStep(-1)
    } else if (event.key === 'Home') {
      event.preventDefault()
      focusEdge('first')
    } else if (event.key === 'End') {
      event.preventDefault()
      focusEdge('last')
    }
  }

  function activate(item: DropdownItem): void {
    if (item.disabled) return
    item.onSelect?.()
    closeMenu(false)
  }

  const triggerProps = stylex.props(
    styles.trigger,
    disabled ? styles.triggerDisabled : styles.triggerEnabled,
    fullWidth && styles.triggerFullWidth,
    triggerStyle,
  )
  const motionPreset = side === 'top' ? popoverMotionTop : popoverMotion

  return (
    <div ref={rootRef} {...stylex.props(styles.root, fullWidth && styles.rootFullWidth)}>
      <button
        type="button"
        ref={triggerRef}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={ariaLabel}
        disabled={disabled}
        className={triggerProps.className}
        style={triggerProps.style}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={onTriggerKeyDown}
      >
        {typeof trigger === 'function' ? trigger({ open }) : trigger}
      </button>
      <AnimatePresence>
        {open ? (
          <motion.ul
            id={menuId}
            role="menu"
            aria-label={ariaLabel}
            initial={motionPreset.initial}
            animate={motionPreset.animate}
            exit={motionPreset.exit}
            transition={motionPreset.transition}
            {...stylex.props(
              styles.menu,
              fullWidth && styles.menuFullWidth,
              side === 'top' ? styles.sideTop : styles.sideBottom,
              align === 'end' ? styles.alignEnd : styles.alignStart,
            )}
            onKeyDown={onMenuKeyDown}
          >
            {header ? (
              <li role="presentation" {...stylex.props(styles.header)}>
                {header}
              </li>
            ) : null}
            {items.map((item, index) => (
              <li key={item.key} role="presentation">
                <DropdownMenuItem
                  item={item}
                  registerItem={(element) => {
                    itemRefs.current[index] = element
                  }}
                  onActivate={activate}
                />
              </li>
            ))}
          </motion.ul>
        ) : null}
      </AnimatePresence>
    </div>
  )
}
