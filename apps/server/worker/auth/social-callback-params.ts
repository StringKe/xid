// Social OAuth 回调参数:多数 provider 用 GET query,Apple 用 form_post(POST body)。

import type { Context } from 'hono'
import * as v from 'valibot'
import type { XidHonoEnv } from '../lib/types'
import { validateQuery } from '../lib/validate'

const callbackParamsSchema = v.object({
  code: v.optional(v.string()),
  state: v.optional(v.string()),
  error: v.optional(v.string()),
})

export type CallbackParams = { code: string | null; state: string | null; error: string | null }

function toCallbackParams(input: Record<string, string | undefined>): CallbackParams {
  const params = validateQuery(callbackParamsSchema, input)
  return { code: params.code ?? null, state: params.state ?? null, error: params.error ?? null }
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
    return toCallbackParams(raw)
  }
  return toCallbackParams({
    code: c.req.query('code'),
    state: c.req.query('state'),
    error: c.req.query('error'),
  })
}
