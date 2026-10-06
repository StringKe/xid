// Cmd/Ctrl+K 命令菜单外壳:Dialog + 内联 Autocomplete。宽屏居中偏上,窄屏全屏 sheet;补充可见导航,不替代。

import { Autocomplete } from '@base-ui/react/autocomplete'
import { Dialog as BaseDialog } from '@base-ui/react/dialog'
import { Trans, useLingui } from '@lingui/react/macro'
import { useEffect } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { mergeClassNames } from '../../class-name'
import { commandStyles as styles } from './command-menu-styles'
import { Icon } from './Icon'

export type CommandItem = {
  id: string
  label: string
  description?: ReactNode
  trailing?: ReactNode
  keywords?: readonly string[]
  onSelect: () => void
}

export type CommandGroup = {
  label: string
  items: readonly CommandItem[]
}

export type CommandMenuProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  groups: readonly CommandGroup[]
  placeholder: string
}

export function isCommandMenuShortcut(
  event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey'>,
): boolean {
  return event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey) && !event.altKey
}

export function useCommandMenuShortcut(onOpen: () => void): void {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (!isCommandMenuShortcut(event)) return
      event.preventDefault()
      onOpen()
    }
    globalThis.addEventListener('keydown', onKeyDown)
    return () => globalThis.removeEventListener('keydown', onKeyDown)
  }, [onOpen])
}

function itemSearchText(item: CommandItem): string {
  return [item.label, ...(item.keywords ?? [])].join(' ')
}

export function CommandMenu({
  open,
  onOpenChange,
  groups,
  placeholder,
}: CommandMenuProps): ReactNode {
  const { t } = useLingui()
  const popup = stylex.props(styles.popup)

  function select(item: CommandItem): void {
    onOpenChange(false)
    item.onSelect()
  }

  return (
    <BaseDialog.Root open={open} onOpenChange={(next) => onOpenChange(next)}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className="xid-dialog-backdrop" />
        <BaseDialog.Viewport className="xid-dialog-viewport xid-dialog-narrow-fullscreen xid-command-viewport">
          <BaseDialog.Popup
            aria-label={t`Command menu`}
            className={mergeClassNames('xid-dialog-popup', popup.className)}
          >
            <Autocomplete.Root
              open
              inline
              items={groups as CommandGroup[]}
              itemToStringValue={(item: CommandItem) => itemSearchText(item)}
              autoHighlight="always"
              keepHighlight
            >
              <div {...stylex.props(styles.inputRow)}>
                <span aria-hidden="true" {...stylex.props(styles.inputIcon)}>
                  <Icon name="search" size={16} />
                </span>
                <Autocomplete.Input
                  aria-label={placeholder}
                  placeholder={placeholder}
                  {...stylex.props(styles.input)}
                />
                <BaseDialog.Close aria-label={t`Close`} {...stylex.props(styles.escape)}>
                  <Icon name="x" size={14} />
                </BaseDialog.Close>
              </div>
              <div {...stylex.props(styles.list)}>
                <Autocomplete.Empty {...stylex.props(styles.empty)}>
                  <Trans>Nothing matches. Try a name, email or ID.</Trans>
                </Autocomplete.Empty>
                <Autocomplete.List>
                  {(group: CommandGroup) => (
                    <Autocomplete.Group key={group.label} items={group.items as CommandItem[]}>
                      <Autocomplete.GroupLabel {...stylex.props(styles.groupLabel)}>
                        {group.label}
                      </Autocomplete.GroupLabel>
                      <Autocomplete.Collection>
                        {(item: CommandItem) => (
                          <Autocomplete.Item
                            key={item.id}
                            value={item}
                            onClick={() => select(item)}
                            className={(state) =>
                              stylex.props(styles.item, state.highlighted && styles.itemHighlighted)
                                .className
                            }
                          >
                            <span {...stylex.props(styles.itemText)}>
                              <span {...stylex.props(styles.itemLabel)}>{item.label}</span>
                              {item.description ? (
                                <span {...stylex.props(styles.itemDescription)}>
                                  {item.description}
                                </span>
                              ) : null}
                            </span>
                            {item.trailing}
                          </Autocomplete.Item>
                        )}
                      </Autocomplete.Collection>
                    </Autocomplete.Group>
                  )}
                </Autocomplete.List>
              </div>
              <div {...stylex.props(styles.footer)}>
                <span>
                  <Trans>Up and Down to move</Trans>
                </span>
                <span>
                  <Trans>Enter to open</Trans>
                </span>
                <span>
                  <Trans>Esc to close</Trans>
                </span>
              </div>
            </Autocomplete.Root>
          </BaseDialog.Popup>
        </BaseDialog.Viewport>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  )
}
