# @xid-kit/backend

Backend SDK for XID token and webhook verification.

Status: current package.

Responsibilities:

- Verify JWTs with `verifyToken()`.
- Authenticate requests with `authenticateRequest()`.
- Verify webhook signatures with `verifyWebhook()`.
- Support networkless verification with supplied JWKS public keys.

Security:

- Uses public keys only for JWT verification.
- Does not store signing private keys.
- Keeps webhook replay tolerance bounded by timestamp verification.

See `docs/sdks/backend.md` and `docs/sdks/platform-matrix.md`.
