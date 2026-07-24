// nuxt/kit 由宿主 Nuxt 提供(peerDependency),本包不安装 nuxt 本体。
// shorthand ambient declaration 仅满足 tsc 的模块解析;
// module.ts 在动态 import 处用结构断言收窄到实际使用的最小 API 面。
declare module 'nuxt/kit'
