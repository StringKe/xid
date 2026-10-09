// Social OAuth 回调参数:多数 provider 用 GET query,Apple 用 form_post(POST body)。

import type { Context } from 'hono'
import * as v from 'valibot'
import type { XidHonoEnv } from '../lib/types'
import { validateQuery } from '../lib/validate'
import type { ProviderProfile } from './social-providers'

const callbackParamsSchema = v.object({
  code: v.optional(v.string()),
  state: v.optional(v.string()),
  error: v.optional(v.string()),
})

const APPLE_USER_MAX_LENGTH = 4096
const APPLE_NAME_PART_MAX_LENGTH = 128

const appleNamePartSchema = v.optional(
  v.pipe(v.string(), v.trim(), v.maxLength(APPLE_NAME_PART_MAX_LENGTH)),
)

// Apple 只在首次授权时通过 form_post 的 user 字段回传姓名(id_token 不含 name)。
const appleUserSchema = v.pipe(
  v.string(),
  v.maxLength(APPLE_USER_MAX_LENGTH),
  v.parseJson(),
  v.looseObject({
    name: v.optional(
      v.looseObject({ firstName: appleNamePartSchema, lastName: appleNamePartSchema }),
    ),
  }),
)

export type AppleUserName = { firstName: string | null; lastName: string | null }

export type CallbackParams = {
  code: string | null
  state: string | null
  error: string | null
  appleUserName: AppleUserName | null
}

function toCallbackParams(
  input: Record<string, string | undefined>,
  appleUserName: AppleUserName | null,
): CallbackParams {
  const params = validateQuery(callbackParamsSchema, input)
  return {
    code: params.code ?? null,
    state: params.state ?? null,
    error: params.error ?? null,
    appleUserName,
  }
}

// 只用于新建账号时的显示姓名,不参与身份判定;格式不对时当作没有。
export function parseAppleUserName(raw: string | null): AppleUserName | null {
  if (!raw) return null
  const parsed = v.safeParse(appleUserSchema, raw)
  if (!parsed.success || !parsed.output.name) return null
  const firstName = parsed.output.name.firstName || null
  const lastName = parsed.output.name.lastName || null
  return firstName || lastName ? { firstName, lastName } : null
}

// id_token 自带的姓名优先;Apple user 字段只补缺。
export function withAppleUserName(
  profile: ProviderProfile,
  appleUserName: AppleUserName | null,
): ProviderProfile {
  if (!appleUserName || profile.givenName || profile.familyName || profile.name) return profile
  const { firstName, lastName } = appleUserName
  return {
    ...profile,
    givenName: firstName,
    familyName: lastName,
    name: [firstName, lastName].filter(Boolean).join(' '),
  }
}

// FormData 值可能是 File(非字符串),形状守卫时视为缺失。
export async function readCallbackParams(c: Context<XidHonoEnv>): Promise<CallbackParams> {
  if (c.req.method === 'POST') {
    const form = await c.req.formData()
    const raw: Record<string, string | undefined> = {}
    for (const key of ['code', 'state', 'error'] as const) {
      const value = form.get(key)
      if (typeof value === 'string') raw[key] = value
    }
    const user = form.get('user')
    return toCallbackParams(raw, parseAppleUserName(typeof user === 'string' ? user : null))
  }
  return toCallbackParams(
    {
      code: c.req.query('code'),
      state: c.req.query('state'),
      error: c.req.query('error'),
    },
    null,
  )
}
