# @xid-kit/backend

XID publishes no packages to npm; `@xid-kit/backend` is distributed as source in the XID repository.

Backend SDK for XID token and webhook verification.

Status: current package.

Responsibilities:

- Verify JWTs with `verifyToken()`.
- Authenticate requests with `authenticateRequest()`.
- Exchange a same-origin Core opaque session cookie through `POST /v1/sessions/token`.
- Verify webhook signatures with `verifyWebhook()`.
- Support networkless verification with supplied JWKS public keys.

Security:

- Uses public keys only for JWT verification.
- Never attempts to verify `__Host-xid.rt.*` opaque refresh tokens locally.
- Forwards cookies only to an exact same-origin session-token endpoint.
- Does not store signing private keys.
- Keeps webhook replay tolerance bounded by timestamp verification.

`authenticateRequest()` accepts `Authorization: Bearer <jwt>` by default. An application-owned JWT
cookie is accepted only when `jwtCookieName` is configured. For a same-origin Core deployment,
configure `sessionTokenExchange: { endpoint: '/v1/sessions/token' }`; a separate-origin deployment
must perform an explicit Bearer/JWT handoff.

## Install

Inside the XID repository, reference the workspace package:

```json
{
  "dependencies": {
    "@xid-kit/backend": "workspace:^"
  }
}
```

In another repository, build the package from a pinned XID commit and pack its dependency closure:

```bash
git clone https://github.com/StringKe/xid.git
cd xid
git checkout <commit>
pnpm install --frozen-lockfile
pnpm --filter @xid-kit/backend... build
for pkg in types crypto backend; do
  pnpm --dir "packages/$pkg" pack --pack-destination /path/to/your-app/vendor/xid
done
```

Reference every tarball from the application's `package.json`:

```json
{
  "dependencies": {
    "@xid-kit/types": "file:vendor/xid/xid-kit-types-0.1.0-alpha.0.tgz",
    "@xid-kit/crypto": "file:vendor/xid/xid-kit-crypto-0.1.0-alpha.0.tgz",
    "@xid-kit/backend": "file:vendor/xid/xid-kit-backend-0.1.0-alpha.0.tgz"
  }
}
```

See the [SDK distribution guide](../../docs/sdks/distribution.md) for details.

See `docs/sdks/backend.md` and `docs/sdks/platform-matrix.md`.
