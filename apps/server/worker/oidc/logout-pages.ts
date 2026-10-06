// /end_session 的确认页与登出结果页。文案用请求级 lingui 实例渲染;动态 import 与 error-page 相同,
// node 测试池没有 macro transform 时回落英文源文本(回落串必须与 logoutPageMessages 源文本一致)。

import type { Context } from 'hono'
import { buildWorkerPageHtml, escapeHtml, workerPageLang } from '../lib/error-page'
import { hostedAuthOrigin } from '../lib/hosted-origin'
import type { XidHonoEnv } from '../lib/types'

const FRONT_CHANNEL_REDIRECT_DELAY_SEC = 2

type LogoutCopy = {
  signOut: string
  confirmDescription: string
  signedOutTitle: string
  signedOutDescription: string
  returningDescription: string
  continue: string
  signInAgain: string
}

const FALLBACK_COPY: LogoutCopy = {
  signOut: 'Sign out',
  confirmDescription: 'Do you want to sign out of this account?',
  signedOutTitle: 'You have signed out',
  signedOutDescription: 'You can close this page or sign in again.',
  returningDescription: 'Returning you to the application.',
  continue: 'Continue',
  signInAgain: 'Sign in again',
}

async function logoutCopy(c: Context<XidHonoEnv>): Promise<LogoutCopy> {
  try {
    const { logoutPageMessages } = await import('@xid-kit/i18n')
    const i18n = c.get('i18n')
    return {
      signOut: i18n._(logoutPageMessages.signOut),
      confirmDescription: i18n._(logoutPageMessages.confirmDescription),
      signedOutTitle: i18n._(logoutPageMessages.signedOutTitle),
      signedOutDescription: i18n._(logoutPageMessages.signedOutDescription),
      returningDescription: i18n._(logoutPageMessages.returningDescription),
      continue: i18n._(logoutPageMessages.continue),
      signInAgain: i18n._(logoutPageMessages.signInAgain),
    }
  } catch {
    return FALLBACK_COPY
  }
}

function htmlResponse(c: Context<XidHonoEnv>, html: string): Response {
  return c.body(html, 200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    pragma: 'no-cache',
  })
}

// 无有效 id_token_hint 时的登出确认页:GET 直撤是 CSRF logout 面(第三方页可 <img> 触发强制登出),
// OIDC RP-Init 要求无 hint 时先确认。表单 POST confirm=true 才真正撤销;post_logout_redirect_uri /
// client_id / state 经 hidden input 透传,确认后仍能回跳。
export async function renderLogoutConfirmPage(
  c: Context<XidHonoEnv>,
  params: Record<string, string>,
): Promise<Response> {
  const copy = await logoutCopy(c)
  const hidden = (['post_logout_redirect_uri', 'client_id', 'state'] as const)
    .map((key) => {
      const value = params[key]
      return value === undefined
        ? ''
        : `<input type="hidden" name="${key}" value="${escapeHtml(value)}">`
    })
    .join('')
  const html = buildWorkerPageHtml({
    lang: workerPageLang(c),
    title: copy.signOut,
    bodyHtml: [
      `<p class="desc">${escapeHtml(copy.confirmDescription)}</p>`,
      '<form method="post" action="/end_session">',
      hidden,
      '<input type="hidden" name="confirm" value="true">',
      `<button type="submit">${escapeHtml(copy.signOut)}</button>`,
      '</form>',
    ].join(''),
  })
  return htmlResponse(c, html)
}

// 登出结果页:嵌入各 RP 的 front-channel iframe;有已校验的回跳地址时稍候自动返回 RP,
// 否则提供重新登录入口。
export async function renderSignedOutPage(
  c: Context<XidHonoEnv>,
  input: { frontChannelUris: readonly string[]; continueUrl: string | null },
): Promise<Response> {
  const copy = await logoutCopy(c)
  const iframes = input.frontChannelUris
    .map(
      (uri) =>
        `<iframe src="${escapeHtml(uri)}" width="0" height="0" style="display:none" title=""></iframe>`,
    )
    .join('')
  const target = input.continueUrl ?? `${hostedAuthOrigin(c)}/sign-in`
  const html = buildWorkerPageHtml({
    lang: workerPageLang(c),
    title: copy.signedOutTitle,
    headHtml:
      input.continueUrl === null
        ? ''
        : `<meta http-equiv="refresh" content="${FRONT_CHANNEL_REDIRECT_DELAY_SEC};url=${escapeHtml(input.continueUrl)}">`,
    bodyHtml: [
      `<p class="desc">${escapeHtml(input.continueUrl === null ? copy.signedOutDescription : copy.returningDescription)}</p>`,
      `<a class="action" href="${escapeHtml(target)}">${escapeHtml(input.continueUrl === null ? copy.signInAgain : copy.continue)}</a>`,
      iframes,
    ].join(''),
  })
  return htmlResponse(c, html)
}
