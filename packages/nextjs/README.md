# @xid-kit/nextjs

Distribution status: release artifacts are verified locally, but no npm publish has been performed.
Install commands become registry-backed only after an authorized release. See
https://github.com/StringKe/xid/blob/main/docs/sdks/distribution.md.

Next.js SDK for XID.

Status: current package.

Responsibilities:

- Edge middleware through `xidMiddleware()`.
- App Router helpers through `auth()` and `currentUser()`.
- Pages Router helper through `getAuth()`.
- Server client entry through `xidClient()`.
- React SDK re-exports for client components.

Security:

- Keeps server helpers on the server side.
- Uses `@xid-kit/backend` verification primitives.
- Exchanges Core opaque cookies only through an exact same-origin session-token endpoint.
- Accepts an application JWT cookie only when `jwtCookieName` is explicitly configured.
- Does not expose server secrets to client components.

For same-origin Core routing:

```ts
export default xidMiddleware({
  jwtKey: JSON.parse(process.env.XID_JWKS_PUBLIC_KEY!),
  issuer: 'https://xid.dev',
  sessionTokenExchange: { endpoint: '/v1/sessions/token' },
})
```

For a separate application origin, use an explicit Bearer/JWT handoff. The middleware never attempts
to verify the opaque `__Host-xid.rt.*` refresh cookie locally.

See `docs/sdks/nextjs.md` and `docs/sdks/platform-matrix.md`.
