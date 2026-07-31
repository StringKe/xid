// Email Queue Consumer:渲染 Mustache 子集模板 + 调 Cloudflare Email Service 发信。
// 见 docs/design/07-platform-operations.md 第 3 节、3.1。
// - 首版仅启用 CloudflareEmailProvider(env.EMAIL.send),Resend/SendGrid/SMTP 不保留可配置路径。
// - 事务模板优先从 R2 邮件语言包读取,缺失时回退内置模板。
// - 失败指数退避重试最多 5 次,超限死信入 D1 notification_failures。
//   退避用 message.retry({ delaySeconds });Queue 在 max_retries 后自动投 DLQ,
//   此处达上限主动落 D1 失败表保证可观测(见 cloudflare-bindings rule 通知节)。

import type { EmailQueueMessage } from '@xid-kit/types'
import * as v from 'valibot'
import { renderTemplate } from './mustache'
import { executeNotificationDelivery, DELIVERY_RETRY_SECONDS } from './notification-delivery-state'
import { recordNotificationSent } from './notification-audit'
import { buildNotificationFailureRecord } from './notification-safety'

// 指数退避基数(秒):attempt 1 -> 4s,2 -> 8s,3 -> 16s,4 -> 32s
const BACKOFF_BASE_SECONDS = 2
const BACKOFF_START_EXP = 2

export type EmailAddress = {
  email: string
  name: string
}

export type EmailSendInput = {
  to: string
  from: EmailAddress
  subject: string
  html: string
  text: string
}

// Provider 抽象:Consumer 不感知具体实现(见 07 章 3.1)。
export type EmailProvider = {
  readonly name: string
  send(input: EmailSendInput): Promise<void>
}

// 默认 Provider:Cloudflare Email Service(send_email binding)。
// env.EMAIL.send 接受 MIME 消息或结构化字段;此处用结构化字段封装。
export class CloudflareEmailProvider implements EmailProvider {
  readonly name = 'cloudflare'
  private readonly binding: SendEmail

  constructor(binding: SendEmail) {
    this.binding = binding
  }

  async send(input: EmailSendInput): Promise<void> {
    // Cloudflare Email Service Workers binding 支持结构化 send。
    await this.binding.send({
      to: input.to,
      from: input.from,
      subject: input.subject,
      html: input.html,
      text: input.text,
    })
  }
}

// 事务邮件模板(Mustache 子集)。按 type + locale 选模板。
// 真实部署模板由 R2 语言包提供(见 07 章 4);此处内置 en/zh-Hans 兜底,保证无外部依赖可渲染。
type EmailTemplate = {
  subject: string
  html: string
  text: string
}

type LocaleTemplates = Record<string, EmailTemplate>

type EmailHtmlInput = {
  lang: string
  preheader: string
  eyebrow: string
  title: string
  leadHtml: string
  bodyHtml: string
  ctaLabel?: string
  ctaUrl?: string
  codeHtml?: string
  fallbackLinkText: string
  footerText: string
}

