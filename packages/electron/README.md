# @xid-kit/electron

XID publishes no packages to npm; `@xid-kit/electron` is distributed as source in the XID repository.

XID identity platform SDK for Electron apps. Implements the Shared Native Contract
(Authorization Code + PKCE S256, system browser, no client secret) with:

- Main process: `XidElectronApp` - safeStorage encryption, loopback server / custom scheme, and
  authorization-code token exchange
- Renderer process: `getXidBridge()` - access the contextBridge API from renderer code
- Preload script: ships a ready-to-use preload that exposes `window.xidBridge`

Electron is a **peer dependency** (`"electron": ">=28"`). It is not bundled to
avoid version conflicts with the host app.

Entry points:

```
@xid-kit/electron           # default (renderer surface + types)
@xid-kit/electron/main      # main process only
@xid-kit/electron/renderer  # renderer process only
@xid-kit/electron/preload   # preload script
```

---

## Install

Inside the XID repository, reference the workspace package:

```json
{
  "dependencies": {
    "@xid-kit/electron": "workspace:^"
  }
}
```

In another repository, build the package from a pinned XID commit and pack its dependency closure:

```bash
git clone https://github.com/StringKe/xid.git
cd xid
git checkout <commit>
pnpm install --frozen-lockfile
pnpm --filter @xid-kit/electron... build
for pkg in types crypto protocol core electron; do
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
    "@xid-kit/electron": "file:vendor/xid/xid-kit-electron-0.1.0-alpha.0.tgz"
  }
}
```

See the [SDK distribution guide](../../docs/sdks/distribution.md) for details.

---

## Quick start

### 1. Main process (main.ts)

```ts
import { app, ipcMain } from 'electron'
import { XidElectronApp } from '@xid-kit/electron/main'

const xidApp = new XidElectronApp({
  issuer: 'https://xid.dev',
  clientId: 'client_abc123',
  // callbackStrategy: 'loopback',  // default (RFC 8252 s.7.3)
  // storageDir defaults to app.getPath('userData') + '/xid-tokens'
})

app.whenReady().then(async () => {
  await xidApp.init(ipcMain)

  const win = new BrowserWindow({
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  })

  win.on('closed', () => xidApp.dispose(ipcMain))
})
```

### 2. Preload script (preload.ts)

Use the preload shipped by this package directly:

```ts
// preload.ts
import '@xid-kit/electron/preload'
```

This exposes `window.xidBridge` with `storage`, `signIn`, `signOut`,
`getAccessToken`, `getSession`, and `setTokenStorage`.

### 3. Renderer process (renderer.ts)

```ts
import { getXidBridge } from '@xid-kit/electron/renderer'

const bridge = getXidBridge()

// Sign in: opens system browser, waits for loopback callback, exchanges code.
// Returns the access token on success.
const accessToken = await bridge.signIn()

// Get the current unexpired access token.
// Returns null when signed out or reauthorization is required.
const token = await bridge.getAccessToken()

// Get the full session (includes accessToken and expiresAt epoch seconds).
const session = await bridge.getSession()
if (session) {
  console.log(session.accessToken, session.expiresAt)
}

// The renderer can use @xid-kit/core separately for an exact same-origin web session,
// but it does not share the Electron main-process token session.
```

---

## Custom scheme (alternative to loopback)

```ts
// main.ts
import { app } from 'electron'
import { XidElectronApp } from '@xid-kit/electron/main'

app.setAsDefaultProtocolClient('myapp')

const xidApp = new XidElectronApp({
  issuer: 'https://xid.dev',
  clientId: 'client_abc123',
  callbackStrategy: 'custom-scheme',
  customScheme: 'myapp', // redirect_uri = myapp://callback
})

xidApp.registerDeepLinkHandler(app)

app.whenReady().then(async () => {
  await xidApp.init(ipcMain)
  // ...
})
```

---

## AbortSignal cancellation

The `signIn()` call supports an `AbortSignal` to cancel a pending sign-in flow.
If the signal is already aborted, the call rejects immediately without opening the browser.

```ts
const controller = new AbortController()

// Cancel sign-in after 2 minutes.
const timer = setTimeout(() => controller.abort(), 120_000)

try {
  const token = await bridge.signIn({ signal: controller.signal })
  clearTimeout(timer)
} catch (err) {
  if ((err as Error).message.includes('aborted')) {
    // User cancelled or timed out.
  }
}
```

---

## Storage

Tokens are encrypted with `safeStorage.encryptString()` (OS keychain integration)
and stored as binary files in `app.getPath('userData')/xid-tokens/` by default.
Override with `storageDir` in `XidElectronMainOptions`.

If `safeStorage.isEncryptionAvailable()` returns `false` (headless Linux without
a keyring daemon), `setItem()` throws `ElectronStorageError` with code
`encryption_unavailable` rather than silently writing plaintext.

The renderer accesses storage through the contextBridge:

```ts
const bridge = getXidBridge()
await bridge.storage.setItem('my-key', 'my-value')
const value = await bridge.storage.getItem('my-key') // string | null
await bridge.storage.removeItem('my-key')
```

---

## Shared native contract API surface

All native SDKs implement the same contract from `docs/sdks/platform-matrix.md`:

| Method              | Description                                                                |
| ------------------- | -------------------------------------------------------------------------- |
| `signIn(options?)`  | Opens system browser, exchanges code, stores tokens                        |
| `signOut()`         | Clears local tokens                                                        |
| `getAccessToken()`  | Returns the current unexpired token; null when reauthorization is required |
| `getSession()`      | Returns `{ accessToken, expiresAt }` or null                               |
| `setTokenStorage()` | No-op in the IPC bridge model (parity with contract)                       |

This SDK does not implement DPoP, so it rejects `offline_access` and registers as an
authorization-code-only public client. Re-run `signIn()` after the access token expires.
The historical `xid:refresh-token` storage key is delete-only migration cleanup; current code never
reads or writes a refresh credential and never calls refresh or revoke endpoints.

---

## Development

```sh
# type-check only (no Electron runtime needed)
pnpm --filter @xid-kit/electron typecheck

# lint + fmt + type-check
pnpm --filter @xid-kit/electron check

# tests (pure unit tests, no Electron runtime)
pnpm --filter @xid-kit/electron test
```
