// AppError / httpStatusForCode 测试:code -> status 映射,meta/longMessage 透传,默认回退。

import { describe, it, expect } from 'vitest'
import { AppError, httpStatusForCode, isAppError } from '../errors'

describe('httpStatusForCode', () => {
  it('已知 code 映射到约定 status', () => {
    expect(httpStatusForCode('invalid_credentials')).toBe(401)
    expect(httpStatusForCode('email_verification_required')).toBe(403)
    expect(httpStatusForCode('rate_limited')).toBe(429)
    expect(httpStatusForCode('tenant_not_found')).toBe(404)
    expect(httpStatusForCode('server_error')).toBe(500)
    expect(httpStatusForCode('already_exists')).toBe(409)
    expect(httpStatusForCode('validation_failed')).toBe(422)
  })

  it('未在映射表的 code 回退 400', () => {
    expect(httpStatusForCode('membership_not_found')).toBe(400)
  })
})

describe('AppError', () => {
  it('默认按 code 推导 httpStatus', () => {
    const err = new AppError('forbidden')
    expect(err.httpStatus).toBe(403)
    expect(err.code).toBe('forbidden')
    expect(err.name).toBe('AppError')
  })

  it('显式 httpStatus 覆盖默认映射', () => {
    const err = new AppError('invalid_request', { httpStatus: 418 })
    expect(err.httpStatus).toBe(418)
  })

  it('携带 meta 与 longMessage', () => {
    const err = new AppError('validation_failed', {
      meta: { paramName: 'email' },
      longMessage: 'Email must be a valid address',
    })
    expect(err.meta).toEqual({ paramName: 'email' })
    expect(err.longMessage).toBe('Email must be a valid address')
  })

  it('未传 meta/longMessage 时不挂属性', () => {
    const err = new AppError('not_found')
    expect(err.meta).toBeUndefined()
    expect(err.longMessage).toBeUndefined()
  })

  it('isAppError 正确判别', () => {
    expect(isAppError(new AppError('not_found'))).toBe(true)
    expect(isAppError(new Error('x'))).toBe(false)
    expect(isAppError({ code: 'not_found' })).toBe(false)
    expect(isAppError(null)).toBe(false)
  })
})
