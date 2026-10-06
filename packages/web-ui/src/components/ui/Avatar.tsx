// 名字首字母头像;有图用图。纯装饰,名字由旁边的文字提供给读屏。

import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'
import { text, weight } from '../../styles/scale.stylex'

export type AvatarProps = {
  name: string
  src?: string | null
  size?: 'sm' | 'md' | 'lg'
}

const styles = stylex.create({
  root: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    overflow: 'hidden',
    borderRadius: tokens['--xid-radius-full'],
    backgroundColor: tokens['--xid-muted'],
    color: tokens['--xid-muted-foreground'],
    fontFamily: tokens['--xid-font'],
    fontSize: text.xs,
    fontWeight: weight.medium,
    lineHeight: 1,
    userSelect: 'none',
  },
  sm: { width: '1.75rem', height: '1.75rem' },
  md: { width: '2rem', height: '2rem' },
  lg: { width: '2.5rem', height: '2.5rem', fontSize: text.sm },
  image: {
    width: '100%',
    height: '100%',
    objectFit: 'cover',
  },
})

export function initialsFor(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return ''
  const first = Array.from(words[0] ?? '')[0] ?? ''
  const last = words.length > 1 ? (Array.from(words[words.length - 1] ?? '')[0] ?? '') : ''
  return (first + last).toUpperCase()
}

export function Avatar({ name, src, size = 'md' }: AvatarProps): ReactNode {
  return (
    <span aria-hidden="true" {...stylex.props(styles.root, styles[size])}>
      {src ? <img src={src} alt="" {...stylex.props(styles.image)} /> : initialsFor(name)}
    </span>
  )
}
