# @xid-kit/remix

Distribution status: release artifacts are verified locally, but no npm publish has been performed.
Install commands become registry-backed only after an authorized release. See
https://github.com/StringKe/xid/blob/main/docs/sdks/distribution.md.

XID 身份平台的 Remix SDK。提供 loader/action server 认证 helpers、cookie session 集成、OAuth callback helper,以及 `@xid-kit/core` / `@xid-kit/react` 客户端 API 的 re-export。

## 安装

```bash
pnpm add @xid-kit/remix @remix-run/node @remix-run/react react
```

## 快速上手

### 1. 初始化 Session Storage (app/sessions.server.ts)

```ts
import { createXidSessionStorage } from '@xid-kit/remix'

export const sessionStorage = createXidSessionStorage({
  secret: process.env.SESSION_SECRET!, // 必填:cookie 签名 secret
  // cookieName: '__xid_session',             // 默认值
  // maxAge: 2592000,                         // 默认 30 天
  // secure: true,                            // 生产默认 true
})
```

### 2. getAuth - 读取认证态 (loader)

```ts
import { getAuth } from '@xid-kit/remix'
import { redirect, json } from '@remix-run/node'
import type { LoaderFunctionArgs } from '@remix-run/node'
import { sessionStorage } from '~/sessions.server'

export async function loader({ request }: LoaderFunctionArgs) {
  const auth = await getAuth(request, {
    jwtKey: JSON.parse(process.env.XID_JWKS_PUBLIC_KEY!), // public JWK 或 JWKS
    sessionStorage, // 可选:从 session cookie 读取 token
    // 同源 Core browser session:
    sessionTokenExchange: { endpoint: '/v1/sessions/token' },
  })

  if (!auth.userId) return redirect('/login')
  return json({ userId: auth.userId, orgId: auth.orgId })
}
```

### 3. requireAuth - 未登录自动重定向 (loader)

```ts
import { requireAuth } from '@xid-kit/remix'
import { json } from '@remix-run/node'
import type { LoaderFunctionArgs } from '@remix-run/node'
import { sessionStorage } from '~/sessions.server'

export async function loader({ request }: LoaderFunctionArgs) {
  // 未认证时自动 throw 302 redirect 到 /login?return_to=<当前 URL>
  const auth = await requireAuth(
    request,
    {
      jwtKey: JSON.parse(process.env.XID_JWKS_PUBLIC_KEY!),
      sessionStorage,
      sessionTokenExchange: { endpoint: '/v1/sessions/token' },
    },
    { redirectPath: '/login' }, // 默认值
  )

  return json({ userId: auth.userId })
}
```

### 4. OAuth Callback Handler (routes/auth.callback.ts)

```ts
import { handleCallback } from '@xid-kit/remix'
import type { ActionFunctionArgs } from '@remix-run/node'
import { sessionStorage } from '~/sessions.server'

export async function action({ request }: ActionFunctionArgs) {
  const result = await handleCallback(request, {
    clientId: process.env.XID_CLIENT_ID!,
    redirectUri: process.env.XID_REDIRECT_URI!,
    sessionStorage,
    defaultReturnTo: '/dashboard',
    // 自托管实例使用其 issuer 根路径:
    // tokenEndpoint: 'https://identity.example.com/token',
  })

  if (!result.ok) {
    throw new Response(result.error, { status: 400 })
  }

  return result.response // 302 redirect + Set-Cookie
}
```

`tokenEndpoint` 默认是 `https://xid.dev/token`,与 Core discovery 公布的根 `/token` route
一致。自托管或自定义 instance issuer 必须显式传入该 issuer 的
`https://<issuer>/token`;Core 不提供 `/oauth/token` route。

### 5. 客户端 Provider (root.tsx)

```tsx
import { XidProvider } from '@xid-kit/remix' // re-export from @xid-kit/react
import { Outlet } from '@remix-run/react'

export default function App() {
  return (
    <XidProvider
      mode="oidc"
      issuer="https://auth.example.com"
      clientId="client_abc123"
      redirectUri="https://app.example.com/auth/callback"
    >
      <Outlet />
    </XidProvider>
  )
}
```

### 6. Server 端 Management API (action/loader)

```ts
import { xidClient } from '@xid-kit/remix'

const client = xidClient({ secretKey: process.env.XID_SECRET_KEY! })

export async function loader() {
  const result = await client.getUser('user_abc')
  if (!result.ok) throw new Response(result.error.message, { status: result.error.status })
  return json(result.value)
}
```

## Session 工具函数

```ts
import {
  getTokenFromSession,
  getRefreshTokenFromSession,
  setTokensInSession,
  clearTokensFromSession,
} from '@xid-kit/remix'

// 读取
const token = getTokenFromSession(session)
const refresh = getRefreshTokenFromSession(session)

// 写入(handleCallback 内部使用,一般不需要手调)
setTokensInSession(session, { accessToken: 'at.xxx', refreshToken: 'rt.xxx' })

// 清除(sign out)
clearTokensFromSession(session)
const setCookie = await sessionStorage.destroySession(session)
```

## 认证优先级

请求认证按以下顺序尝试:

1. `Authorization: Bearer <token>` header
2. 应用自己持有的短期 JWT cookie(仅当显式配置 `jwtCookieName`)
3. 同源 Core exchange(仅当配置 `sessionTokenExchange`)
4. `sessionStorage`(若传入)中的 `xid:access_token`

## PKCE & 安全

- 公开客户端无 client secret;OAuth 使用 Authorization Code + PKCE S256。
- `handleCallback` 验证 `state` 参数防 CSRF(存入 session `xid:oauth_state`)。
- access_token 存入 HttpOnly session cookie,不落 `localStorage`。
- Core `__Host-xid.rt.*` 是 opaque refresh credential,不得作为 JWT 本地验签。只有
  exact same-origin `/v1/sessions/token` 可以接收它;跨域应用必须使用 Bearer/JWT handoff。
- `requireAuth` 生成的 redirect URL 携带 `return_to` 参数,方便登录后回跳原页面。

## Peer Dependencies

| 包                | 版本要求   |
| ----------------- | ---------- |
| `@remix-run/node` | `>=2.0.0`  |
| `react`           | `>=18.0.0` |

## 开发

```bash
pnpm --filter @xid-kit/remix typecheck
pnpm --filter @xid-kit/remix test
```