function buildEmailHtml(input: EmailHtmlInput): string {
  const cta =
    input.ctaLabel !== undefined && input.ctaUrl !== undefined
      ? `<table role="presentation" border="0" cellspacing="0" cellpadding="0" style="margin:28px 0 18px 0;"><tr><td bgcolor="#111827" style="border-radius:6px;"><a href="${input.ctaUrl}" style="display:inline-block;padding:13px 22px;font-size:15px;line-height:20px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:6px;">${input.ctaLabel}</a></td></tr></table><p style="margin:0 0 18px 0;font-size:13px;line-height:20px;color:#64748b;">${input.fallbackLinkText}<br><a href="${input.ctaUrl}" style="color:#1d4ed8;word-break:break-all;text-decoration:underline;">${input.ctaUrl}</a></p>`
      : ''
  const code =
    input.codeHtml !== undefined
      ? `<div style="margin:24px 0 20px 0;padding:18px 20px;border:1px solid #d7dde8;border-radius:8px;background:#f8fafc;text-align:center;font-size:30px;line-height:38px;font-weight:700;letter-spacing:6px;color:#111827;">${input.codeHtml}</div>`
      : ''
  return `<!doctype html>
<html lang="${input.lang}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${input.title}</title>
  </head>
  <body style="margin:0;padding:0;background:#f4f7fb;font-family:Arial,Helvetica,sans-serif;color:#111827;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${input.preheader}</div>
    <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="background:#f4f7fb;margin:0;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="max-width:560px;background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">
            <tr>
              <td style="padding:24px 32px 18px 32px;border-bottom:1px solid #e2e8f0;background:#ffffff;">
                <div style="font-size:20px;line-height:26px;font-weight:700;color:#111827;">XID</div>
                <div style="font-size:12px;line-height:18px;color:#64748b;">Identity platform</div>
              </td>
            </tr>
            <tr>
              <td style="padding:30px 32px 10px 32px;">
                <div style="margin:0 0 10px 0;font-size:12px;line-height:18px;font-weight:700;letter-spacing:0;color:#2563eb;text-transform:uppercase;">${input.eyebrow}</div>
                <h1 style="margin:0 0 14px 0;font-size:24px;line-height:31px;font-weight:700;color:#111827;">${input.title}</h1>
                <p style="margin:0 0 18px 0;font-size:16px;line-height:25px;color:#334155;">${input.leadHtml}</p>
                ${input.bodyHtml}
                ${code}
                ${cta}
              </td>
            </tr>
            <tr>
              <td style="padding:20px 32px 28px 32px;">
                <p style="margin:0;font-size:12px;line-height:19px;color:#64748b;">${input.footerText}</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`
}

function linkExpiryHtml(label: 'link' | 'code', locale: string): string {
  if (locale === 'zh-Hans') {
    const noun = label === 'link' ? '此链接' : '此验证码'
    return `{{# expiresInMin }}<p style="margin:0 0 18px 0;font-size:14px;line-height:22px;color:#475569;">${noun} {{ expiresInMin }} 分钟内有效。</p>{{/ expiresInMin }}{{^ expiresInMin }}{{# expires }}<p style="margin:0 0 18px 0;font-size:14px;line-height:22px;color:#475569;">${noun} {{ expires }} 分钟内有效。</p>{{/ expires }}{{/ expiresInMin }}`
  }
  const noun = label === 'link' ? 'This link' : 'This code'
  return `{{# expiresInMin }}<p style="margin:0 0 18px 0;font-size:14px;line-height:22px;color:#475569;">${noun} expires in {{ expiresInMin }} minutes.</p>{{/ expiresInMin }}{{^ expiresInMin }}{{# expires }}<p style="margin:0 0 18px 0;font-size:14px;line-height:22px;color:#475569;">${noun} expires in {{ expires }} minutes.</p>{{/ expires }}{{/ expiresInMin }}`
}

function linkExpiryText(label: 'link' | 'code', locale: string): string {
  if (locale === 'zh-Hans') {
    const noun = label === 'link' ? '此链接' : '此验证码'
    return `{{# expiresInMin }}${noun} {{ expiresInMin }} 分钟内有效。{{/ expiresInMin }}{{^ expiresInMin }}{{# expires }}${noun} {{ expires }} 分钟内有效。{{/ expires }}{{/ expiresInMin }}`
  }
  const noun = label === 'link' ? 'This link' : 'This code'
  return `{{# expiresInMin }}${noun} expires in {{ expiresInMin }} minutes.{{/ expiresInMin }}{{^ expiresInMin }}{{# expires }}${noun} expires in {{ expires }} minutes.{{/ expires }}{{/ expiresInMin }}`
}

