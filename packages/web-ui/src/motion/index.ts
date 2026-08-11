// 动效统一出口;调用方不散写 'motion/react',库替换只改这一层。

export { AppMotionConfig } from './app-motion-config'
export { popoverMotion, springDefault, springMomentum, springPress, springSnappy } from './presets'
export { AnimatePresence, motion } from 'motion/react'
