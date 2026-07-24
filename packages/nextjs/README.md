# @xid-kit/nextjs

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
- Does not expose server secrets to client components.

See `docs/sdks/nextjs.md` and `docs/sdks/platform-matrix.md`.
