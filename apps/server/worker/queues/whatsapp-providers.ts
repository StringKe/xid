// WhatsApp provider:验证码一律用已审批的 authentication 模板发送,24 小时客服窗口外也能送达。
// Meta 用 WHATSAPP_TEMPLATE_NAME + WHATSAPP_TEMPLATE_LANGUAGE,验证码同时填 body 参数和 copy code 按钮参数;
// Twilio 用 TWILIO_WHATSAPP_CONTENT_SID,ContentVariables 的 "1" 是验证码。

import type { WhatsappProviderName } from '@xid-kit/types'
import { providerRejected, providerResponseFailure } from './notification-provider-error'

const TWILIO_API_BASE = 'https://api.twilio.com/2010-04-01'
const META_API_VERSION_DEFAULT = 'v25.0'
const WHATSAPP_PROVIDER_TIMEOUT_MS = 10_000

export type WhatsappSendInput = {
  to: string
  from: string
  code: string
  text: string
  tenantId?: string
}

export type WhatsappProvider = {
  readonly name: WhatsappProviderName
  send(input: WhatsappSendInput): Promise<void>
}

function required(value: string | undefined, name: string): string {
  if (value === undefined || value === '') throw new Error(`${name}_missing`)
  return value
}

function whatsappAddress(value: string): string {
  return value.startsWith('whatsapp:') ? value : `whatsapp:${value}`
}

function formBody(values: Record<string, string>): URLSearchParams {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) {
    if (value !== '') params.set(key, value)
  }
  return params
}

export class TwilioWhatsappProvider implements WhatsappProvider {
  readonly name = 'twilio'
  private readonly accountSid: string
  private readonly authToken: string
  private readonly contentSid: string
  private readonly from: string | undefined
  private readonly messagingServiceSid: string | undefined

  constructor(env: Env) {
    this.accountSid = required(env.TWILIO_ACCOUNT_SID, 'twilio_account_sid')
    this.authToken = required(env.TWILIO_AUTH_TOKEN, 'twilio_auth_token')
    this.contentSid = required(env.TWILIO_WHATSAPP_CONTENT_SID, 'twilio_whatsapp_content_sid')
    this.from = env.WHATSAPP_FROM || env.SMS_FROM
    this.messagingServiceSid = env.TWILIO_WHATSAPP_MESSAGING_SERVICE_SID
  }

  // 租户 from 优先;配置了 WhatsApp Messaging Service 且租户没有 from 时由 Sender Pool 选号。
  private sender(input: WhatsappSendInput): { From: string; MessagingServiceSid: string } {
    if (this.messagingServiceSid) {
      return {
        From: input.from ? whatsappAddress(input.from) : '',
        MessagingServiceSid: this.messagingServiceSid,
      }
    }
    const from = input.from || this.from
    if (!from) throw providerRejected('whatsapp_from_missing')
    return { From: whatsappAddress(from), MessagingServiceSid: '' }
  }

  async send(input: WhatsappSendInput): Promise<void> {
    const body = formBody({
      To: whatsappAddress(input.to),
      ContentSid: this.contentSid,
      ContentVariables: JSON.stringify({ '1': input.code }),
      ...this.sender(input),
    })
    const credentials = btoa(`${this.accountSid}:${this.authToken}`)
    const res = await fetch(
      `${TWILIO_API_BASE}/Accounts/${encodeURIComponent(this.accountSid)}/Messages.json`,
      {
        method: 'POST',
        headers: {
          authorization: `Basic ${credentials}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body,
        signal: AbortSignal.timeout(WHATSAPP_PROVIDER_TIMEOUT_MS),
      },
    )
    if (!res.ok) throw providerResponseFailure('twilio_whatsapp', res)
  }
}

export class MetaWhatsappProvider implements WhatsappProvider {
  readonly name = 'meta'
  private readonly phoneNumberId: string
  private readonly accessToken: string
  private readonly apiVersion: string
  private readonly templateName: string
  private readonly templateLanguage: string

  constructor(env: Env) {
    this.phoneNumberId = required(
      env.WHATSAPP_META_PHONE_NUMBER_ID,
      'whatsapp_meta_phone_number_id',
    )
    this.accessToken = required(env.WHATSAPP_META_ACCESS_TOKEN, 'whatsapp_meta_access_token')
    this.apiVersion = env.WHATSAPP_META_API_VERSION || META_API_VERSION_DEFAULT
    this.templateName = required(env.WHATSAPP_TEMPLATE_NAME, 'whatsapp_template_name')
    this.templateLanguage = required(env.WHATSAPP_TEMPLATE_LANGUAGE, 'whatsapp_template_language')
  }

  async send(input: WhatsappSendInput): Promise<void> {
    const res = await fetch(
      `https://graph.facebook.com/${encodeURIComponent(this.apiVersion)}/${encodeURIComponent(
        this.phoneNumberId,
      )}/messages`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: input.to,
          type: 'template',
          template: {
            name: this.templateName,
            language: { code: this.templateLanguage },
            components: [
              { type: 'body', parameters: [{ type: 'text', text: input.code }] },
              {
                type: 'button',
                sub_type: 'url',
                index: '0',
                parameters: [{ type: 'text', text: input.code }],
              },
            ],
          },
        }),
        signal: AbortSignal.timeout(WHATSAPP_PROVIDER_TIMEOUT_MS),
      },
    )
    if (!res.ok) throw providerResponseFailure('meta_whatsapp', res)
  }
}
