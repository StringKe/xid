// Astro.locals 类型扩展:xidAuth 字段由 xidMiddleware 注入。
// 此 ambient declaration 扩展 astro App.Locals,使 .astro 页面可类型安全访问 Astro.locals.xidAuth。
// 消费者项目须在 tsconfig.json include 或 /// <reference> 引入本文件。

import type { AuthResult } from './types'

declare namespace App {
  interface Locals {
    // xidAuth 由 xidMiddleware 注入,always 存在(未登录时 userId=null)。
    xidAuth: AuthResult
  }
}
