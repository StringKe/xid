// worker 统一输入校验层:外部输入边界(body/query)的形状校验集中于此,业务代码不再手写 typeof 守卫。
// 错误契约:形状失败 -> AppError('validation_failed', 422, meta.paramName = 首个 issue 的 dot path),
// 供前端把错误精确映射回表单字段(见 api-sdk-conventions rule)。
// 不用 @hono/valibot-validator:我们只需 safeParse + AppError 映射,手写适配更薄,错误契约由自己控制。

import * as v from 'valibot'
import type { Context } from 'hono'
import type { XidErrorCode } from '@xid-kit/types'
import { AppError } from './errors'
import type { XidHonoEnv } from './types'

export type ReadJsonResult = { ok: true; value: unknown } | { ok: false }

// 坏 JSON 不让 Hono 抛 SyntaxError 变 500,调用方把 ok:false 映射为 validation_failed。
export async function readJsonBody(c: Context<XidHonoEnv>): Promise<ReadJsonResult> {
  try {
    const value: unknown = await c.req.json()
    return { ok: true, value }
  } catch {
    return { ok: false }
  }
}

// flatten 的 nested 首个 key 即 dot path(如 tokenPolicy.accessTokenTtlSec);root 级失败(非对象)无 path 用 'root'。
export function firstIssuePath(
  issues: readonly [v.BaseIssue<unknown>, ...v.BaseIssue<unknown>[]],
): string {
  const flat = v.flatten(issues)
  return Object.keys(flat.nested ?? {})[0] ?? 'root'
}

export function validateBody<TSchema extends v.GenericSchema>(
  schema: TSchema,
  input: unknown,
): v.InferOutput<TSchema> {
  const result = v.safeParse(schema, input)
  if (!result.success) {
    throw new AppError('validation_failed', {
      httpStatus: 422,
      meta: { paramName: firstIssuePath(result.issues) },
    })
  }
  return result.output
}

// 凭证类端点(登录/验证码/assertion/token)专用:形状失败按字段归属分流。
// 凭证字段(identifier/password/code/assertion)抛 options.code 同款模糊码,不区分"形状错误"
// 与"凭证不存在"(枚举防护);非凭证字段按 validation_failed 422 + paramName 精确映射回表单。
export function validateCredentialBody<TSchema extends v.GenericSchema>(
  schema: TSchema,
  input: unknown,
  options: { code: XidErrorCode; credentialFields: readonly string[] },
): v.InferOutput<TSchema> {
  const parsed = v.safeParse(schema, input)
  if (parsed.success) return parsed.output
  const paramName = firstIssuePath(parsed.issues)
  if (options.credentialFields.includes(paramName.split('.')[0] ?? paramName)) {
    throw new AppError(options.code)
  }
  throw new AppError('validation_failed', { httpStatus: 422, meta: { paramName } })
}

// query 全是 string:数字字段在 schema 内 v.transform(Number) 后再做范围断言。
export function validateQuery<TSchema extends v.GenericSchema>(
  schema: TSchema,
  query: Record<string, string | undefined>,
): v.InferOutput<TSchema> {
  return validateBody(schema, query)
}

// ---- 常用原子 schema(各域直接复用,不预建大全) ----

export const emailSchema = v.pipe(v.string(), v.email())

// 用宽松 regex 而非 v.uuid():DB 层 id 校验不限制 version/variant 位。
export const uuidSchema = v.pipe(
  v.string(),
  v.regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
)

export const slugSchema = v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9-]{0,62}$/))

// redirect_uri / webhook 端点不允许明文 http。
export const httpsUrlSchema = v.pipe(v.string(), v.url(), v.startsWith('https://'))

// ---- SSRF 防护:出网 URL 统一校验(webhook 投递 / IdP metadata / social provider 端点 / logout_uri 共用)----

// 保留 IPv4 段(闭区间,网络字节序整数):0.0.0.0/8、10/8、127/8、169.254/16(云 metadata)、172.16/12、192.168/16。
const IPV4_RESERVED_RANGES: readonly (readonly [number, number])[] = [
  [0x00000000, 0x00ffffff],
  [0x0a000000, 0x0affffff],
  [0x7f000000, 0x7fffffff],
  [0xa9fe0000, 0xa9feffff],
  [0xac100000, 0xac1fffff],
  [0xc0a80000, 0xc0a8ffff],
]

function isReservedIpv4Value(value: number): boolean {
  return IPV4_RESERVED_RANGES.some(([min, max]) => value >= min && value <= max)
}

// WHATWG URL 已把 hex/octal/短形式 IPv4(0x7f000001、0177.0.0.1、127.1)归一为点分十进制,此处只认归一形式。
function parseIpv4Value(hostname: string): number | null {
  const parts = hostname.split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const octet = Number(part)
    if (octet > 255) return null
    value = value * 256 + octet
  }
  return value
}

function parseHexSegments(parts: readonly string[]): number[] | null {
  const out: number[] = []
  for (const part of parts) {
    if (!/^[0-9a-f]{1,4}$/i.test(part)) return null
    out.push(Number.parseInt(part, 16))
  }
  return out
}

