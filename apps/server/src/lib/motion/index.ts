// 动效原语层统一出口:弹簧预设 + app 级 MotionConfig + motion 组件再导出。
// 调用方一律从这里 import,不散写 'motion/react'(库替换时只改这一层)。

export { AppMotionConfig } from './app-motion-config'
export { popoverMotion, springDefault, springMomentum, springPress, springSnappy } from './presets'
export { AnimatePresence, motion } from 'motion/react'
