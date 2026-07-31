# @xid-kit/astro

Distribution status: release artifacts are verified locally, but no npm publish has been performed.
Install commands become registry-backed only after an authorized release. See
https://github.com/StringKe/xid/blob/main/docs/sdks/distribution.md.

XID 身份平台的 Astro SDK。提供 Astro integration(自动注入已配置的 middleware)、SSR middleware(认证状态注入 `Astro.locals`)、岛屿客户端单例(`getClient`)。

## 安装

```bash
pnpm add @xid-kit/astro
```

Peer dependency:

```
astro >= 4.0.0
```

## 快速上手

### 1. Integration(推荐)

在 `astro.config.mjs` 注册 integration,自动将认证 middleware 注入 SSR 请求管道:

```js
// astro.config.mjs
import { defineConfig } from 'astro/config'
import { xidIntegration } from '@xid-kit/astro'
import node from '@astrojs/node'

const jwtKeyJson = process.env.XID_JWKS_PUBLIC_KEY
if (!jwtKeyJson) throw new Error('Missing XID_JWKS_PUBLIC_KEY')

export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  integrations: [
    xidIntegration({
      // This combined SSR setup requires Core routes on the application's exact origin.
      browser: { mode: 'same-origin' },
      jwtKey: JSON.parse(jwtKeyJson),
      issuer: 'https://app.example.com',
      sessionTokenExchange: { endpoint: '/v1/sessions/token' },
      protectedRoutes: ['/dashboard', '/account'],
      signInUrl: '/sign-in',
    }),
  ],
})
```

integration 会:

- 通过 server-only Vite virtual module 传递 public JWK、同源 exchange 和路由配置
- 在 `astro:config:setup` 钩子调用 `addMiddleware` 注入已配置的认证 middleware(order: 'pre')
- 只把 `browser` 公共配置注入 `window.__XID_CONFIG` 供 island 使用

Integration 的 server 配置必须可序列化。已导入的 `CryptoKey`、自定义 `fetcher` 或
`AbortSignal` 应改用下方手动 middleware。`output: 'static'` 只能使用 client island
配置；若配置 server auth，integration 会直接报错，避免受保护路由静默失效。

普通的跨域开发者应用应使用 OIDC browser mode，不要把 Core cookie 当作第三方凭据：

```js
xidIntegration({
  browser: {
    mode: 'oidc',
    issuer: 'https://auth.example.com',
    clientId: 'client_abc123',
    redirectUri: 'https://app.example.com/auth/callback',
  },
})
```

该配置也适用于 `output: 'static'`。若同时需要 SSR 鉴权，应用应把短期 JWT 作为 Bearer
token 交给 Astro server；只有 exact same-origin 反向路由才能使用 `sessionTokenExchange`。

### 2. 手动配置 Middleware

若不用 integration,可在 `src/middleware.ts` 手动配置:

```ts
// src/middleware.ts
import { sequence } from 'astro:middleware'
import { createXidMiddleware } from '@xid-kit/astro'

export const onRequest = sequence(
  createXidMiddleware({
    jwtKey: JSON.parse(import.meta.env.XID_JWKS_PUBLIC_KEY),
    issuer: 'https://xid.dev',
    sessionTokenExchange: { endpoint: '/v1/sessions/token' },
    protectedRoutes: ['/dashboard', '/account'],
    signInUrl: '/sign-in',
    publicRoutes: ['/dashboard/preview'],
  }),
)
```

middleware 会:

- 验证 `Authorization: Bearer` 或显式 `jwtCookieName` 中的短期 JWT
- 若配置 `sessionTokenExchange`,把 Core opaque cookie 交给 exact same-origin
  `/v1/sessions/token`,再验签返回的短期 JWT
- 将认证结果写入 `Astro.locals.xidAuth`
- 未登录访问受保护路由时 302 到 signInUrl(携带 `?redirect_url=`)

### 3. .astro 页面服务端读取

```astro
---
// src/pages/dashboard.astro
import { getAuth } from '@xid-kit/astro/server'

const auth = getAuth(Astro.locals)

if (!auth.userId) {
  return Astro.redirect('/sign-in')
}
---

<h1>Welcome, {auth.userId}</h1>
```

### 4. 完整 User 对象

```astro
---
import { currentUser } from '@xid-kit/astro/server'

const user = await currentUser(Astro.locals, {
  secretKey: import.meta.env.XID_SECRET_KEY,
})
---

{user && <p>{user.primaryEmailAddress}</p>}
```

