# @xid-kit/react

React SDK for XID.

Status: current package.

Responsibilities:

- `XidProvider` context.
- Authentication, session, user, organization, and API key hooks.
- Control components such as `SignedIn`, `SignedOut`, and `Protect`.
- Hosted Auth UI entry components and organization UI components.

Security:

- Does not perform protocol signing.
- Delegates login and consent to Hosted Auth.
- Uses Lingui runtime descriptors for user-visible text.

See `docs/sdks/react.md` and `docs/sdks/platform-matrix.md`.