// 展开 IPv6(允许一次 :: 压缩与结尾 IPv4 映射)为 8 个 16 位段;非法返回 null。
function expandIpv6Segments(input: string): number[] | null {
  let body = input
  const mappedTail: number[] = []
  const v4Match = /:((?:\d{1,3}\.){3}\d{1,3})$/.exec(body)
  if (v4Match?.[1]) {
    const octets = v4Match[1].split('.').map(Number)
    if (octets.some((octet) => octet > 255)) return null
    mappedTail.push(
      ((octets[0] ?? 0) << 8) | (octets[1] ?? 0),
      ((octets[2] ?? 0) << 8) | (octets[3] ?? 0),
    )
    body = body.slice(0, body.length - v4Match[1].length)
  }
  if (body.includes('::')) {
    const halves = body.split('::')
    if (halves.length !== 2) return null
    const head = parseHexSegments(halves[0] === '' ? [] : (halves[0] ?? '').split(':'))
    const tail = parseHexSegments(halves[1] === '' ? [] : (halves[1] ?? '').split(':'))
    if (!head || !tail) return null
    const zeros = 8 - head.length - tail.length - mappedTail.length
    if (zeros < 0) return null
    return [...head, ...new Array<number>(zeros).fill(0), ...tail, ...mappedTail]
  }
  const parts = parseHexSegments(body.split(':'))
  if (!parts) return null
  const all = [...parts, ...mappedTail]
  return all.length === 8 ? all : null
}

function isReservedIpv6(input: string): boolean {
  const segments = expandIpv6Segments(input)
  if (!segments) return false
  if (segments.every((s) => s === 0)) return true // :: unspecified
  if (segments.every((s, i) => (i === 7 ? s === 1 : s === 0))) return true // ::1 loopback
  // IPv4 映射(::ffff:a.b.c.d):按内嵌 IPv4 判定,防 [::ffff:127.0.0.1] 绕过。
  if (segments.slice(0, 5).every((s) => s === 0) && segments[5] === 0xffff) {
    return isReservedIpv4Value(((segments[6] ?? 0) << 16) | (segments[7] ?? 0))
  }
  const first = segments[0] ?? 0
  return first >= 0xfc00 && first <= 0xfdff // fc00::/7 ULA
}

// 出网 URL 必须 https + 公网:拒绝落在保留段的 IP 字面量;hostname 形式放行
// (Workers 出网不可达 RFC1918,运行时打不到内网,DNS 复检不做,防的是配置面误写与字面量绕过)。
export function isPublicHttpsUrl(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== 'https:') return false
  const hostname = url.hostname
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    return !isReservedIpv6(hostname.slice(1, -1))
  }
  const ipv4 = parseIpv4Value(hostname)
  if (ipv4 !== null) return !isReservedIpv4Value(ipv4)
  return hostname.length > 0
}

// valibot 版:形状层直接产出 validation_failed(paramName 映射回表单字段)。
export const publicHttpsUrlSchema = v.pipe(
  v.string(),
  v.url(),
  v.check(isPublicHttpsUrl, 'must be a public https URL'),
)

// ---- redirect_uris 注册校验(DCR 与 v1/applications 共用,与 authorize 精确匹配对齐,见 03 章)----

export type RedirectUriOptions = {
  applicationType: 'web' | 'native'
  grantTypes: readonly string[]
}

// loopback IP 字面量(RFC8252 7.3):native client 的 http redirect_uri 只允许 127/8 与 [::1]。
function isLoopbackHost(hostname: string): boolean {
  if (hostname === '[::1]') return true
  const ipv4 = parseIpv4Value(hostname)
  return ipv4 !== null && ipv4 >= 0x7f000000 && ipv4 <= 0x7fffffff
}

function validateSingleRedirectUri(uri: string, applicationType: 'web' | 'native'): string | null {
  if (uri.length === 0) return 'redirect_uris must not contain empty strings'
  let url: URL
  try {
    url = new URL(uri)
  } catch {
    return `redirect_uri must be an absolute URL: ${uri}`
  }
  if (url.hash !== '') return `redirect_uri must not include fragment: ${uri}`
  if (url.protocol === 'https:') return null
  if (applicationType === 'native') {
    if (url.protocol === 'http:' && isLoopbackHost(url.hostname)) return null
    // 自定义 scheme 限反域名形式(com.example.app:/cb,scheme 含 "."),
    // 防 javascript:/file: 这类单词 scheme 借 native 通道混入。
    if (
      url.protocol !== 'http:' &&
      url.protocol.includes('.') &&
      url.hostname === '' &&
      url.pathname !== ''
    ) {
      return null
    }
  }
  return `redirect_uri must use https: ${uri}`
}

// 规则:绝对 URL、https(native 允许 loopback http 与自定义 scheme)、禁 fragment、禁空串;
// authorization_code grant 必须注册至少一个 redirect_uri(否则 authorize 永远无法精确匹配)。
export function validateRedirectUris(
  uris: readonly string[],
  options: RedirectUriOptions,
): { ok: true } | { ok: false; error: string } {
  if (options.grantTypes.includes('authorization_code') && uris.length === 0) {
    return { ok: false, error: 'redirect_uris is required for authorization_code grant' }
  }
  for (const uri of uris) {
    const error = validateSingleRedirectUri(uri, options.applicationType)
    if (error) return { ok: false, error }
  }
  return { ok: true }
}

export const otpCodeSchema = v.pipe(v.string(), v.regex(/^\d{6}$/))

// TTL 秒数工厂:各资源的 accessTokenTtlSec 等字段按域给上下界。
export function ttlSecSchema(min: number, max: number): v.GenericSchema<number> {
  return v.pipe(v.number(), v.minValue(min), v.maxValue(max))
}

// cursor 分页 query:limit 字符串转数字;缺省值由调用方决定,不在此固化。
export const paginationQuerySchema = v.object({
  limit: v.optional(
    v.pipe(v.string(), v.transform(Number), v.number(), v.minValue(1), v.maxValue(100)),
  ),
  cursor: v.optional(v.string()),
})
