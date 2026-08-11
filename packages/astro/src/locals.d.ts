// 扩展 App.Locals;消费者须在 tsconfig include 或 /// <reference> 引入本文件。

import type { AuthResult } from './types'

declare namespace App {
  interface Locals {
    // middleware 注入;未登录时仍存在且 userId=null。
    xidAuth: AuthResult
  }
}
