// me-auth handler 单测共享 harness:onError(AppError->JSON)、makeTenant、Env mock(DB/RATE_LIMITER/
// SESSION_REVOCATION/EMAIL_QUEUE/CACHE)、makeApp(挂 tenant + session 中间件 + 注册函数)。
// 对齐 auth/__tests__/magic-link.test.ts 风格。

import { vi } from 'vitest'
import { Hono } from 'hono'
import type { ErrorHandler } from 'hono'
import type { SessionData, TenantVar, XidHonoEnv } from '../../lib/types'
import { isAppError } from '../../lib/errors'

export const testErrorHandler: ErrorHandler<XidHonoEnv> = (err, c) => {
  if (isAppError(err)) {
    return c.json(
      { code: err.code, message: err.code, meta: err.meta },
      err.httpStatus as Parameters<typeof c.json>[1],
    )
  }
  return c.json({ code: 'server_error', message: 'server_error' }, 500)
}

export function makeTenant(tenantId = 'tenant-1', hostedAuthOrigin?: string) {
  return {
    tenantId,
    issuer: `https://${tenantId}.xid.dev`,
    rpId: `${tenantId}.xid.dev`,
    hostedAuthOrigin,
    signingKeys: {
      activeKid: 'k1',
      defaultAlg: 'ES256',
      keys: [
        {
          kid: 'k1',
          alg: 'ES256',
          encryptedPrivateKey: new Uint8Array(0),
          publicKeyJwk: {},
        },
      ],
    },
    policy: {
      hostedAuth: {
        identifierMode: 'email',
        requireVerifiedEmail: true,
        allowedEmailDomains: [],
        blockedEmailDomains: [],
        forceSso: false,
        allowUserCreation: true,
        allowExistingUserLogin: true,
        password: {
          enabled: true,
          allowLogin: true,
          allowUserCreation: true,
          requireEmailVerification: true,
        },
        magicLink: { enabled: true, allowLogin: true, allowUserCreation: false },
        emailOtp: { enabled: true, allowLogin: true, allowUserCreation: false },
        whatsappOtp: { enabled: true, allowLogin: true, allowUserCreation: false },
        smsOtp: { enabled: true, allowLogin: true, allowUserCreation: false },
        passkey: { enabled: true, allowLogin: true, allowUserCreation: false },
        enterpriseSso: {
          enabled: false,
          allowLogin: false,
          allowJitUserCreation: false,
          domainDiscovery: false,
        },
      },
      deliveryChannels: {},
    },
  }
}

// RateLimitStore DO:allowed 控制限流(check 接口)。
export function makeRateLimitNs(allowed = true): DurableObjectNamespace {
  return {
    idFromName: () => ({ toString: () => 'rl-id' }) as DurableObjectId,
    get: () =>
      ({
        fetch: async () =>
          new Response(JSON.stringify({ allowed, retryAfter: allowed ? 0 : 60, count: 1 })),
      }) as unknown as DurableObjectStub,
  } as unknown as DurableObjectNamespace
}

