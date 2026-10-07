// 第二步下方的「Try another way」:按租户开放的方法列出其余选项,本浏览器上次用过的方法标「Last used」。

import { Trans } from '@lingui/react/macro'
import { useId, useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Icon } from '../../components/ui'
import { OptionList } from '../../components/hosted/OptionList'
import { text, weight } from '@xid-kit/web-ui/styles/scale.stylex'
import { tokens } from '../../styles/tokens.stylex'
import { methodCopy } from './method-copy'
import type { IdentifierKind } from './method-order'
import type { SignInMethod } from './shared'

const styles = stylex.create({
  root: {
    display: 'flex',
    flexDirection: 'column',
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
  },
  toggle: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    minHeight: '3rem',
    padding: 0,
    borderWidth: 0,
    backgroundColor: 'transparent',
    color: tokens['--xid-fg'],
    fontFamily: tokens['--xid-font'],
    fontSize: text.base,
    fontWeight: weight.medium,
    cursor: 'pointer',
  },
})

export type TryAnotherWayProps = {
  methods: readonly SignInMethod[]
  current: SignInMethod
  lastUsed: SignInMethod | null
  identifier: string
  kind: IdentifierKind
  defaultOpen?: boolean
  disabled?: boolean
  onChoose: (method: SignInMethod) => void
}

export function TryAnotherWay(props: TryAnotherWayProps): ReactNode {
  const [open, setOpen] = useState(props.defaultOpen ?? false)
  const listId = useId()
  const others = props.methods.filter((method) => method !== props.current)
  if (others.length === 0) return null

  return (
    <div {...stylex.props(styles.root)}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((value) => !value)}
        {...stylex.props(styles.toggle)}
      >
        <Trans>Try another way</Trans>
        <Icon name={open ? 'caret-up' : 'caret-down'} size={16} />
      </button>
      <div id={listId} hidden={!open}>
        <OptionList
          items={others.map((method) => {
            const copy = methodCopy(method, { identifier: props.identifier, kind: props.kind })
            return {
              key: method,
              title: copy.title,
              description: copy.description,
              icon: copy.icon,
              badge:
                props.methods.length > 1 && method === props.lastUsed ? (
                  <Trans>Last used</Trans>
                ) : undefined,
              disabled: props.disabled,
              onSelect: () => props.onChoose(method),
            }
          })}
        />
      </div>
    </div>
  )
}
