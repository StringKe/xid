// 响应式隐藏走 foundation.css 的全局类:StyleX 按属性整体覆盖,用 display 条件值会吞掉组件自己的 display。
// hidden 只作用于显式列出的档位,不向更宽档位继承。

import { VIEWPORTS, type Responsive } from '../../responsive'

export function responsiveHiddenClassName(
  hidden: Responsive<boolean> | undefined,
): string | undefined {
  if (hidden === undefined || hidden === false) return undefined
  if (hidden === true) return VIEWPORTS.map((viewport) => `xid-hidden-${viewport}`).join(' ')
  const classes = VIEWPORTS.filter((viewport) => hidden[viewport] === true).map(
    (viewport) => `xid-hidden-${viewport}`,
  )
  return classes.length > 0 ? classes.join(' ') : undefined
}
