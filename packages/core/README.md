# @xid-kit/core

Browser core SDK for XID.

Status: current package.

Responsibilities:

- Load and cache `/v1/me` client state.
- Manage session state for framework bindings.
- Return short-lived access tokens through `getToken()`.
- Expose Management API helpers used by embedded UI.
- Switch active organization through the explicit session API.

Security:

- Does not store a client secret.
- Does not expose refresh token material to browser code.
- Uses `apiUrl` for same-origin or self-hosted origin selection.

See `docs/sdks/web.md` and `docs/sdks/platform-matrix.md`.
