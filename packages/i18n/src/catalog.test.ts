import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const ALL_LOCALES = ['en', 'zh-Hans', 'ja', 'ko', 'fr', 'de', 'es', 'pt-BR']
const LOCALES = ALL_LOCALES.filter((locale) => locale !== 'en')
const CATALOG_DIR = 'locales'

const allowedSameAsSource = new Set([
  '+1 555 000 0000',
  'API',
  'CSS',
  'DAU',
  'DPoP',
  'Email OTP',
  'HTML',
  'ID',
  'IdP SSO URL',
  'JSON',
  'JIT',
  'JWKS',
  'JWKS URI',
  'KV',
  'MAU',
  'OIDC',
  'OIDC / OAuth IdP',
  'OAuth',
  'OTP',
  'Passkey',
  'Passkeys',
  'Phone OTP',
  'R2',
  'SAML SSO',
  'SCIM',
  'SDK',
  'SDKs',
  'SMS',
  'SMS OTP',
  'SPA',
  'SSO',
  'URL',
  'WebAuthn',
  'WhatsApp',
  'WhatsApp OTP',
  'XID',
  'XML',
  'external-id',
  'external_id',
  'okta',
  'system',
  'username',
  'you@example.com',
  'admin, owner',
  'user_abc, user_def',
  // 包名 / 函数名 / URL / 颜色 / 占位符 / 逗号分隔事件名与错误码列表等不可译标识符(填原文)。
  '#10b981',
  '#6366f1',
  '#ffffff',
  '+15550000000',
  '000000',
  '8px',
  '@xid-kit/backend',
  '@xid-kit/core',
  '@xid-kit/nextjs',
  '@xid-kit/react',
  '@xid-kit/react-native',
  'GOOGLE_CLIENT_SECRET',
  'MIIC...',
  'activated, deactivated, deleted, saml_certificate_renewed, renewal_required',
  'activated, deleted, user.created, user.updated, user.deleted, group.created, group.updated, group.deleted, group.user_added, group.user_removed',
  'authenticateRequest',
  'blocked.example',
  'class',
  'colleague@example.com',
  'confidential',
  'created, accepted, revoked',
  'created, ended, removed, revoked',
  'created, updated, deleted',
  'created, updated, deleted, verified, verification_failed',
  'example.com',
  'example.com, company.com',
  'function',
  'google',
  'https://...',
  'https://accounts.google.com',
  'https://accounts.google.com/o/oauth2/v2/auth',
  'https://app.example.com/callback',
  'https://example.com/webhooks/xid',
  'https://idp.example.com/.well-known/openid-configuration',
  'https://idp.example.com/entity',
  'https://idp.example.com/login',
  'https://idp.example.com/metadata.xml',
  'https://idp.example.com/sso',
  'https://oauth2.googleapis.com/token',
  'https://openidconnect.googleapis.com/v1/userinfo',
  'https://xid.dev/auth/google/callback',
  'live',
  'openid, email, profile',
  'password_succeeded, password_failed, passkey_succeeded, passkey_failed, mfa_succeeded, mfa_failed, oauth_succeeded, oauth_failed, sso_succeeded, sso_failed, magic_auth_succeeded, magic_auth_failed, email_verification_succeeded, email_verification_failed, radar_risk_detected',
  'public',
  'test',
  'type',
  'user.created, organization.updated',
  'verifyToken',
  'verifyWebhook',
  'xxxxxxxx',
  // 代码标识符 / 框架词 / 环境变量列表 / hook 签名 / 字体栈 / 事件名(译者正确保留英文)。
  'Events API',
  'Hook',
  'Hooks',
  'Inter, system-ui, sans-serif',
  'Middleware',
  'Pages Router',
  'TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN',
  'WHATSAPP_META_PHONE_NUMBER_ID, WHATSAPP_META_ACCESS_TOKEN',
  'Webhooks',
  'client-id',
  'isLoaded, isSignedIn, session: XidSession | null',
  'isLoaded, isSignedIn, user: XidUser | null',
  'isLoaded, isSignedIn, userId, signOut, getToken',
  'isLoaded, organization: XidOrganization | null, membership',
  'subscription.created, subscription.updated, paymentAttempt.succeeded, paymentAttempt.failed',
  'user.created',
  'whatsapp:+15550000000',
  // SDK/SSO 文档里的品牌/产品/协议专名,CJK 文档惯例保留英文。
  'AD FS',
  'Android',
  'Apple',
  'Atlassian',
  'Flutter',
  'GitHub',
  'GitHub Enterprise Cloud',
  'Google',
  'Google Workspace',
  'JumpCloud',
  'Keycloak',
  'Microsoft Entra ID',
  'Next.js',
  'OAuth authorization code',
  'OIDC authorization code',
  'Okta',
  'OneLogin',
  'PingFederate',
  'PingOne',
  'React',
  'React Native',
  'SAML, OIDC',
  'SAML, OIDC, SCIM inbound',
  'SaaS',
  'Salesforce',
  'Scaffold',
  'Shibboleth',
  'Slack',
  'Web/Core',
  'Zoom',
  'iOS',
  'macOS',
  // 全生态 SDK 矩阵的运行时/语言/框架专名,CJK 文档惯例保留英文。
  '.NET',
  'Angular',
  'Astro',
  'Bun',
  'Cloudflare Workers',
  'Deno',
  'Electron',
  'Expo',
  'Go',
  'Java',
  'Linux',
  'Node.js',
  'Nuxt',
  'PHP',
  'Python',
  'Remix',
  'Ruby',
  'Rust',
  'SolidJS',
  'Svelte / SvelteKit',
  'Tauri',
  'Vanilla JS / Web',
  'Vue',
  'Windows',
  // fr 的 session 与英文同拼写,ICU plural 串与源同形。
  '{sessionCount, plural, one {# session} other {# sessions}}',
  // SDK 详情页的依赖版本号/平台最低版本/导出类型与服务名/TS 类型字面量/标识符列表/协议字段,均为代码事实(填原文)。
  '^1.2.2',
  '^3.0.3',
  '^4.0.0',
  '^9.2.4',
  '1.0.3065.39',
  '1.6.250228002',
  '8.0.0',
  'Android API 26+ (Android 8.0)',
  'ClientOptions',
  'InjectionKey',
  'InjectionToken',
  'OAuth 2.0 client_id',
  'XidAuthService',
  'XidClient API',
  'XidClientOptions',
  'XidKeychainAdapter',
  'XidOptions',
  'iOS 16+ / macOS 13+',
  'isLoaded, isSignedIn, userId, getToken, signOut',
  'jwtKey, issuer, authorizedParties, cookieName, protectedRoutes, onUnauthenticated',
  'macOS 13+',
  'readonly string[]',
  'string',
  // API 表 Kind 列的小写框架词,与已允许的 'Hook'/'Hooks' 同类(CJK 文档惯例保留英文)。
  'hook',
  // fr 的 "5 minutes" 与英文同拼写;CJK locale 均已意译,不受此豁免影响。
  '5 minutes',
  // 文档里的协议专名与技术标识符,CJK 文档惯例保留英文。
  'ACS URL',
  'ETag and If-Match',
  'GNAP, UMA, HEART, OpenID4VP, OpenID4VCI',
  'SAML, OIDC, LDAP legacy baseline',
  'SAML, OIDC, WS-Fed legacy baseline',
  'SP entity ID',
  'WS-Fed',
])

