// 全站 JS 动效用 spring 而非 duration+easing(可中断/可反向);bounce:0 无 overshoot,仅拖甩动量允许回弹。

import type { Transition } from 'motion/react'

export const springDefault = {
  type: 'spring',
  bounce: 0,
  duration: 0.4,
} as const satisfies Transition

// 仅拖/甩动量场景;bounce 约 0.2,再大会"弹"出戏。
export const springMomentum = {
  type: 'spring',
  bounce: 0.2,
  duration: 0.4,
} as const satisfies Transition

export const springPress = {
  type: 'spring',
  bounce: 0,
  duration: 0.25,
} as const satisfies Transition

export const springSnappy = {
  type: 'spring',
  bounce: 0,
  duration: 0.3,
} as const satisfies Transition

// transform-origin 由调用方按弹出方向设置,预设不带以免锁死方向。
export const popoverMotion = {
  initial: { opacity: 0, scale: 0.96, y: -4 },
  animate: { opacity: 1, scale: 1, y: 0 },
  exit: { opacity: 0, scale: 0.96, y: -4 },
  transition: springSnappy,
} as const
