// server-only 入口:从 Vite virtual module 读取构建期序列化配置。

import options from 'virtual:@xid-kit/astro:config'

import { createXidMiddleware } from './middleware'

export const onRequest = createXidMiddleware(options)
