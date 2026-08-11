import * as stylex from '@stylexjs/stylex'

export { consoleShell, page } from '@xid-kit/web-ui/styles/product-surface.stylex'

// account portal 骨架:root 零 paddingBottom(底白由 AccountLayout main 持有);header 复用 consoleShell。
export const account = stylex.create({
  root: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
  },
})
