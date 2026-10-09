// passwordless 登录入口:magic-link/send 在此实现,OTP 发送与验证见 passwordless-otp*.ts。
// 复用 auth/magic-link.ts sendMagicLink(单一真相源,不重复实现 token 逻辑)。契约差异:前端传 turnstileToken。
// 枚举防护(铁律):send 统一 200 不区分存在性。

import type { Context } from 'hono'
import * as v from 'valibot'
import { AppError } from '../lib/errors'
import type { XidHonoEnv } from '../lib/types'
import { readJsonBody, validateCredentialBody } from '../lib/validate'
import {
  handleMagicLinkVerify,
  handleMagicLinkVerifyRedirect,
  sendMagicLink,
} from '../auth/magic-link'
import { requestIp, verifyTurnstile } from './shared'
import { resolveEntryTenant, withTenant } from './instance-login'
import { nullableString, startInvitationClaimOpaque } from './passwordless-otp-shared'

export { handleOtpEmailSend, handleOtpSmsSend, handleOtpWhatsappSend } from './passwordless-otp'
export {
  handleOtpEmailVerify,
  handleOtpSmsVerify,
  handleOtpWhatsappVerify,
} from './passwordless-otp-verify'

// email/phone 同时是标识字段与 profile 字段,schema 里只声明一次。
const magicLinkBodySchema = v.object({
  email: v.optional(v.string()),
  username: nullableString,
  phone: nullableString,
  name: nullableString,
  givenName: nullableString,
  familyName: nullableString,
  organizationId: nullableString,
  clientId: nullableString,
  invitationToken: nullableString,
  intent: nullableString,
  continue: nullableString,
  turnstileToken: nullableString,
})

// POST /auth/magic-link/send -- 先过 turnstile 校验再复用 sendMagicLink(枚举防护 200)。
export async function handleMagicLinkSend(c: Context<XidHonoEnv>): Promise<Response> {
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('invalid_request')
  const body = validateCredentialBody(magicLinkBodySchema, json.value, {
    code: 'invalid_request',
    credentialFields: ['email'],
  })
  const email = (body.email ?? '').trim().toLowerCase()
  if (!email) throw new AppError('invalid_request')
  await verifyTurnstile(body.turnstileToken, c.env, requestIp(c))
  if (body.invitationToken?.trim()) {
    await startInvitationClaimOpaque(c, body.invitationToken)
    return c.json({ ok: true })
  }
  const tenant = await resolveEntryTenant(c, { kind: 'email', value: email }, body.organizationId, {
    intent: body.intent,
    applicationClientId: body.clientId,
  })
  await withTenant(c, tenant, () =>
    sendMagicLink(c, email, {
      profileInput: body,
      continuePath: body.continue,
      intent: body.intent,
      applicationClientId: body.clientId,
    }),
  )
  return c.json({ ok: true })
}

export { handleMagicLinkVerify, handleMagicLinkVerifyRedirect }