const targetScriptChecks = {
  'zh-Hans': {
    description: 'Chinese characters',
    test: (value: string) => /[\u3400-\u9fff]/u.test(value),
  },
  ja: {
    description: 'Japanese kana or kanji',
    test: (value: string) => /[\u3040-\u30ff\u3400-\u9fff]/u.test(value),
  },
  ko: {
    description: 'Hangul',
    test: (value: string) => /[\uac00-\ud7af]/u.test(value),
  },
} satisfies Record<string, { description: string; test: (value: string) => boolean }>

type PoEntry = {
  msgid: string
  msgstr: string
}

function parsePoString(line: string): string | null {
  const quoteIndex = line.indexOf('"')
  if (quoteIndex === -1) return null
  return JSON.parse(line.slice(quoteIndex)) as string
}

function readEntries(source: string): PoEntry[] {
  const entries: PoEntry[] = []
  let entry: PoEntry | null = null
  let target: keyof PoEntry | null = null

  for (const line of source.split('\n')) {
    if (line.trim() === '') {
      if (entry?.msgid) entries.push(entry)
      entry = null
      target = null
      continue
    }

    if (line.startsWith('#~')) continue
    if (line.startsWith('#')) continue

    if (line.startsWith('msgid ')) {
      entry = { msgid: parsePoString(line) ?? '', msgstr: '' }
      target = 'msgid'
      continue
    }

    if (line.startsWith('msgstr ')) {
      if (!entry) continue
      entry.msgstr = parsePoString(line) ?? ''
      target = 'msgstr'
      continue
    }

    if (line.startsWith('"') && entry && target) {
      entry[target] += parsePoString(line) ?? ''
    }
  }

  if (entry?.msgid) entries.push(entry)
  return entries
}

