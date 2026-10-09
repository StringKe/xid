// 跨主机会话交接的四个入口,都挂在 /auth/passkey/handoff 下:
//   GET  /prepare  目标主机写 state cookie,把浏览器送回来源主机取 grant
//   GET  /start    来源主机凭当前会话签发 grant,以自动提交表单交给目标主机
//   POST /         目标主机消费 grant,签发同状态会话后续跑;失败 302 回登录页
//   GET  /return   组织主机上的流程完成后,把会话交回 issuer 主机续跑(如 /authorize)

import type { Hono } from 'hono'
import type { Context } from 'hono'
import * as v from 'valibot'
import { escapeHtml } from '../lib/error-page'
import { isAppError } from '../lib/errors'
import { logWorkerError, logWorkerWarning } from '../lib/safe-log'
import { readStepUpProof } from '../lib/step-up'
import type { XidHonoEnv } from '../lib/types'
import { requireSession } from '../me/shared'
import { isInstanceEntryContext } from './instance-login'
import {
  completeSessionHandoff,
  handoffStateSchema,
  handoffTokenSchema,
  issuerOrigin,
  mintSessionHandoff,
  requestOrigin,
  setHandoffState,
  type SessionHandoffForm,
} from './passkey-handoff'
import {
  handoffPrepareUrl,
  isHandoffContinuation,
  SESSION_HANDOFF_PATH,
} from './passkey-handoff-paths'

const HANDOFF_FAILED_PATH = '/sign-in?error=handoff_failed'

const consumeFormSchema = v.object({
  grantId: handoffTokenSchema,
  secret: handoffTokenSchema,
  organizationId: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
})

function noStoreRedirect(c: Context<XidHonoEnv>, location: string, status: 302 | 303): Response {
  c.header('cache-control', 'no-store')
  c.header('referrer-policy', 'no-referrer')
  return c.redirect(location, status)
}

// 过期、重放、state 不符属于预期拒绝,记警告;存储或内部故障记错误。
function handoffFailed(c: Context<XidHonoEnv>, reason: string, error?: unknown): Response {
  const event = `session_handoff.${reason}`
  if (isAppError(error) && error.code === 'server_error') {
    logWorkerError(event, error, { component: 'session-handoff' })
  } else {
    logWorkerWarning(event, { component: 'session-handoff' })
  }
  return noStoreRedirect(c, HANDOFF_FAILED_PATH, 302)
}

function randomNonce(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))))
}

// grant 只放在 POST 表单里,不进 URL 与 referrer;CSP 只放行本页脚本并只允许提交到目标 origin。
function handoffFormResponse(form: SessionHandoffForm): Response {
  const nonce = randomNonce()
  const inputs = Object.entries(form.fields)
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`,
    )
    .join('')
  const html = [
    '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"></head><body>',
    `<form method="post" action="${escapeHtml(form.action)}">${inputs}`,
    '<noscript><input type="submit"></noscript></form>',
    `<script nonce="${nonce}">document.forms[0].submit()</script>`,
    '</body></html>',
  ].join('')
  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': [
        "default-src 'none'",
        `script-src 'nonce-${nonce}'`,
        `form-action ${new URL(form.action).origin}`,
        "base-uri 'none'",
        "frame-ancestors 'none'",
      ].join('; '),
    },
  })
}

function parseOrigin(value: string | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    return url.origin === value ? url.origin : null
  } catch {
    return null
  }
}

// 目标主机接受的来源:根域只接受本实例的组织子域;组织主机只接受本实例的 issuer。
function isAllowedSource(c: Context<XidHonoEnv>, source: string): boolean {
  const tenant = c.get('tenant')
  const issuer = new URL(issuerOrigin(tenant))
  if (!isInstanceEntryContext(tenant)) return source === issuer.origin
  const url = new URL(source)
  return url.protocol === issuer.protocol && url.hostname.endsWith(`.${issuer.hostname}`)
}

async function handlePrepare(c: Context<XidHonoEnv>): Promise<Response> {
  const source = parseOrigin(c.req.query('from'))
  const continuePath = c.req.query('continue') ?? ''
  if (!source || !isAllowedSource(c, source) || !isHandoffContinuation(continuePath)) {
    return handoffFailed(c, 'prepare_rejected')
  }
  const params = new URLSearchParams({
    state: setHandoffState(c),
    target: requestOrigin(c),
    continue: continuePath,
  })
  return noStoreRedirect(c, `${source}${SESSION_HANDOFF_PATH}/start?${params.toString()}`, 302)
}

async function handleStart(c: Context<XidHonoEnv>): Promise<Response> {
  const state = c.req.query('state')
  const target = parseOrigin(c.req.query('target'))
  const continuePath = c.req.query('continue') ?? ''
  if (!state || !v.safeParse(handoffStateSchema, state).success || !target) {
    return handoffFailed(c, 'start_rejected')
  }
  try {
    const session = await requireSession(c, {
      pendingStatuses: ['pending_mfa', 'pending_mfa_setup'],
    })
    if (session.isImpersonation) return handoffFailed(c, 'start_impersonation')
    const form = await mintSessionHandoff(c, {
      tenant: c.get('tenant'),
      targetOrigin: target,
      continuePath,
      state,
      session: {
        userId: session.userId,
        status: session.status,
        authenticatedAt: session.authenticatedAt,
        acr: session.acr,
        amr: session.amr,
        aal: session.aal,
        rememberMe: session.rememberMe,
        stepUp: session.status === 'active' ? await readStepUpProof(c, session) : null,
      },
    })
    return handoffFormResponse(form)
  } catch (error) {
    if (isAppError(error)) return handoffFailed(c, 'start_failed', error)
    throw error
  }
}

async function handleConsume(c: Context<XidHonoEnv>): Promise<Response> {
  let body: Record<string, string | File>
  try {
    body = await c.req.parseBody()
  } catch (error) {
    return handoffFailed(c, 'consume_malformed', error)
  }
  const form = v.safeParse(consumeFormSchema, body)
  if (!form.success) return handoffFailed(c, 'consume_malformed')
  try {
    return noStoreRedirect(c, await completeSessionHandoff(c, form.output), 303)
  } catch (error) {
    if (isAppError(error)) return handoffFailed(c, 'consume_failed', error)
    throw error
  }
}

async function handleReturn(c: Context<XidHonoEnv>): Promise<Response> {
  const continuePath = c.req.query('continue') ?? ''
  const nested = continuePath.startsWith(`${SESSION_HANDOFF_PATH}/`)
  if (nested || !isHandoffContinuation(continuePath)) return handoffFailed(c, 'return_rejected')
  const issuer = issuerOrigin(c.get('tenant'))
  if (requestOrigin(c) === issuer) return noStoreRedirect(c, continuePath, 302)
  return noStoreRedirect(c, handoffPrepareUrl(c, issuer, continuePath), 302)
}

// 挂在 /auth/passkey 子路由上。
export function registerSessionHandoffRoutes(passkey: Hono<XidHonoEnv>): void {
  passkey.get('/handoff/prepare', handlePrepare)
  passkey.get('/handoff/start', handleStart)
  passkey.get('/handoff/return', handleReturn)
  passkey.post('/handoff', handleConsume)
}
