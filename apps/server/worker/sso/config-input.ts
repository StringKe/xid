// SSO 连接与出站 SAML 应用写入路径共用的输入规则:模板占位符拒绝、内部映射键只由服务端维护。

import { AppError } from '../lib/errors'

// 预设里的 `{tenantId}` 这类模板片段原样保存会成为错误的 Audience 或出网地址。
const TEMPLATE_PLACEHOLDER = /[{}]/

function invalid(paramName: string): AppError {
  return new AppError('validation_failed', { httpStatus: 422, meta: { paramName } })
}

export function assertNoTemplatePlaceholders(
  fields: Readonly<Record<string, string | null | undefined>>,
): void {
  for (const [paramName, value] of Object.entries(fields)) {
    if (typeof value === 'string' && TEMPLATE_PLACEHOLDER.test(value)) throw invalid(paramName)
  }
}

// attribute_mapping 中 `_` 前缀键由服务端写入(预设标记、分配门槛、信封密文);
// 客户端只能提交 allowed 里列出的配置容器(入站 legacy 协议的 `_legacy`)。
export function assertClientMappingKeys(
  mapping: Readonly<Record<string, unknown>> | undefined,
  allowed: readonly string[],
): void {
  if (!mapping) return
  for (const key of Object.keys(mapping)) {
    if (key.startsWith('_') && !allowed.includes(key)) throw invalid(`attribute_mapping.${key}`)
  }
}

const RELAY_STATE_URL_MAX = 2048

// IdP 发起登录的默认落地页只允许本实例 issuer 同源;相对路径按 issuer 解析后存为绝对地址。
export function normalizeRelayStateUrl(issuer: string, value: string | null): string | null {
  if (value === null || value.trim() === '') return null
  const origin = new URL(issuer).origin
  let target: URL
  try {
    target = new URL(value.trim(), origin)
  } catch {
    throw invalid('relay_state_url')
  }
  if (value.length > RELAY_STATE_URL_MAX || target.origin !== origin) {
    throw invalid('relay_state_url')
  }
  return `${target.origin}${target.pathname}${target.search}${target.hash}`
}

export function internalMappingKeys(mapping: Readonly<Record<string, unknown>>): {
  [key: string]: unknown
} {
  return Object.fromEntries(Object.entries(mapping).filter(([key]) => key.startsWith('_')))
}

export function visibleMappingKeys(mapping: Readonly<Record<string, unknown>>): {
  [key: string]: unknown
} {
  return Object.fromEntries(Object.entries(mapping).filter(([key]) => !key.startsWith('_')))
}
