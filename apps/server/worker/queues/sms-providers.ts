// SMS provider:Twilio、Vonage、Infobip SMS v3、Bird Channels API(配置名沿用 messagebird)。
// 发送方:租户配置的 from 优先,其次 env.SMS_FROM;Twilio 配置 Messaging Service 时 from 可省略,
// Bird 的发送方由 channel 决定。规则与 auth/delivery-channels.ts 的就绪检查一致。

import type { SmsProviderName } from '@xid-kit/types'
import { trimTrailingSlashes } from '../../shared/url'
import {
  providerIndeterminate,
  providerRejected,
  providerResponseFailure,
} from './notification-provider-error'

const TWILIO_API_BASE = 'https://api.twilio.com/2010-04-01'
const VONAGE_API_URL = 'https://rest.nexmo.com/sms/json'
const INFOBIP_SMS_PATH = '/sms/3/messages'
const BIRD_API_BASE = 'https://api.bird.com'
const SMS_PROVIDER_TIMEOUT_MS = 10_000
// Infobip 状态组:2 UNDELIVERABLE、4 EXPIRED、5 REJECTED。
const INFOBIP_FAILED_GROUP_IDS: ReadonlySet<number> = new Set([2, 4, 5])

export type SmsSendInput = {
  to: string
  from: string
  text: string
  tenantId?: string
}

export type SmsProvider = {
  readonly name: SmsProviderName
  send(input: SmsSendInput): Promise<void>
}

function required(value: string | undefined, name: string): string {
  if (value === undefined || value === '') throw new Error(`${name}_missing`)
  return value
}

function formBody(values: Record<string, string>): URLSearchParams {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) {
    if (value !== '') params.set(key, value)
  }
  return params
}

function senderFor(input: SmsSendInput, envFrom: string | undefined): string {
  const from = input.from || envFrom
  if (!from) throw providerRejected('sms_from_missing')
  return from
}

async function readJson(res: Response, code: string): Promise<unknown> {
  try {
    return await res.json()
  } catch {
    throw providerIndeterminate(code)
  }
}

function firstMessage(body: unknown): Record<string, unknown> | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const messages = (body as { messages?: unknown }).messages
  if (!Array.isArray(messages)) return undefined
  const first: unknown = messages[0]
  return typeof first === 'object' && first !== null
    ? (first as Record<string, unknown>)
    : undefined
}

export class TwilioSmsProvider implements SmsProvider {
  readonly name = 'twilio'
  private readonly accountSid: string
  private readonly authToken: string
  private readonly from: string | undefined
  private readonly messagingServiceSid: string | undefined

  constructor(env: Env) {
    this.accountSid = required(env.TWILIO_ACCOUNT_SID, 'twilio_account_sid')
    this.authToken = required(env.TWILIO_AUTH_TOKEN, 'twilio_auth_token')
    this.from = env.SMS_FROM
    this.messagingServiceSid = env.TWILIO_MESSAGING_SERVICE_SID
  }

  // From 与 MessagingServiceSid 可同时提供:From 指定 Sender Pool 中的号码。租户没有配置 from 时
  // 由 Messaging Service 选号,不再用实例级 SMS_FROM 覆盖。
  private sender(input: SmsSendInput): { From: string; MessagingServiceSid: string } {
    if (this.messagingServiceSid) {
      return { From: input.from, MessagingServiceSid: this.messagingServiceSid }
    }
    return { From: senderFor(input, this.from), MessagingServiceSid: '' }
  }

  async send(input: SmsSendInput): Promise<void> {
    const body = formBody({ To: input.to, Body: input.text, ...this.sender(input) })
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
        signal: AbortSignal.timeout(SMS_PROVIDER_TIMEOUT_MS),
      },
    )
    if (!res.ok) throw providerResponseFailure('twilio', res)
  }
}

export class VonageSmsProvider implements SmsProvider {
  readonly name = 'vonage'
  private readonly apiKey: string
  private readonly apiSecret: string
  private readonly from: string | undefined

  constructor(env: Env) {
    this.apiKey = required(env.VONAGE_API_KEY, 'vonage_api_key')
    this.apiSecret = required(env.VONAGE_API_SECRET, 'vonage_api_secret')
    this.from = env.SMS_FROM
  }

  async send(input: SmsSendInput): Promise<void> {
    const from = senderFor(input, this.from)
    const res = await fetch(VONAGE_API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        api_key: this.apiKey,
        api_secret: this.apiSecret,
        to: input.to,
        from,
        text: input.text,
      }),
      signal: AbortSignal.timeout(SMS_PROVIDER_TIMEOUT_MS),
    })
    if (!res.ok) throw providerResponseFailure('vonage', res)
    const first = firstMessage(await readJson(res, 'vonage_response_invalid'))
    if (typeof first?.status !== 'string') throw providerIndeterminate('vonage_response_invalid')
    if (first.status !== '0') throw providerRejected(`vonage_status_${first.status}`)
  }
}

export class InfobipSmsProvider implements SmsProvider {
  readonly name = 'infobip'
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly from: string | undefined

  constructor(env: Env) {
    this.apiKey = required(env.INFOBIP_API_KEY, 'infobip_api_key')
    this.baseUrl = trimTrailingSlashes(required(env.INFOBIP_BASE_URL, 'infobip_base_url'))
    this.from = env.SMS_FROM
  }

  async send(input: SmsSendInput): Promise<void> {
    const sender = senderFor(input, this.from)
    const res = await fetch(`${this.baseUrl}${INFOBIP_SMS_PATH}`, {
      method: 'POST',
      headers: {
        authorization: `App ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        messages: [{ sender, destinations: [{ to: input.to }], content: { text: input.text } }],
      }),
      signal: AbortSignal.timeout(SMS_PROVIDER_TIMEOUT_MS),
    })
    if (!res.ok) throw providerResponseFailure('infobip', res)
    const status = firstMessage(await readJson(res, 'infobip_response_invalid'))?.status
    const groupId =
      typeof status === 'object' && status !== null
        ? (status as { groupId?: unknown }).groupId
        : undefined
    if (typeof groupId !== 'number') throw providerIndeterminate('infobip_response_invalid')
    if (INFOBIP_FAILED_GROUP_IDS.has(groupId)) throw providerRejected(`infobip_group_${groupId}`)
  }
}

export class BirdSmsProvider implements SmsProvider {
  readonly name = 'messagebird'
  private readonly accessKey: string
  private readonly workspaceId: string
  private readonly channelId: string

  constructor(env: Env) {
    this.accessKey = required(env.MESSAGEBIRD_ACCESS_KEY, 'messagebird_access_key')
    this.workspaceId = required(env.BIRD_WORKSPACE_ID, 'bird_workspace_id')
    this.channelId = required(env.BIRD_CHANNEL_ID, 'bird_channel_id')
  }

  async send(input: SmsSendInput): Promise<void> {
    const url = `${BIRD_API_BASE}/workspaces/${encodeURIComponent(
      this.workspaceId,
    )}/channels/${encodeURIComponent(this.channelId)}/messages`
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `AccessKey ${this.accessKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        receiver: { contacts: [{ identifierValue: input.to }] },
        body: { type: 'text', text: { text: input.text } },
      }),
      signal: AbortSignal.timeout(SMS_PROVIDER_TIMEOUT_MS),
    })
    if (!res.ok) throw providerResponseFailure('messagebird', res)
  }
}
