import * as stylex from '@stylexjs/stylex'

export { consoleShell, page } from '@xid-kit/web-ui/styles/product-surface.stylex'

// account portal 五页共享骨架:root 零 paddingBottom(底部留白由 AccountLayout main 持有)。
// headerZone / displayTitle / section 直接复用 consoleShell 的同值定义,不重复声明。
export const account = stylex.create({
  root: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
  },
})
