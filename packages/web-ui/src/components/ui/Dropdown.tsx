// 菜单按钮:Base UI Menu 负责 portal、碰撞翻转、typeahead 与焦点;本组件只管外观和条目映射。

import { Menu } from '@base-ui/react/menu'
import { useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import type { StyleXStyles } from '@stylexjs/stylex'
import { mergeClassNames } from '../../class-name'
import { Icon, type IconName } from './Icon'
import { popupStyles } from './popup-styles'

export type DropdownItem = {
  key: string
  label: ReactNode
  icon?: IconName
  // 给出 checked 即视为可勾选项(menuitemcheckbox),当前项打勾。
  checked?: boolean
  disabled?: boolean
  tone?: 'default' | 'danger'
  onSelect?: () => void
  // href 项走文档导航(跨 Worker 表面,如 /account);SPA 内跳转用 onSelect + navigate。
  href?: string
  separatorBefore?: boolean
}

export type DropdownProps = {
  // ReactNode 或 render prop(open 供触发器换 caret 方向等);外层恒为 button,获 aria 与焦点。
  trigger: ReactNode | ((state: { open: boolean }) => ReactNode)
  items: readonly DropdownItem[]
  header?: ReactNode
  align?: 'start' | 'end'
  side?: 'bottom' | 'top'
  ariaLabel: string
  disabled?: boolean
  fullWidth?: boolean
  // 触发器视觉(hover 底、内距)归调用方。
  triggerStyle?: StyleXStyles
}

const styles = stylex.create({
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
    cursor: 'pointer',
  },
  triggerDisabled: {
    cursor: 'not-allowed',
    opacity: 0.55,
  },
  fullWidth: {
    width: '100%',
  },
})

function itemClassName(item: DropdownItem) {
  return (state: { highlighted: boolean }): string | undefined =>
    stylex.props(
      popupStyles.item,
      state.highlighted && popupStyles.itemHighlighted,
      item.tone === 'danger' && popupStyles.itemDanger,
      item.disabled && popupStyles.itemDisabled,
    ).className
}

function ItemContent({ item }: { item: DropdownItem }): ReactNode {
  return (
    <>
      {item.icon ? (
        <span aria-hidden="true" {...stylex.props(popupStyles.itemIcon)}>
          <Icon name={item.icon} size={16} />
        </span>
      ) : null}
      <span {...stylex.props(popupStyles.itemLabel)}>{item.label}</span>
    </>
  )
}

function DropdownMenuItem({ item }: { item: DropdownItem }): ReactNode {
  if (item.href) {
    return (
      <Menu.LinkItem
        href={item.href}
        className={itemClassName(item)}
        onClick={() => item.onSelect?.()}
      >
        <ItemContent item={item} />
      </Menu.LinkItem>
    )
  }
  if (item.checked !== undefined) {
    return (
      <Menu.CheckboxItem
        checked={item.checked}
        disabled={item.disabled}
        closeOnClick
        onCheckedChange={() => item.onSelect?.()}
        className={itemClassName(item)}
      >
        <ItemContent item={item} />
        <Menu.CheckboxItemIndicator {...stylex.props(popupStyles.itemCheck)}>
          <Icon name="check" size={14} />
        </Menu.CheckboxItemIndicator>
      </Menu.CheckboxItem>
    )
  }
  return (
    <Menu.Item
      disabled={item.disabled}
      onClick={() => item.onSelect?.()}
      className={itemClassName(item)}
    >
      <ItemContent item={item} />
    </Menu.Item>
  )
}

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
  const triggerProps = stylex.props(
    styles.trigger,
    disabled && styles.triggerDisabled,
    fullWidth && styles.fullWidth,
    triggerStyle,
  )
  const surface = stylex.props(popupStyles.surface, fullWidth && popupStyles.matchAnchor)
  const [open, setOpen] = useState(false)

  return (
    <Menu.Root disabled={disabled} open={open} onOpenChange={(next) => setOpen(next)}>
      <Menu.Trigger
        aria-label={ariaLabel}
        className={triggerProps.className}
        style={triggerProps.style}
      >
        {typeof trigger === 'function' ? trigger({ open }) : trigger}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner
          side={side}
          align={align}
          sideOffset={4}
          {...stylex.props(popupStyles.positioner)}
        >
          <Menu.Popup
            aria-label={ariaLabel}
            className={mergeClassNames(surface.className, 'xid-motion-pop')}
          >
            {header ? <div {...stylex.props(popupStyles.header)}>{header}</div> : null}
            {items.map((item) => (
              <DropdownEntry key={item.key} item={item} />
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}

function DropdownEntry({ item }: { item: DropdownItem }): ReactNode {
  return (
    <>
      {item.separatorBefore ? <Menu.Separator {...stylex.props(popupStyles.separator)} /> : null}
      <DropdownMenuItem item={item} />
    </>
  )
}
