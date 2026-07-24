# @xid-kit/electron

XID identity platform SDK for Electron apps. Implements the Shared Native Contract
(Authorization Code + PKCE S256, system browser, no client secret) with:

- Main process: `XidElectronApp` - safeStorage encryption, loopback server / custom scheme, token exchange, transparent refresh rotation
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
import { getXidBridge, XidClient } from '@xid-kit/electron/renderer'

const bridge = getXidBridge()

// Sign in: opens system browser, waits for loopback callback, exchanges code.
// Returns the access token on success.
const accessToken = await bridge.signIn()

// Get the current access token (transparently refreshes if near expiry).
// Returns null when not signed in.
const token = await bridge.getAccessToken()

// Get the full session (includes accessToken and expiresAt epoch seconds).
const session = await bridge.getSession()
if (session) {
  console.log(session.accessToken, session.expiresAt)
}

// Or use XidClient for full state management (user, session, org):
const client = new XidClient({ apiUrl: 'https://xid.dev' })
await client.load()
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

| Method              | Description                                                          |
| ------------------- | -------------------------------------------------------------------- |
| `signIn(options?)`  | Opens system browser, exchanges code, stores tokens                  |
| `signOut()`         | Clears local tokens                                                  |
| `getAccessToken()`  | Returns current token (refreshes if near expiry); null if signed out |
| `getSession()`      | Returns `{ accessToken, expiresAt }` or null                         |
| `setTokenStorage()` | No-op in the IPC bridge model (parity with contract)                 |

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