const TEMPLATES: Record<string, LocaleTemplates> = {
  verify_email: {
    en: {
      subject: 'Verify your email',
      html: buildEmailHtml({
        lang: 'en',
        preheader: 'Confirm your email address for XID.',
        eyebrow: 'Email verification',
        title: 'Confirm your email address',
        leadHtml:
          '{{# name }}Hi {{ name }},{{/ name }}{{^ name }}Hi,{{/ name }} use the button below to confirm this email address for your XID account.',
        bodyHtml: linkExpiryHtml('link', 'en'),
        ctaLabel: 'Verify email',
        ctaUrl: '{{ link }}',
        fallbackLinkText: 'Button not working? Paste this link into your browser:',
        footerText: 'If you did not request this, you can ignore this email.',
      }),
      text: `Hi{{# name }} {{ name }}{{/ name }},

Confirm this email address for your XID account:
{{ link }}

${linkExpiryText('link', 'en')}

If you did not request this, you can ignore this email.

XID`,
    },
    'zh-Hans': {
      subject: '验证你的邮箱',
      html: buildEmailHtml({
        lang: 'zh-Hans',
        preheader: '确认你的 XID 邮箱地址。',
        eyebrow: '邮箱验证',
        title: '确认你的邮箱地址',
        leadHtml:
          '{{# name }}{{ name }} 你好，{{/ name }}{{^ name }}你好，{{/ name }}请使用下面的按钮确认这个 XID 账号的邮箱地址。',
        bodyHtml: linkExpiryHtml('link', 'zh-Hans'),
        ctaLabel: '验证邮箱',
        ctaUrl: '{{ link }}',
        fallbackLinkText: '按钮无法打开时，请复制此链接到浏览器：',
        footerText: '如果这不是你的操作，可以忽略这封邮件。',
      }),
      text: `{{# name }}{{ name }} 你好，{{/ name }}{{^ name }}你好，{{/ name }}

请确认这个 XID 账号的邮箱地址：
{{ link }}

${linkExpiryText('link', 'zh-Hans')}

如果这不是你的操作，可以忽略这封邮件。

XID`,
    },
  },
  magic_link: {
    en: {
      subject: 'Your sign-in link',
      html: buildEmailHtml({
        lang: 'en',
        preheader: 'Use this secure link to sign in to XID.',
        eyebrow: 'Secure sign-in',
        title: 'Sign in to XID',
        leadHtml: 'Use this secure link to continue signing in. The link works once.',
        bodyHtml: linkExpiryHtml('link', 'en'),
        ctaLabel: 'Sign in',
        ctaUrl: '{{ link }}',
        fallbackLinkText: 'Button not working? Paste this link into your browser:',
        footerText: 'If you did not request this, you can ignore this email.',
      }),
      text: `Sign in to XID:
{{ link }}

${linkExpiryText('link', 'en')}

This link works once. If you did not request this, you can ignore this email.

XID`,
    },
    'zh-Hans': {
      subject: '登录链接',
      html: buildEmailHtml({
        lang: 'zh-Hans',
        preheader: '使用此安全链接登录 XID。',
        eyebrow: '安全登录',
        title: '登录 XID',
        leadHtml: '使用此安全链接继续登录。此链接只能使用一次。',
        bodyHtml: linkExpiryHtml('link', 'zh-Hans'),
        ctaLabel: '登录',
        ctaUrl: '{{ link }}',
        fallbackLinkText: '按钮无法打开时，请复制此链接到浏览器：',
        footerText: '如果这不是你的操作，可以忽略这封邮件。',
      }),
      text: `登录 XID：
{{ link }}

${linkExpiryText('link', 'zh-Hans')}

此链接只能使用一次。如果这不是你的操作，可以忽略这封邮件。

XID`,
    },
  },
  otp: {
    en: {
      subject: 'Your verification code',
      html: buildEmailHtml({
        lang: 'en',
        preheader: 'Your XID verification code is {{ code }}.',
        eyebrow: 'Verification code',
        title: 'Your verification code',
        leadHtml: 'Enter this code in the XID sign-in window.',
        bodyHtml: `${linkExpiryHtml('code', 'en')}<p style="margin:0 0 18px 0;font-size:14px;line-height:22px;color:#475569;">Do not share this code. XID will never ask for it outside the sign-in flow.</p>`,
        codeHtml: '{{ code }}',
        fallbackLinkText: 'Button not working? Paste this link into your browser:',
        footerText: 'If you did not request this, you can ignore this email.',
      }),
      text: `Your XID verification code is {{ code }}.

${linkExpiryText('code', 'en')}

Do not share this code. XID will never ask for it outside the sign-in flow.

XID`,
    },
    'zh-Hans': {
      subject: '验证码',
      html: buildEmailHtml({
        lang: 'zh-Hans',
        preheader: '你的 XID 验证码是 {{ code }}。',
        eyebrow: '验证码',
        title: '你的验证码',
        leadHtml: '在 XID 登录窗口输入此验证码。',
        bodyHtml: `${linkExpiryHtml('code', 'zh-Hans')}<p style="margin:0 0 18px 0;font-size:14px;line-height:22px;color:#475569;">不要分享此验证码。XID 不会在登录流程外向你索要验证码。</p>`,
        codeHtml: '{{ code }}',
        fallbackLinkText: '按钮无法打开时，请复制此链接到浏览器：',
        footerText: '如果这不是你的操作，可以忽略这封邮件。',
      }),
      text: `你的 XID 验证码是 {{ code }}。

${linkExpiryText('code', 'zh-Hans')}

不要分享此验证码。XID 不会在登录流程外向你索要验证码。

XID`,
    },
  },
  password_reset: {
    en: {
      subject: 'Reset your password',
      html: buildEmailHtml({
        lang: 'en',
        preheader: 'Use this secure link to reset your XID password.',
        eyebrow: 'Password reset',
        title: 'Reset your password',
        leadHtml: 'Use this secure link to choose a new password for your XID account.',
        bodyHtml: linkExpiryHtml('link', 'en'),
        ctaLabel: 'Reset password',
        ctaUrl: '{{ link }}',
        fallbackLinkText: 'Button not working? Paste this link into your browser:',
        footerText: 'If you did not request this, you can ignore this email.',
      }),
      text: `Reset your XID password:
{{ link }}

${linkExpiryText('link', 'en')}

If you did not request this, you can ignore this email.

XID`,
    },
    'zh-Hans': {
      subject: '重置密码',
      html: buildEmailHtml({
        lang: 'zh-Hans',
        preheader: '使用此安全链接重置你的 XID 密码。',
        eyebrow: '密码重置',
        title: '重置你的密码',
        leadHtml: '使用此安全链接为你的 XID 账号设置新密码。',
        bodyHtml: linkExpiryHtml('link', 'zh-Hans'),
        ctaLabel: '重置密码',
        ctaUrl: '{{ link }}',
        fallbackLinkText: '按钮无法打开时，请复制此链接到浏览器：',
        footerText: '如果这不是你的操作，可以忽略这封邮件。',
      }),
      text: `重置你的 XID 密码：
{{ link }}

${linkExpiryText('link', 'zh-Hans')}

如果这不是你的操作，可以忽略这封邮件。

XID`,
    },
  },
  organization_invitation: {
    en: {
      subject: 'You are invited to join {{ orgName }} on XID',
      html: buildEmailHtml({
        lang: 'en',
        preheader: 'Accept your invitation to join {{ orgName }} on XID.',
        eyebrow: 'Organization invitation',
        title: 'Join {{ orgName }}',
        leadHtml:
          'You have been invited to join <strong>{{ orgName }}</strong> on XID as <strong>{{ role }}</strong>.',
        bodyHtml:
          '<p style="margin:0 0 18px 0;font-size:14px;line-height:22px;color:#475569;">This invitation expires in {{ expiresInDays }} days.</p>',
        ctaLabel: 'Accept invitation',
        ctaUrl: '{{ link }}',
        fallbackLinkText: 'Button not working? Paste this link into your browser:',
        footerText: 'If you were not expecting this invitation, you can ignore this email.',
      }),
      text: `You have been invited to join {{ orgName }} on XID as {{ role }}.

Accept your invitation:
{{ link }}

This invitation expires in {{ expiresInDays }} days.

If you were not expecting this invitation, you can ignore this email.

XID`,
    },
    'zh-Hans': {
      subject: '邀请你加入 XID 组织 {{ orgName }}',
      html: buildEmailHtml({
        lang: 'zh-Hans',
        preheader: '接受邀请，加入 XID 组织 {{ orgName }}。',
        eyebrow: '组织邀请',
        title: '加入 {{ orgName }}',
        leadHtml:
          '你已被邀请以 <strong>{{ role }}</strong> 身份加入 XID 组织 <strong>{{ orgName }}</strong>。',
        bodyHtml:
          '<p style="margin:0 0 18px 0;font-size:14px;line-height:22px;color:#475569;">此邀请将在 {{ expiresInDays }} 天后过期。</p>',
        ctaLabel: '接受邀请',
        ctaUrl: '{{ link }}',
        fallbackLinkText: '按钮无法打开时，请复制此链接到浏览器：',
        footerText: '如果这不是你的操作，可以忽略这封邮件。',
      }),
      text: `你已被邀请以 {{ role }} 身份加入 XID 组织 {{ orgName }}。

接受邀请：
{{ link }}

此邀请将在 {{ expiresInDays }} 天后过期。

如果这不是你的操作，可以忽略这封邮件。

XID`,
    },
  },
}

