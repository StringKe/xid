// /authorize 回跳渲染(03 章 10.6):response_mode = query / fragment / form_post。
// state 原样回传;错误也走同一回跳通道(client_id/redirect_uri 校验通过后,见 10.7)。

import { signJwt } from '@xid-kit/crypto'
import type { TenantContext } from '@xid-kit/types'
import type { Context } from 'hono'
import type { XidHonoEnv } from '../lib/types'
import type { ActiveSigner } from './shared'

export type ResponseMode = 'query' | 'fragment' | 'form_post' | 'query.jwt' | 'fragment.jwt'

export function resolveResponseMode(raw: string | undefined, responseType: string): ResponseMode {
  if (
    raw === 'query' ||
    raw === 'fragment' ||
    raw === 'form_post' ||
    raw === 'query.jwt' ||
    raw === 'fragment.jwt'
  ) {
    return raw
  }
  // 默认:code 流用 query,含 id_token 的 hybrid/implicit 用 fragment(10.6)。
  return responseType.split(' ').includes('id_token') ? 'fragment' : 'query'
}

export function isJwtResponseMode(mode: ResponseMode): boolean {
  return mode === 'query.jwt' || mode === 'fragment.jwt'
}

export async function signAuthorizationResponseJwt(input: {
  ctx: TenantContext
  signer: ActiveSigner
  clientId: string
  params: Record<string, string>
  now: number
}): Promise<string> {
  return signJwt(
    {
      header: { alg: input.signer.alg, kid: input.signer.kid },
      payload: {
        iss: input.ctx.issuer,
        aud: input.clientId,
        exp: input.now + 60,
        iat: input.now,
        jti: crypto.randomUUID(),
        ...input.params,
      },
    },
    input.signer.privateKey,
  )
}

// HTML 实体转义(form_post 自动提交表单,防注入)。
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function buildFormPost(redirectUri: string, params: Record<string, string>): string {
  const inputs = Object.entries(params)
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}"/>`)
    .join('')
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body onload="document.forms[0].submit()"><form method="post" action="${escapeHtml(
    redirectUri,
  )}">${inputs}</form></body></html>`
}

// 按 response_mode 回跳(成功 code 或错误参数共用)。params 已含 state(若有)。
export function respondToRp(
  c: Context<XidHonoEnv>,
  input: { redirectUri: string; mode: ResponseMode; params: Record<string, string> },
): Response {
  const mode = input.mode.endsWith('.jwt') ? (input.mode.slice(0, -4) as ResponseMode) : input.mode
  if (input.mode === 'form_post') {
    return c.body(buildFormPost(input.redirectUri, input.params), 200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    })
  }
  const url = new URL(input.redirectUri)
  const search = new URLSearchParams(input.params).toString()
  if (mode === 'fragment') {
    url.hash = search
  } else {
    url.search = url.search ? `${url.search.slice(1)}&${search}` : search
  }
  return c.redirect(url.toString(), 302)
}
