// i18n middleware 回归测试:验证 en sourceLocale catalog 正确加载后,
// i18n._({ id }) 返回可读英文文本而非 lingui v6 hash id。
//
// 不导入 renderErrorMessage / errorMessages(间接依赖 @lingui/core/macro,node 池无 babel transform)。
// 直接用 en/messages.mjs compile 产物中的已知 hash 做黑盒断言。
//
// hash 样本取自 packages/i18n/locales/en/messages.mjs:
//   "c-i7v3" -> "The email or password is incorrect."
//   "yO2Uxt" -> "Too many requests. Please wait and try again."
//   "Z3PAZP" -> "Your session has expired. Please sign in again."

import { Hono } from 'hono'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { setupI18n } from '@lingui/core'
import { i18nMiddleware } from '../i18n'
import type { XidHonoEnv } from '../../lib/types'

type CatalogMod = {
  messages?: Record<string, string | string[]>
  default?: { messages?: Record<string, string | string[]> }
}

async function loadEnCatalog(): Promise<Record<string, string | string[]>> {
  const mod = (await import('@xid-kit/i18n/locales/en/messages.mjs')) as unknown as CatalogMod
  return mod.messages ?? mod.default?.messages ?? {}
}

// lingui hash 形态:仅含字母数字和 `-_`,长度 1-8,无空格。
function looksLikeHash(s: string): boolean {
  return /^[A-Za-z0-9_-]{1,8}$/.test(s)
}

describe('en catalog 加载后 i18n._() 渲染可读文本', () => {
  it('invalid_credentials hash -> 含 password 的英文句子', async () => {
    const inst = setupI18n()
    const messages = await loadEnCatalog()
    inst.load('en', messages)
    inst.activate('en')

    // c-i7v3 = "The email or password is incorrect."
    const result = inst._({ id: 'c-i7v3' })
    expect(looksLikeHash(result)).toBe(false)
    expect(result).toContain('password')
  })

  it('rate_limited hash -> 含 requests 的英文句子', async () => {
    const inst = setupI18n()
    const messages = await loadEnCatalog()
    inst.load('en', messages)
    inst.activate('en')

    // yO2Uxt = "Too many requests. Please wait and try again."
    const result = inst._({ id: 'yO2Uxt' })
    expect(looksLikeHash(result)).toBe(false)
    expect(result).toContain('requests')
  })

  it('session_expired hash -> 含 session 的英文句子', async () => {
    const inst = setupI18n()
    const messages = await loadEnCatalog()
    inst.load('en', messages)
    inst.activate('en')

    // Z3PAZP = "Your session has expired. Please sign in again."
    const result = inst._({ id: 'Z3PAZP' })
    expect(looksLikeHash(result)).toBe(false)
    expect(result.toLowerCase()).toContain('session')
  })
})

describe('空 catalog 回归对照:hash id 被原样返回', () => {
  it('传空表后 i18n._(hash) 回落输出 hash 本身', () => {
    const inst = setupI18n()
    inst.load('en', {})
    inst.activate('en')

    // 空 catalog 下 lingui v6 回落 id 本身作文本,即输出 hash 字符串。
    const result = inst._({ id: 'c-i7v3' })
    expect(result).toBe('c-i7v3')
    expect(looksLikeHash(result)).toBe(true)
  })
})

function buildPublicErrorApp(gates?: {
  zhStarted?: () => void
  waitForZh?: Promise<void>
}): Hono<XidHonoEnv> {
  const app = new Hono<XidHonoEnv>()
  app.use('*', i18nMiddleware)
  app.onError((_error, c) =>
    c.json(
      {
        locale: c.get('locale'),
        message: c.get('i18n')._({ id: 'c-i7v3' }),
      },
      500,
    ),
  )
  app.get('/bootstrap-like', async (c) => {
    if (c.get('locale') === 'zh-Hans') {
      gates?.zhStarted?.()
      await gates?.waitForZh
    }
    throw new Error('bootstrap-like failure')
  })
  return app
}

describe('请求私有 Worker i18n', () => {
  it('在 bootstrap 注册前全局挂载请求 i18n', () => {
    const indexSource = readFileSync(
      fileURLToPath(new URL('../../index.ts', import.meta.url)),
      'utf8',
    )
    expect(indexSource.indexOf("app.use('*', i18nMiddleware)")).toBeGreaterThan(-1)
    expect(indexSource.indexOf("app.use('*', i18nMiddleware)")).toBeLessThan(
      indexSource.indexOf('registerBootstrapRoute(app)'),
    )
    expect(indexSource).not.toContain('app.use(pattern, i18nMiddleware)')
  })

  it('为 bootstrap 类公开错误激活 query locale 或默认 en', async () => {
    const app = buildPublicErrorApp()
    const zh = await app.request('https://xid.test/bootstrap-like?locale=zh-Hans')
    const en = await app.request('https://xid.test/bootstrap-like')
    const zhBody = (await zh.json()) as { locale: string; message: string }
    const enBody = (await en.json()) as { locale: string; message: string }

    expect(zh.status).toBe(500)
    expect(en.status).toBe(500)
    expect(zhBody.locale).toBe('zh-Hans')
    expect(enBody.locale).toBe('en')
    expect(zhBody.message).not.toBe(enBody.message)
    expect(enBody.message).toContain('password')
  })

  it('does not cross-contaminate error languages for interleaved requests', async () => {
    let releaseZh!: () => void
    const waitForZh = new Promise<void>((resolve) => {
      releaseZh = resolve
    })
    let markZhStarted!: () => void
    const zhStarted = new Promise<void>((resolve) => {
      markZhStarted = resolve
    })
    const app = buildPublicErrorApp({ zhStarted: markZhStarted, waitForZh })

    const zhRequest = app.request('https://xid.test/bootstrap-like?locale=zh-Hans')
    await zhStarted
    const en = await app.request('https://xid.test/bootstrap-like', {
      headers: { 'accept-language': 'en' },
    })
    releaseZh()
    const zh = await zhRequest
    const enBody = (await en.json()) as { locale: string; message: string }
    const zhBody = (await zh.json()) as { locale: string; message: string }

    expect(enBody).toMatchObject({ locale: 'en' })
    expect(zhBody).toMatchObject({ locale: 'zh-Hans' })
    expect(enBody.message).toContain('password')
    expect(zhBody.message).not.toBe(enBody.message)
  })
})