const DEFAULT_LOCALE = 'en'
const DEFAULT_FROM: EmailAddress = { email: 'no-reply@xid.dev', name: 'XID' }
const TEMPLATE_KEY_PREFIX = 'email-templates'
const emailFromAddressSchema = v.pipe(v.string(), v.trim(), v.maxLength(254), v.email())
const emailFromNameSchema = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1),
  v.maxLength(100),
  v.regex(/^[^\r\n]+$/u),
)

function resolveConfiguredFrom(env: Env): EmailAddress {
  const address = v.safeParse(emailFromAddressSchema, env.EMAIL_FROM_ADDRESS ?? DEFAULT_FROM.email)
  if (!address.success) {
    throw new TypeError('EMAIL_FROM_ADDRESS must be a valid email address')
  }

  const name = v.safeParse(emailFromNameSchema, env.EMAIL_FROM_NAME ?? DEFAULT_FROM.name)
  if (!name.success) {
    throw new TypeError('EMAIL_FROM_NAME must be 1-100 characters without line breaks')
  }

  return { email: address.output, name: name.output }
}

function selectTemplate(type: string, locale: string): EmailTemplate | undefined {
  const byLocale = TEMPLATES[type]
  if (byLocale === undefined) {
    return undefined
  }
  return byLocale[locale] ?? byLocale[DEFAULT_LOCALE]
}

