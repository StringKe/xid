import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { motion, springDefault } from '../../motion'
import { tokens } from '../../styles/tokens.stylex'

export type EmptyStateProps = {
  title: ReactNode
  description?: ReactNode
  action?: ReactNode
}

const styles = stylex.create({
  // 1px hairline + 透明底:空态是页面的一段留白,不做虚线占位卡。
  root: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '0.5rem',
    paddingBlock: '2.25rem',
    paddingInline: '1.5rem',
    textAlign: 'center',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: tokens['--xid-border'],
    borderRadius: tokens['--xid-radius'],
    backgroundColor: 'transparent',
    color: tokens['--xid-fg'],
    fontFamily: tokens['--xid-font'],
  },
  title: {
    margin: 0,
    fontSize: '0.875rem',
    fontWeight: 600,
  },
  description: {
    margin: 0,
    fontSize: '0.8125rem',
    lineHeight: 1.55,
    color: tokens['--xid-muted-foreground'],
    maxWidth: '42ch',
  },
})

export function EmptyState({ title, description, action }: EmptyStateProps): ReactNode {
  // 首次 mount 淡入(springDefault):loading -> 空态切换不跳闪;motion 只动 opacity,
  // reduced-motion 下自动豁免 transform/layout,opacity 淡入保留(可接受的降级)。
  return (
    <motion.div
      {...stylex.props(styles.root)}
      role="status"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={springDefault}
    >
      <p {...stylex.props(styles.title)}>{title}</p>
      {description ? <p {...stylex.props(styles.description)}>{description}</p> : null}
      {action}
    </motion.div>
  )
}
