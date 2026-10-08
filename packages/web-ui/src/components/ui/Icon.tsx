// 内部线性图标,字形来自 icon-glyphs.ts 纯数据。不引第三方图标库,避免包体与风格漂移。

import { createElement } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { ICON_FRAME, ICON_GLYPHS, type IconName } from './icon-glyphs'

export { ICON_NAMES } from './icon-glyphs'
export type { IconName } from './icon-glyphs'

const styles = stylex.create({
  root: {
    display: 'inline-block',
    flexShrink: 0,
    verticalAlign: 'middle',
  },
})

export type IconProps = {
  name: IconName
  size?: number
  // 缺省视为装饰图标(aria-hidden);有独立语义时给 label。
  label?: string
}

export function Icon({ name, size = 16, label }: IconProps): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      {...ICON_FRAME}
      aria-hidden={label ? undefined : true}
      role={label ? 'img' : undefined}
      aria-label={label}
      {...stylex.props(styles.root)}
    >
      {label ? <title>{label}</title> : null}
      {ICON_GLYPHS[name].map(([tag, attrs], index) => createElement(tag, { key: index, ...attrs }))}
    </svg>
  )
}