type StoredTemplate = Partial<EmailTemplate>

function parseStoredTemplate(raw: string): EmailTemplate | undefined {
  try {
    const value = JSON.parse(raw) as StoredTemplate
    if (
      typeof value.subject === 'string' &&
      typeof value.html === 'string' &&
      typeof value.text === 'string'
    ) {
      return { subject: value.subject, html: value.html, text: value.text }
    }
  } catch {
    return undefined
  }
  return undefined
}

async function loadR2Template(
  storage: R2Bucket,
  type: string,
  locale: string,
): Promise<EmailTemplate | undefined> {
  const keys = [
    `${TEMPLATE_KEY_PREFIX}/${locale}/${type}.json`,
    `${TEMPLATE_KEY_PREFIX}/${DEFAULT_LOCALE}/${type}.json`,
  ]
  for (const key of keys) {
    const object = await storage.get(key)
    if (object === null) continue
    const template = parseStoredTemplate(await object.text())
    if (template !== undefined) return template
  }
  return undefined
}

function renderTemplateInput(
  message: EmailQueueMessage,
  template: EmailTemplate,
  defaultFrom: EmailAddress,
): EmailSendInput {
  const payload = message.payload
  const from =
    typeof payload.from === 'object' && payload.from !== null
      ? (payload.from as EmailAddress)
      : defaultFrom
  return {
    to: message.recipient,
    from,
    subject: renderTemplate(template.subject, payload),
    html: renderTemplate(template.html, payload),
    text: renderTemplate(template.text, payload),
  }
}

export function renderEmail(message: EmailQueueMessage): EmailSendInput | undefined {
  const payload = message.payload
  const locale = typeof payload.locale === 'string' ? payload.locale : DEFAULT_LOCALE
  const template = selectTemplate(message.type, locale)
  if (template === undefined) {
    return undefined
  }
  return renderTemplateInput(message, template, DEFAULT_FROM)
}

