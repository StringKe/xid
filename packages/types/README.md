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

Distribution status: release artifacts are verified locally, but no npm publish has been performed.
See https://github.com/StringKe/xid/blob/main/docs/sdks/distribution.md.
