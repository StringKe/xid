// Test OTP capture for local SMS/WhatsApp L3 smoke. Stores last OTP per tenant/recipient in KV.

import { Hono } from 'hono'
import type { Context } from 'hono'
import { AppError } from '../lib/errors'
import type { XidHonoEnv } from '../lib/types'
import { isDevOrTestEnvironment } from './dev-gate'

const OTP_KV_PREFIX = 'test-otp:'
const OTP_TTL_SEC = 600

export type CapturedOtp = {
  tenantId: string
  channel: 'sms' | 'whatsapp'
  provider: string
  recipient: string
  code: string
  sentAt: number
}

function otpKey(tenantId: string, recipient: string): string {
  return `${OTP_KV_PREFIX}${tenantId}:${recipient}`
}

export async function captureTestOtp(env: Env, input: Omit<CapturedOtp, 'sentAt'>): Promise<void> {
  if (!isDevOrTestEnvironment(env)) return
  const record: CapturedOtp = { ...input, sentAt: Date.now() }
  await env.CACHE.put(otpKey(input.tenantId, input.recipient), JSON.stringify(record), {
    expirationTtl: OTP_TTL_SEC,
  })
}

export async function readLatestTestOtp(
  env: Env,
  tenantId: string,
  recipient: string,
): Promise<CapturedOtp | null> {
  if (!isDevOrTestEnvironment(env)) return null
  const raw = await env.CACHE.get(otpKey(tenantId, recipient))
  if (!raw) return null
  return JSON.parse(raw) as CapturedOtp
}

function requireHarness(c: Context<XidHonoEnv>): void {
  if (!isDevOrTestEnvironment(c.env)) {
    throw new AppError('not_found', { httpStatus: 404 })
  }
}

const testOtp = new Hono<XidHonoEnv>()

testOtp.get('/latest', async (c) => {
  requireHarness(c)
  const tenantId = c.get('tenant').tenantId
  const recipient = c.req.query('recipient')?.trim() ?? ''
  if (!recipient) {
    throw new AppError('invalid_request', { meta: { paramName: 'recipient' } })
  }
  const record = await readLatestTestOtp(c.env, tenantId, recipient)
  if (!record) throw new AppError('not_found', { httpStatus: 404 })
  return c.json(record)
})

export function registerTestOtpRoutes(app: Hono<XidHonoEnv>): void {
  app.route('/test/otp', testOtp)
}

export class TestSmsProvider {
  readonly name = 'test' as const

  constructor(private readonly env: Env) {}

  async send(input: { to: string; text: string; tenantId?: string }): Promise<void> {
    const match = /\b(\d{4,8})\b/.exec(input.text)
    const code = match?.[1]
    if (!code || !input.tenantId) return
    await captureTestOtp(this.env, {
      tenantId: input.tenantId,
      channel: 'sms',
      provider: 'test',
      recipient: input.to,
      code,
    })
  }
}

export class TestWhatsappProvider {
  readonly name = 'test' as const

  constructor(private readonly env: Env) {}

  async send(input: { to: string; text: string; tenantId?: string }): Promise<void> {
    const match = /\b(\d{4,8})\b/.exec(input.text)
    const code = match?.[1]
    if (!code || !input.tenantId) return
    await captureTestOtp(this.env, {
      tenantId: input.tenantId,
      channel: 'whatsapp',
      provider: 'test',
      recipient: input.to,
      code,
    })
  }
}