export async function renderEmailWithTemplates(
  env: Env,
  message: EmailQueueMessage,
): Promise<EmailSendInput | undefined> {
  const payload = message.payload
  const locale = typeof payload.locale === 'string' ? payload.locale : DEFAULT_LOCALE
  const template =
    (await loadR2Template(env.STORAGE, message.type, locale)) ??
    selectTemplate(message.type, locale)
  if (template === undefined) {
    return undefined
  }
  return renderTemplateInput(message, template, resolveConfiguredFrom(env))
}

function backoffSeconds(attempt: number): number {
  return BACKOFF_BASE_SECONDS ** (BACKOFF_START_EXP + attempt)
}

async function recordFailure(
  env: Env,
  message: Message<EmailQueueMessage>,
  reason: string,
  attempts: number,
): Promise<void> {
  const body = message.body
  const failure = await buildNotificationFailureRecord({
    channel: 'email',
    type: body.type,
    recipient: body.recipient,
    payload: body.payload,
  })
  // 死信落 D1 notification_failures(见 cloudflare-bindings rule 通知节)。
  // 表 schema 由 @xid-kit/db 维护;此处经平台级写路径直插(非租户业务查询)。
  await env.DB.prepare(
    `INSERT OR IGNORE INTO notification_failures (id, source_message_id, tenant_id, channel, recipient, type, payload, reason, attempts, failed_at)
     VALUES (?, ?, ?, 'email', ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      message.id,
      failure.tenantId,
      failure.recipient,
      body.type,
      JSON.stringify(failure.payload),
      reason,
      attempts,
      new Date().toISOString(),
    )
    .run()
}

function resolveProvider(env: Env): EmailProvider {
  // 单一默认 provider:Cloudflare Email Service。
  return new CloudflareEmailProvider(env.EMAIL)
}

// 仅在死信持久化成功后确认消息,避免 D1 短暂故障丢失永久失败记录。
async function recordFailureOrRetry(
  env: Env,
  message: Message<EmailQueueMessage>,
  reason: string,
  attempt: number,
): Promise<void> {
  try {
    await recordFailure(env, message, reason, attempt)
    message.ack()
  } catch {
    message.retry({ delaySeconds: backoffSeconds(attempt) })
  }
}

// 单条消息处理:模板缺失或达上限 -> 落死信并 ack;可重试 provider 错误 -> 指数退避 retry。
async function processEmailMessage(
  message: Message<EmailQueueMessage>,
  env: Env,
  provider: EmailProvider,
): Promise<void> {
  // attempt 语义:Queue 从 1 开始递增,首次投递 attempt=1。
  const attempt = message.attempts
  const input = await renderEmailWithTemplates(env, message.body)
  if (input === undefined) {
    // 模板缺失是永久业务失败,但死信持久化故障仍需 retry。
    await recordFailureOrRetry(env, message, 'template_not_found', attempt)
    return
  }
  const delivery = {
    // Producer-side outbox retries carry a stable logical id. Legacy messages fall back to the
    // Cloudflare Queue id, so existing deliveries keep their original idempotency identity.
    messageId: message.body.deliveryId ?? message.id,
    tenantId:
      typeof message.body.payload.tenantId === 'string' ? message.body.payload.tenantId : undefined,
    channel: 'email' as const,
    type: message.body.type,
    provider: provider.name,
    recipient: message.body.recipient,
    payload: message.body.payload,
  }
  try {
    const result = await executeNotificationDelivery(env, delivery, {
      send: () => provider.send(input),
      recordAudit: () => recordNotificationSent(env, delivery),
    })
    if (result === 'ack') {
      message.ack()
    } else {
      message.retry({ delaySeconds: DELIVERY_RETRY_SECONDS })
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'notification_delivery_state_failed'
    if (reason === 'notification_tenant_missing' || reason === 'notification_message_id_missing') {
      await recordFailureOrRetry(env, message, reason, attempt)
      return
    }
    message.retry({ delaySeconds: DELIVERY_RETRY_SECONDS })
  }
}

export async function handleEmailBatch(
  batch: MessageBatch<EmailQueueMessage>,
  env: Env,
): Promise<void> {
  const provider = resolveProvider(env)
  for (const message of batch.messages) {
    await processEmailMessage(message, env, provider)
  }
}