// SessionDO 每个 action 的响应形状必须是真的:session.ts 对 generation / add 的坏形状 fail closed,
// 一个"万能" body 会让签发路径测的是被吞掉的默认值而不是真实契约。
// 其余 action(is-active / revoke)沿用 active:true,签发后可读。
export function makeSessionNs(): DurableObjectNamespace {
  return {
    idFromName: () => ({ toString: () => 'sess-id' }) as DurableObjectId,
    get: () =>
      ({
        fetch: async (url: string) => {
          const action = new URL(url).pathname.replace(/^\//, '')
          if (action === 'generation') return Response.json({ generation: 0 })
          if (action === 'add') return Response.json({ ok: true, value: { accepted: true } })
          return Response.json({ active: true })
        },
      }) as unknown as DurableObjectStub,
  } as unknown as DurableObjectNamespace
}

// GuestStore DO 默认 fake:无绑定(lookup 404),bind 直接胜出。需要既有绑定/竞争落败语义的测试
// 经 MakeEnvOptions.guestStoreNs 注入自己的 stateful fake。
export function makeGuestStoreNs(): DurableObjectNamespace {
  return {
    idFromName: (name: string) => name as unknown as DurableObjectId,
    get: () =>
      ({
        fetch: async (url: string, init?: RequestInit) => {
          const action = new URL(url).pathname.replace(/^\//, '')
          if (action === 'lookup') return new Response('Not Found', { status: 404 })
          if (action === 'unbind') return new Response(null, { status: 204 })
          const body = JSON.parse(String(init?.body ?? '{}')) as { userId?: string }
          return Response.json({ userId: body.userId ?? '', created: true })
        },
      }) as unknown as DurableObjectStub,
  } as unknown as DurableObjectNamespace
}

export type MakeEnvOptions = {
  rateLimitAllowed?: boolean
  emailSend?: ReturnType<typeof vi.fn>
  smsSend?: ReturnType<typeof vi.fn>
  whatsappSend?: ReturnType<typeof vi.fn>
  auditSend?: ReturnType<typeof vi.fn>
  meteringSend?: ReturnType<typeof vi.fn>
  analyticsWrite?: ReturnType<typeof vi.fn>
  oauthStateNs?: DurableObjectNamespace
  webauthnNs?: DurableObjectNamespace
  guestStoreNs?: DurableObjectNamespace
  smsProvider?: 'twilio' | 'vonage'
  whatsappProvider?: 'twilio' | 'meta'
}

export function makeEnv(options: MakeEnvOptions = {}): Env {
  const {
    rateLimitAllowed = true,
    emailSend = vi.fn(),
    whatsappSend = vi.fn(),
    smsSend = vi.fn(),
    auditSend = vi.fn(),
    meteringSend = vi.fn(),
    analyticsWrite = vi.fn(),
  } = options
  return {
    DB: {} as D1Database,
    CACHE: {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
    } as unknown as KVNamespace,
    RATE_LIMITER: makeRateLimitNs(rateLimitAllowed),
    SESSION_REVOCATION: makeSessionNs(),
    GUEST_STORE: options.guestStoreNs ?? makeGuestStoreNs(),
    EMAIL_QUEUE: { send: emailSend } as unknown as Queue,
    WHATSAPP_QUEUE: { send: whatsappSend } as unknown as Queue,
    SMS_QUEUE: { send: smsSend } as unknown as Queue,
    AUDIT_QUEUE: { send: auditSend } as unknown as Queue,
    METERING_QUEUE: { send: meteringSend } as unknown as Queue,
    ANALYTICS: { writeDataPoint: analyticsWrite } as unknown as AnalyticsEngineDataset,
    OAUTH_STATE: options.oauthStateNs ?? makeSessionNs(),
    WEBAUTHN_CHALLENGE: options.webauthnNs ?? makeSessionNs(),
    KEK: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    PEPPER: 'YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoxMjM0NTY3OA',
    ...(options.smsProvider === 'twilio'
      ? {
          SMS_PROVIDER: 'twilio',
          TWILIO_ACCOUNT_SID: 'AC123',
          TWILIO_AUTH_TOKEN: 'token',
          SMS_FROM: '+15550000000',
        }
      : {}),
    ...(options.whatsappProvider === 'twilio'
      ? {
          WHATSAPP_PROVIDER: 'twilio',
          TWILIO_ACCOUNT_SID: 'AC123',
          TWILIO_AUTH_TOKEN: 'token',
          WHATSAPP_FROM: '+15550000000',
        }
      : {}),
    ...(options.whatsappProvider === 'meta'
      ? {
          WHATSAPP_PROVIDER: 'meta',
          WHATSAPP_META_PHONE_NUMBER_ID: '1234567890',
          WHATSAPP_META_ACCESS_TOKEN: 'meta-token',
        }
      : {}),
  } as unknown as Env
}

// 挂 tenant + session 中间件 + 注册函数,返回 app。
export function makeApp(
  register: (app: Hono<XidHonoEnv>) => void,
  options: { tenant?: TenantVar; session?: SessionData | null } = {},
): Hono<XidHonoEnv> {
  const app = new Hono<XidHonoEnv>()
  app.onError(testErrorHandler)
  app.use('*', async (c, next) => {
    c.set('tenant', (options.tenant ?? (makeTenant() as unknown as TenantVar)) as TenantVar)
    c.set('session', options.session ?? null)
    await next()
  })
  register(app)
  return app
}

// executionCtx mock:部分 handler 用 c.executionCtx.waitUntil 触发异步任务(HIBP / 提醒邮件)。
export const execCtx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext

// 已认证 session 视图(用于已登录端点测试)。
export function makeSession(userId = 'user-1', sessionId = 'sess-1'): SessionData {
  return {
    sessionId,
    userId,
    status: 'active',
    activeOrgId: null,
    authenticatedAt: new Date(),
    lastActiveAt: new Date(),
    expiresAt: new Date(Date.now() + 86400000),
    rememberMe: false,
    isImpersonation: false,
    impersonatorUserId: null,
    acr: null,
    amr: null,
    aal: null,
  }
}
