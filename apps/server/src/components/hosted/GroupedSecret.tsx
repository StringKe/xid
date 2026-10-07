// 每 4 位一个 inline-block:只在组间换行,组内不断开;组间不放空格字符,选中复制得到连续原值。
// 不用 <code>:全局 `:not(pre) > code` 的 nowrap 不在 StyleX layer 内,会压过组件样式。

import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import type { StyleXStyles } from '@stylexjs/stylex'
import { text } from '@xid-kit/web-ui/styles/scale.stylex'
import { tokens } from '../../styles/tokens.stylex'

const styles = stylex.create({
  root: {
    display: 'block',
    maxWidth: '100%',
    margin: 0,
    fontFamily: tokens['--xid-font-mono'],
    fontSize: text.md,
    lineHeight: '1.5rem',
    fontVariantNumeric: 'tabular-nums',
    color: tokens['--xid-fg'],
    whiteSpace: 'normal',
  },
  group: {
    display: 'inline-block',
    whiteSpace: 'nowrap',
    marginInlineEnd: { default: '0.75ch', ':last-child': 0 },
  },
})

function secretGroups(secret: string): string[] {
  return secret.replace(/\s+/g, '').match(/.{1,4}/gu) ?? []
}

export function GroupedSecret(props: { value: string; style?: StyleXStyles }): ReactNode {
  return (
    <span translate="no" {...stylex.props(styles.root, props.style)}>
      {secretGroups(props.value).map((group, index) => (
        <span key={index} {...stylex.props(styles.group)}>
          {group}
        </span>
      ))}
    </span>
  )
}
