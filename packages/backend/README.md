# @xid-kit/backend

Distribution status: release artifacts are verified locally, but no npm publish has been performed.
Install commands become registry-backed only after an authorized release. See
https://github.com/StringKe/xid/blob/main/docs/sdks/distribution.md.

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

See `docs/sdks/backend.md` and `docs/sdks/platform-matrix.md`.
