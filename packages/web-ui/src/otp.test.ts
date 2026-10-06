import { describe, expect, it } from 'vitest'
import { otpCells, otpGroups, sanitizeOtp } from './otp'

describe('sanitizeOtp', () => {
  it('strips spaces, dashes and other separators from a pasted numeric code', () => {
    expect(sanitizeOtp(' 482-913 ', { length: 6, charset: 'numeric' })).toBe('482913')
  })

  it('drops letters from numeric codes', () => {
    expect(sanitizeOtp('48a2b9', { length: 6, charset: 'numeric' })).toBe('4829')
  })

  it('truncates to the code length', () => {
    expect(sanitizeOtp('1234567890', { length: 6, charset: 'numeric' })).toBe('123456')
  })

  it('uppercases backup codes and keeps letters', () => {
    expect(sanitizeOtp('ab3d-ef9h', { length: 8, charset: 'alphanumeric' })).toBe('AB3DEF9H')
  })

  it('returns an empty string for empty input', () => {
    expect(sanitizeOtp('', { length: 6, charset: 'numeric' })).toBe('')
  })
})

describe('otpCells', () => {
  it('pads missing characters with empty cells', () => {
    expect(otpCells('48', 4)).toEqual(['4', '8', '', ''])
  })
})

describe('otpGroups', () => {
  it('splits six and eight digit codes into two visual halves', () => {
    expect(otpGroups(6)).toEqual([3, 3])
    expect(otpGroups(8)).toEqual([4, 4])
    expect(otpGroups(5)).toEqual([5])
  })
})
