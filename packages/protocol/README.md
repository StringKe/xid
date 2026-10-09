# @xid-kit/protocol

OAuth, OIDC, and PKCE protocol helpers shared by the XID SDK packages.

This package is built as a runtime dependency of the client SDKs that use its protocol helpers.
Applications normally receive it as part of the dependency closure of another `@xid-kit/*` package.

XID publishes no packages to npm; `@xid-kit/protocol` is distributed as source in the XID repository.

## Install

Inside the XID repository, reference the workspace package:

```json
{
  "dependencies": {
    "@xid-kit/protocol": "workspace:^"
  }
}
```

In another repository, build the package from a pinned XID commit and pack its dependency closure:

```bash
git clone https://github.com/StringKe/xid.git
cd xid
git checkout <commit>
pnpm install --frozen-lockfile
pnpm --filter @xid-kit/protocol... build
for pkg in types crypto protocol; do
  pnpm --dir "packages/$pkg" pack --pack-destination /path/to/your-app/vendor/xid
done
```

Reference every tarball from the application's `package.json`:

```json
{
  "dependencies": {
    "@xid-kit/types": "file:vendor/xid/xid-kit-types-0.1.0-alpha.0.tgz",
    "@xid-kit/crypto": "file:vendor/xid/xid-kit-crypto-0.1.0-alpha.0.tgz",
    "@xid-kit/protocol": "file:vendor/xid/xid-kit-protocol-0.1.0-alpha.0.tgz"
  }
}
```

See the [SDK distribution guide](../../docs/sdks/distribution.md) for details.
