# @xid-kit/types

Shared public TypeScript contracts used by the XID SDK packages.

This package is part of the SDK dependency graph. Applications normally install a framework package
or `@xid-kit/core` instead of depending on it directly.

The root export contains runtime-neutral browser and server contracts. Cloudflare Worker bindings
are available only from the type-only `@xid-kit/types/cloudflare` subpath:

```ts
import type { Env } from '@xid-kit/types/cloudflare'
```

Only consumers of that subpath install `@cloudflare/workers-types`. It is an optional peer so a
browser application that imports `@xid-kit/types` does not install or load Cloudflare ambient types.

XID publishes no packages to npm; `@xid-kit/types` is distributed as source in the XID repository.

## Install

Inside the XID repository, reference the workspace package:

```json
{
  "dependencies": {
    "@xid-kit/types": "workspace:^"
  }
}
```

In another repository, build the package from a pinned XID commit and pack it:

```bash
git clone https://github.com/StringKe/xid.git
cd xid
git checkout <commit>
pnpm install --frozen-lockfile
pnpm --filter @xid-kit/types... build
pnpm --dir packages/types pack --pack-destination /path/to/your-app/vendor/xid
```

Reference the tarball from the application's `package.json`:

```json
{
  "dependencies": {
    "@xid-kit/types": "file:vendor/xid/xid-kit-types-0.1.0-alpha.0.tgz"
  }
}
```

See the [SDK distribution guide](../../docs/sdks/distribution.md) for details.
