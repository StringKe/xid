import { renderTemplate } from './mustache'

const DEFAULT_LOCALE = 'en'
const TEMPLATE_KEY_PREFIX = 'phone-otp-templates'

const TEMPLATES: Record<string, Record<string, string>> = {
  otp: {
    en: 'Your XID verification code is {{ code }}. It expires in {{ expiresInMin }} minutes.',
    'zh-Hans': '你的 XID 验证码是 {{ code }}。{{ expiresInMin }} 分钟内有效。',
  },
}

function selectTemplate(type: string, locale: string): string | undefined {
  const byLocale = TEMPLATES[type]
  if (byLocale === undefined) return undefined
  return byLocale[locale] ?? byLocale[DEFAULT_LOCALE]
}

async function loadR2Template(
  storage: R2Bucket,
  channel: 'sms' | 'whatsapp',
  type: string,
  locale: string,
): Promise<string | undefined> {
  const keys = [
    `${TEMPLATE_KEY_PREFIX}/${channel}/${locale}/${type}.txt`,
    `${TEMPLATE_KEY_PREFIX}/${channel}/${DEFAULT_LOCALE}/${type}.txt`,
  ]
  for (const key of keys) {
    const object = await storage.get(key)
    if (object !== null) {
      const template = (await object.text()).trim()
      if (template.length > 0) return template
    }
  }
  return undefined
}

function renderData(payload: Record<string, unknown>): Record<string, unknown> {
  if (typeof payload.code !== 'string' || payload.code.trim() === '') {
    throw new Error('phone_otp_code_missing')
  }
  return {
    ...payload,
    expiresInMin: typeof payload.expiresInMin === 'number' ? payload.expiresInMin : 5,
  }
}

export async function renderPhoneOtpText(input: {
  storage: R2Bucket
  channel: 'sms' | 'whatsapp'
  type: string
  payload: Record<string, unknown>
}): Promise<string> {
  const locale = typeof input.payload.locale === 'string' ? input.payload.locale : DEFAULT_LOCALE
  const template =
    (await loadR2Template(input.storage, input.channel, input.type, locale)) ??
    selectTemplate(input.type, locale)
  if (template === undefined) throw new Error('phone_otp_template_not_found')
  const text = renderTemplate(template, renderData(input.payload)).trim()
  if (text.length === 0) throw new Error('phone_otp_text_empty')
  return text
}
