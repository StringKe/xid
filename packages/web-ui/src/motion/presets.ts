// 弹簧预设:全站 JS 驱动动效统一用 spring 而非 duration+easing(Apple 流体设计:
// 动画可中断、可随时反向,速度天然跟随手势)。bounce:0 = critically damped 无
// overshoot,是 Apple 绝大多数 UI 的默认;只有拖/甩等动量场景才允许回弹。
// duration 预算对齐 ui-polish:即时反馈 100-300ms,布局/编排 <= 500ms。

import type { Transition } from 'motion/react'

// 默认弹簧:critically damped 无 overshoot(Apple 默认,绝大多数 UI)。
export const springDefault = {
  type: 'spring',
  bounce: 0,
  duration: 0.4,
} as const satisfies Transition

// 手势动量弹簧:仅拖/甩等动量场景(Apple 手势回弹约 0.2,再大就"弹"出戏)。
export const springMomentum = {
  type: 'spring',
  bounce: 0.2,
  duration: 0.4,
} as const satisfies Transition

// 即时反馈弹簧:按压/hover 微交互,短时长保证手感跟手。
export const springPress = {
  type: 'spring',
  bounce: 0,
  duration: 0.25,
} as const satisfies Transition

// 弹出层弹簧:进出场略快于默认(菜单类元素拖泥带水会显得卡)。
export const springSnappy = {
  type: 'spring',
  bounce: 0,
  duration: 0.3,
} as const satisfies Transition

// 弹出层进出场:从触发点生长(scale 0.96 -> 1),transform-origin 由调用方按
// 弹出方向设置(如 top left / bottom right),预设不带以免锁死方向。
export const popoverMotion = {
  initial: { opacity: 0, scale: 0.96, y: -4 },
  animate: { opacity: 1, scale: 1, y: 0 },
  exit: { opacity: 0, scale: 0.96, y: -4 },
  transition: springSnappy,
} as const