### 5. 客户端 Island

在浏览器侧的 Astro island 中使用 XidClient 单例:

```tsx
// src/components/SignInButton.tsx
import { getClient } from '@xid-kit/astro/client'

export default function SignInButton() {
  const client = getClient()

  const handleSignOut = async () => {
    await client.signOut()
    window.location.href = '/'
  }

  return <button onClick={handleSignOut}>Sign Out</button>
}
```

```astro
---
import SignInButton from '../components/SignInButton.tsx'
---
<SignInButton client:load />
```

### 6. Astro.locals 类型扩展

在项目 `src/env.d.ts` 中引入类型扩展:

```ts
import '@xid-kit/astro/locals'
```

之后 `Astro.locals.xidAuth` 会有完整类型提示。

## API

### Integration

```ts
xidIntegration(options: XidIntegrationOptions): AstroIntegration
```

| 选项                   | 类型                           | 必填 | 说明                                           |
| ---------------------- | ------------------------------ | ---- | ---------------------------------------------- |
| `browser`              | `XidIntegrationBrowserOptions` | 否   | 可序列化的 OIDC 或 exact same-origin Core 配置 |
| `jwtKey`               | `SerializableJwtKey`           | 否   | public JWK/JWKS；配置 server auth 时必填       |
| `issuer`               | `string`                       | 否   | 期望 issuer                                    |
| `authorizedParties`    | `string[]`                     | 否   | azp 白名单                                     |
| `jwtCookieName`        | `string`                       | 否   | 应用自己持有的短期 JWT cookie                  |
| `sessionTokenExchange` | `{ endpoint?: string }`        | 否   | exact same-origin Core cookie-to-JWT exchange  |
| `protectedRoutes`      | `string[]`                     | 否   | 受保护路由前缀列表                             |
| `signInUrl`            | `string`                       | 否   | 登录页路径,默认 `/sign-in`                     |
| `publicRoutes`         | `string[]`                     | 否   | 公开路由前缀(排除 protectedRoutes)             |

### Middleware

```ts
createXidMiddleware(options: XidMiddlewareOptions): AstroMiddlewareHandler
```

| 选项                   | 类型                          | 必填 | 说明                                          |
| ---------------------- | ----------------------------- | ---- | --------------------------------------------- |
| `jwtKey`               | `JwtKey`                      | 是   | JWKS 公钥                                     |
| `issuer`               | `string`                      | 否   | 期望 issuer                                   |
| `authorizedParties`    | `string[]`                    | 否   | azp 白名单                                    |
| `jwtCookieName`        | `string`                      | 否   | 应用自己持有的短期 JWT cookie                 |
| `sessionTokenExchange` | `SessionTokenExchangeOptions` | 否   | exact same-origin Core cookie-to-JWT exchange |
| `protectedRoutes`      | `string[]`                    | 否   | 受保护路由前缀                                |
| `signInUrl`            | `string`                      | 否   | 登录页路径,默认 `/sign-in`                    |
| `publicRoutes`         | `string[]`                    | 否   | 公开路由前缀                                  |

### Server Helpers

```ts
getAuth(locals: App.Locals): AuthResult
currentUser(locals: App.Locals, options?: XidServerClientOptions): Promise<XidUser | null>
xidClient(options: XidServerClientOptions): XidServerApiClient
```

`AuthResult` 是判别联合:

- 已认证:`{ userId: string; sessionId: string | undefined; orgId, orgRole, orgPermissions, claims }`
- 未认证:`{ userId: null; sessionId: null; ... }`

### Client Island Helper

```ts
getClient(options?: XidClientOptions): XidClient
initClient(options?: XidClientOptions): XidClient
resetClient(): void  // 测试用
```

## 安全说明

- `jwtKey` 是 JWKS 公钥,可安全用于 networkless 验签,不包含 private key。
- `__Host-xid.rt.*` 是 opaque refresh credential,SDK 不会把它当 JWT 在本地验证。
- Cookie header 只会转发到当前请求 exact same-origin 的 Core endpoint;跨域部署必须使用
  Bearer/JWT handoff。
- `secretKey`(sk_live_xxx)只能在服务端使用,禁止传入 island 或客户端 bundle。
- `Astro.locals` 是服务端私有作用域,`xidAuth` 不会暴露给浏览器。
- 受保护路由的重定向通过 `Response.redirect` 在 middleware 层完成,不依赖客户端 JS。
