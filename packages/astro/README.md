# @xid-kit/astro

XID 身份平台的 Astro SDK。提供 Astro integration(自动注入 middleware)、SSR middleware(认证状态注入 `Astro.locals`)、岛屿客户端单例(`getClient`)。

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

export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  integrations: [
    xidIntegration({
      publishableKey: import.meta.env.PUBLIC_XID_PK,
      jwtKey: import.meta.env.XID_JWT_KEY,
      protectedRoutes: ['/dashboard', '/account'],
      signInUrl: '/sign-in',
    }),
  ],
})
```

integration 会:

- 在 `astro:config:setup` 钩子调用 `addMiddleware` 注入认证 middleware(order: 'pre')
- 注入 `window.__XID_PK` 初始化脚本供 island 使用

### 2. 手动配置 Middleware

若不用 integration,可在 `src/middleware.ts` 手动配置:

```ts
// src/middleware.ts
import { sequence } from 'astro:middleware'
import { createXidMiddleware } from '@xid-kit/astro'

export const onRequest = sequence(
  createXidMiddleware({
    jwtKey: import.meta.env.XID_JWT_KEY,
    issuer: 'https://xid.dev',
    protectedRoutes: ['/dashboard', '/account'],
    signInUrl: '/sign-in',
    publicRoutes: ['/dashboard/preview'],
  }),
)
```

middleware 会:

- 调用 `@xid-kit/backend` `authenticateRequest` networkless 验证 JWT(Authorization header 或 `__session` cookie)
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
/// <reference path="../node_modules/@xid-kit/astro/src/locals.d.ts" />
```

之后 `Astro.locals.xidAuth` 会有完整类型提示。

## API

### Integration

```ts
xidIntegration(options: XidIntegrationOptions): AstroIntegration
```

| 选项              | 类型       | 必填 | 说明                                         |
| ----------------- | ---------- | ---- | -------------------------------------------- |
| `publishableKey`  | `string`   | 是   | 客户端公钥(pk_live_xxx / pk_test_xxx)        |
| `jwtKey`          | `JwtKey`   | 否   | JWKS 公钥;middleware 做 networkless 验签所需 |
| `protectedRoutes` | `string[]` | 否   | 受保护路由前缀列表                           |
| `signInUrl`       | `string`   | 否   | 登录页路径,默认 `/sign-in`                   |
| `publicRoutes`    | `string[]` | 否   | 公开路由前缀(排除 protectedRoutes)           |

### Middleware

```ts
createXidMiddleware(options: XidMiddlewareOptions): AstroMiddlewareHandler
```

| 选项                | 类型       | 必填 | 说明                               |
| ------------------- | ---------- | ---- | ---------------------------------- |
| `jwtKey`            | `JwtKey`   | 是   | JWKS 公钥                          |
| `issuer`            | `string`   | 否   | 期望 issuer                        |
| `authorizedParties` | `string[]` | 否   | azp 白名单                         |
| `cookieName`        | `string`   | 否   | session cookie 名,默认 `__session` |
| `protectedRoutes`   | `string[]` | 否   | 受保护路由前缀                     |
| `signInUrl`         | `string`   | 否   | 登录页路径,默认 `/sign-in`         |
| `publicRoutes`      | `string[]` | 否   | 公开路由前缀                       |

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
getClient(options?: IslandClientOptions): XidClient
initClient(options: IslandClientOptions): XidClient
resetClient(): void  // 测试用
```

## 安全说明

- `jwtKey` 是 JWKS 公钥,可安全用于 networkless 验签,不包含 private key。
- `secretKey`(sk_live_xxx)只能在服务端使用,禁止传入 island 或客户端 bundle。
- `Astro.locals` 是服务端私有作用域,`xidAuth` 不会暴露给浏览器。
- 受保护路由的重定向通过 `Response.redirect` 在 middleware 层完成,不依赖客户端 JS。
