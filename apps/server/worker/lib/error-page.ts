// 协议错误 HTML 页:/authorize 本地错误(redirect_uri 不可信不可重定向,03 章 10.2/10.7)
// 与 SAML ACS 浏览器错误共用。i18n 走动态 import:@xid-kit/i18n 的 lingui macro 在 node 测试池
// 无 babel transform,静态导入会在模块求值时 throw(见 middleware/__tests__/i18n.test.ts),
// 动态 import + catch 让测试回落英文源文本,生产构建(Vite macro transform)走正常 catalog。
// XSS:error/description 全部 HTML 转义后插值。

import type { Context } from 'hono'
import type { XidErrorCode } from '@xid-kit/types'
import type { XidHonoEnv } from './types'

type ProtocolErrorPageInput = {
  status: number
  error: string
  description: string
}

// HTML 转义:end_session 确认页等协议 HTML 页共用。
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
} // i18n 可用时按 locale 渲染标题与已知错误码描述;不可用(node 测试池)回落英文源文本。
// 标题回落串必须与 protocolErrorPageMessages.title 的 msg 源文本一致。
async function localizeErrorPage(
  c: Context<XidHonoEnv>,
  input: ProtocolErrorPageInput,
): Promise<{ title: string; description: string }> {
  try {
    const { errorMessages, protocolErrorPageMessages } = await import('@xid-kit/i18n')
    const i18n = c.get('i18n')
    const descriptor =
      input.error in errorMessages ? errorMessages[input.error as XidErrorCode] : undefined
    return {
      title: i18n._(protocolErrorPageMessages.title),
      description: descriptor ? i18n._(descriptor) : input.description,
    }
  } catch {
    return { title: 'Authorization error', description: input.description }
  }
}

function buildErrorPageHtml(input: {
  lang: string
  title: string
  error: string
  description: string
  detail: string | null
}): string {
  const detail = input.detail === null ? '' : `<p class="detail">${escapeHtml(input.detail)}</p>`
  return [
    '<!doctype html>',
    `<html lang="${escapeHtml(input.lang)}">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(input.title)} - xid</title>`,
    '<style>',
    'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#fafafa;color:#171717;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}',
    '.card{max-width:26rem;padding:2rem;text-align:center}',
    '.brand{margin:0 0 1.5rem;font-size:.875rem;font-weight:600;color:#737373}',
    'h1{margin:0 0 .75rem;font-size:1.25rem}',
    '.desc{margin:0 0 1.25rem;color:#404040}',
    '.code{display:inline-block;padding:.125rem .5rem;border-radius:4px;background:#e5e5e5;color:#525252;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.8125rem}',
    '.detail{margin:1rem 0 0;color:#737373;font-size:.8125rem;word-break:break-word}',
    '</style>',
    '</head>',
    '<body>',
    '<main class="card">',
    '<p class="brand">xid</p>',
    `<h1>${escapeHtml(input.title)}</h1>`,
    `<p class="desc">${escapeHtml(input.description)}</p>`,
    `<p><span class="code">${escapeHtml(input.error)}</span></p>`,
    detail,
    '</main>',
    '</body>',
    '</html>',
  ].join('')
}

// 渲染协议错误页:text/html; charset=utf-8 + no-store。本地化描述与原始 description 不同时
// 并列 detail 行(原始串是开发诊断信息,本地化串是用户可读文案);description 就是错误码时不重复展示。
export async function renderProtocolErrorPage(
  c: Context<XidHonoEnv>,
  input: ProtocolErrorPageInput,
): Promise<Response> {
  const localized = await localizeErrorPage(c, input)
  const locale = c.get('locale') as string | undefined
  const showDetail =
    localized.description !== input.description && input.description !== input.error
  const html = buildErrorPageHtml({
    lang: locale ?? 'en',
    title: localized.title,
    error: input.error,
    description: localized.description,
    detail: showDetail ? input.description : null,
  })
  return c.body(html, input.status as 400, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    pragma: 'no-cache',
  })
}
