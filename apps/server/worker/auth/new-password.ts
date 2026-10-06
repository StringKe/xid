// 设置新密码的统一门槛:长度 -> HIBP(阻断)-> 最近历史复用。重置与修改密码共用同一错误码和字段映射。

import type { TenantContext } from '@xid-kit/types'
import { AppError } from '../lib/errors'
import { checkHibpBreached, isPasswordReused, validatePasswordLength } from './password'

export async function assertAcceptableNewPassword(opts: {
  ctx: TenantContext
  d1: D1Database
  userId: string
  password: string
  pepperRaw: string
  paramName: string
}): Promise<void> {
  const meta = { paramName: opts.paramName }
  if (!validatePasswordLength(opts.password).ok) throw new AppError('validation_failed', { meta })
  if (await checkHibpBreached(opts.password)) throw new AppError('password_breached', { meta })
  const reused = await isPasswordReused({
    ctx: opts.ctx,
    d1: opts.d1,
    userId: opts.userId,
    newPassword: opts.password,
    pepperRaw: opts.pepperRaw,
  })
  if (reused) throw new AppError('password_reused', { meta })
}
