# @xid-kit/nextjs

XID publishes no packages to npm; `@xid-kit/nextjs` is distributed as source in the XID repository.

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

## Install

Inside the XID repository, reference the workspace package:

```json
{
  "dependencies": {
    "@xid-kit/nextjs": "workspace:^"
  }
}
```

In another repository, build the package from a pinned XID commit and pack its dependency closure:

```bash
git clone https://github.com/StringKe/xid.git
cd xid
git checkout <commit>
pnpm install --frozen-lockfile
pnpm --filter @xid-kit/nextjs... build
for pkg in types crypto protocol core backend react nextjs; do
  pnpm --dir "packages/$pkg" pack --pack-destination /path/to/your-app/vendor/xid
done
```

Reference every tarball from the application's `package.json`:

```json
{
  "dependencies": {
    "@xid-kit/types": "file:vendor/xid/xid-kit-types-0.1.0-alpha.0.tgz",
    "@xid-kit/crypto": "file:vendor/xid/xid-kit-crypto-0.1.0-alpha.0.tgz",
    "@xid-kit/protocol": "file:vendor/xid/xid-kit-protocol-0.1.0-alpha.0.tgz",
    "@xid-kit/core": "file:vendor/xid/xid-kit-core-0.1.0-alpha.0.tgz",
    "@xid-kit/backend": "file:vendor/xid/xid-kit-backend-0.1.0-alpha.0.tgz",
    "@xid-kit/react": "file:vendor/xid/xid-kit-react-0.1.0-alpha.0.tgz",
    "@xid-kit/nextjs": "file:vendor/xid/xid-kit-nextjs-0.1.0-alpha.0.tgz"
  }
}
```

See the [SDK distribution guide](../../docs/sdks/distribution.md) for details.

See `docs/sdks/nextjs.md` and `docs/sdks/platform-matrix.md`.