async function readCompiledMessageCount(locale: string): Promise<number> {
  const modulePath = pathToFileURL(join(process.cwd(), CATALOG_DIR, locale, 'messages.mjs')).href
  const catalog = (await import(modulePath)) as {
    messages: Record<string, unknown>
  }
  return Object.keys(catalog.messages).length
}

function isAllowedIdentity(entry: PoEntry): boolean {
  return allowedSameAsSource.has(entry.msgid)
}

function needsSourceEqualCheck(locale: string, entry: PoEntry): boolean {
  if (locale === 'zh-Hans' || locale === 'ja' || locale === 'ko') return true
  return /[.!?]$/u.test(entry.msgid) || /\s/u.test(entry.msgid.trim())
}

describe('i18n catalogs', () => {
  it.each(ALL_LOCALES)(
    'keeps %s source and runtime catalogs free of obsolete messages',
    async (locale) => {
      const poPath = join(CATALOG_DIR, locale, 'messages.po')
      const poSource = readFileSync(poPath, 'utf8')
      const activeCount = readEntries(poSource).length
      const obsoleteCount = poSource
        .split('\n')
        .filter((line) => line.startsWith('#~ msgid ')).length
      const compiledCount = await readCompiledMessageCount(locale)

      expect({ obsoleteCount, compiledCount }).toEqual({
        obsoleteCount: 0,
        compiledCount: activeCount,
      })
    },
  )

  it.each(LOCALES)('keeps %s translated and script-compatible', (locale) => {
    const path = join(CATALOG_DIR, locale, 'messages.po')
    const entries = readEntries(readFileSync(path, 'utf8'))
    const scriptCheck = targetScriptChecks[locale as keyof typeof targetScriptChecks]
    const empty: string[] = []
    const sourceEqual: string[] = []
    const targetScript: string[] = []
    const prefixGarbage: string[] = []

    for (const entry of entries) {
      if (entry.msgstr.trim() === '') {
        empty.push(entry.msgid)
        continue
      }

      if (
        !isAllowedIdentity(entry) &&
        needsSourceEqualCheck(locale, entry) &&
        entry.msgid === entry.msgstr
      ) {
        sourceEqual.push(entry.msgid)
      }

      if (scriptCheck && !isAllowedIdentity(entry) && !scriptCheck.test(entry.msgstr)) {
        targetScript.push(`${scriptCheck.description}: ${entry.msgid}`)
      }

      // 防线:译者偷懒贴"翻译:/翻訳:/번역:"前缀(伪翻译)直接判失败,
      // 否则 targetScript 的"含目标字形即过"会被前缀里的汉字蒙混。
      if (/^(?:翻译|翻訳|번역)\s*[:：]|^(?:FR|DE|ES|PT-BR):\s*/u.test(entry.msgstr.trimStart())) {
        prefixGarbage.push(entry.msgid)
      }
    }

    expect({ empty, sourceEqual, targetScript, prefixGarbage }).toEqual({
      empty: [],
      sourceEqual: [],
      targetScript: [],
      prefixGarbage: [],
    })
  })
})
