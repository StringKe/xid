// @xid-kit/electron 参考页。API 真相源:packages/electron/src/index.ts, main/, renderer/, preload/。

import { Trans } from '@lingui/react/macro'
import { defineSdkDoc } from './shared'
import type { SdkDocSection } from './shared'

const sections: readonly SdkDocSection[] = [
  {
    heading: <Trans>Status</Trans>,
    body: [
      <Trans>
        Package status is <strong>Current package</strong>. Main process app, contextBridge preload,
        and renderer-side bridge are implemented. A real IdP round-trip on production infrastructure
        is still pending manual verification.
      </Trans>,
    ],
  },
  {
    heading: <Trans>Entry points</Trans>,
    table: {
      headers: [<Trans>Entry</Trans>, <Trans>Purpose</Trans>],
      rows: [
        [
          <code key="e">@xid-kit/electron</code>,
          <Trans>Default export: renderer surface and types</Trans>,
        ],
        [
          <code key="e">@xid-kit/electron/main</code>,
          <Trans>Main process only: XidElectronApp</Trans>,
        ],
        [
          <code key="e">@xid-kit/electron/renderer</code>,
          <Trans>Renderer process: getXidBridge, XidClient</Trans>,
        ],
        [
          <code key="e">@xid-kit/electron/preload</code>,
          <Trans>Ready-made preload script that exposes window.xidBridge</Trans>,
        ],
      ],
    },
  },
  {
    heading: <Trans>Main process setup</Trans>,
    code: `// main.ts
import { app, ipcMain } from 'electron'
import { XidElectronApp } from '@xid-kit/electron/main'

const xidApp = new XidElectronApp({
  issuer: 'https://xid.dev',
  clientId: 'client_abc123',
  // callbackStrategy: 'loopback' (default, RFC 8252 s.7.3) | 'custom-scheme'
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
})`,
  },
  {
    heading: <Trans>Preload script</Trans>,
    code: `// preload.ts
import '@xid-kit/electron/preload'
// Exposes window.xidBridge with storage, signIn, signOut,
// getAccessToken, getSession, setTokenStorage`,
  },
  {
    heading: <Trans>Renderer process</Trans>,
    code: `import { getXidBridge } from '@xid-kit/electron/renderer'

const bridge = getXidBridge()

// Opens system browser, waits for loopback callback, exchanges code.
const accessToken = await bridge.signIn()

// Get current access token (transparently refreshes if near expiry).
const token = await bridge.getAccessToken() // null when not signed in

// Get full session (accessToken + expiresAt in epoch seconds).
const session = await bridge.getSession()

// Sign out and clear tokens.
await bridge.signOut()`,
  },
  {
    heading: <Trans>Custom scheme (alternative to loopback)</Trans>,
    code: `// main.ts
import { app } from 'electron'
import { XidElectronApp } from '@xid-kit/electron/main'

app.setAsDefaultProtocolClient('myapp')

const xidApp = new XidElectronApp({
  issuer: 'https://xid.dev',
  clientId: 'client_abc123',
  callbackStrategy: 'custom-scheme',
  customScheme: 'myapp',  // redirect_uri = myapp://callback
})

xidApp.registerDeepLinkHandler(app)`,
  },
  {
    heading: <Trans>Token storage</Trans>,
    bullets: [
      <Trans>
        Tokens are encrypted with <code>safeStorage.encryptString()</code> (OS keychain) and stored
        as binary files in <code>app.getPath('userData')/xid-tokens/</code> by default.
      </Trans>,
      <Trans>
        If <code>safeStorage.isEncryptionAvailable()</code> returns <code>false</code> (headless
        Linux without a keyring), <code>setItem()</code> throws <code>ElectronStorageError</code>{' '}
        with code <code>encryption_unavailable</code> rather than writing plaintext silently.
      </Trans>,
      <Trans>
        Override the storage directory with <code>storageDir</code> in{' '}
        <code>XidElectronMainOptions</code>.
      </Trans>,
    ],
  },
  {
    heading: <Trans>Shared native contract</Trans>,
    table: {
      headers: [<Trans>Method</Trans>, <Trans>Description</Trans>],
      rows: [
        [
          <code key="m">signIn(options?)</code>,
          <Trans>Opens system browser, exchanges code, stores tokens</Trans>,
        ],
        [<code key="m">signOut()</code>, <Trans>Clears local tokens</Trans>],
        [
          <code key="m">getAccessToken()</code>,
          <Trans>Returns current token (refreshes if near expiry); null if signed out</Trans>,
        ],
        [
          <code key="m">getSession()</code>,
          <Trans>Returns accessToken and expiresAt, or null</Trans>,
        ],
      ],
    },
  },
]

export const ELECTRON_DOC = defineSdkDoc({
  slug: 'sdks/electron',
  packageName: '@xid-kit/electron',
  summary: (
    <Trans>
      Electron SDK with main process PKCE flow, contextBridge preload, OS keychain token storage,
      and loopback or custom-scheme callback strategies.
    </Trans>
  ),
  sections,
})
