// 出站 SAML NameID:按 SAML Core 8.3 的格式语义生成值,并按 AuthnRequest 的 NameIDPolicy 选择格式。
// persistent 是 (tenant, app, user) 的成对假名:首次签发时随机生成并持久化,同一 SP 稳定,
// 不同 SP 之间不可关联,也不暴露内部 user id。

import { base64UrlEncode } from '@xid-kit/crypto'

export const NAME_ID_FORMAT = {
  emailAddress: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
  persistent: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
  transient: 'urn:oasis:names:tc:SAML:2.0:nameid-format:transient',
  unspecified: 'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified',
} as const

// 存量配置使用 SAML 2.0 命名空间下的 emailAddress / unspecified,两者按同一格式处理。
const LEGACY_FORMAT_ALIASES: Readonly<Record<string, string>> = {
  'urn:oasis:names:tc:SAML:2.0:nameid-format:emailAddress': NAME_ID_FORMAT.emailAddress,
  'urn:oasis:names:tc:SAML:2.0:nameid-format:unspecified': NAME_ID_FORMAT.unspecified,
}

export const OUTBOUND_SAML_NAME_ID_FORMATS: readonly string[] = [
  ...Object.values(NAME_ID_FORMAT),
  ...Object.keys(LEGACY_FORMAT_ALIASES),
]

type NameIdKind = keyof typeof NAME_ID_FORMAT

function kindOf(format: string): NameIdKind | null {
  const canonical = LEGACY_FORMAT_ALIASES[format] ?? format
  const entry = Object.entries(NAME_ID_FORMAT).find(([, value]) => value === canonical)
  return entry ? (entry[0] as NameIdKind) : null
}

export type NameIdFormatChoice =
  | { ok: true; format: string }
  | { ok: false; cause: 'requested_format_unsupported' | 'configured_format_unsupported' }

// NameIDPolicy 未指定或为 unspecified 时用 SP 配置的格式;指定了支持的格式时按请求签发。
export function chooseNameIdFormat(input: {
  configuredFormat: string
  requestedFormat: string | undefined
}): NameIdFormatChoice {
  const requested = input.requestedFormat
  if (requested !== undefined && kindOf(requested) !== 'unspecified') {
    if (kindOf(requested) === null) return { ok: false, cause: 'requested_format_unsupported' }
    return { ok: true, format: requested }
  }
  if (kindOf(input.configuredFormat) === null) {
    return { ok: false, cause: 'configured_format_unsupported' }
  }
  return { ok: true, format: input.configuredFormat }
}

export function randomOpaqueNameId(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)))
}

function transientNameId(): string {
  return `_${base64UrlEncode(crypto.getRandomValues(new Uint8Array(20)))}`
}

// 返回 null 表示用户没有该格式要求的值(例如 emailAddress 但没有邮箱)。
// persistent 值由调用方从持久化映射取得,只在确实签发 persistent 时才读写数据库。
export async function nameIdValue(input: {
  format: string
  email: string | null
  username: string | null
  persistentNameId: () => Promise<string>
}): Promise<string | null> {
  switch (kindOf(input.format)) {
    case 'emailAddress':
      return input.email
    case 'unspecified':
      return input.email ?? input.username
    case 'persistent':
      return input.persistentNameId()
    case 'transient':
      return transientNameId()
    case null:
      return null
  }
}
