// sdk/windows 参考页。API 真相源:sdk/windows/ + sdk/windows/README.md。
// 状态措辞按 docs/sdks/platform-matrix.md:Implemented · verified locally。

import { Trans } from '@lingui/react/macro'
import { defineSdkDoc } from './shared'
import type { SdkDocSection } from './shared'

const sections: readonly SdkDocSection[] = [
  {
    heading: <Trans>Status</Trans>,
    body: [
      <Trans>
        Package status is <strong>Implemented · verified locally</strong>. dotnet test passes 19
        cases (net8.0 cross-platform build and net10.0). Windows-specific APIs (WebView2, DPAPI,
        WinUI 3) require a Windows build environment to verify. Real IdP round-trip is pending
        manual verification. This page documents implemented behavior; it is not a
        production-readiness claim.
      </Trans>,
    ],
  },
  {
    heading: <Trans>Requirements</Trans>,
    bullets: [
      <Trans>.NET 8 and Windows App SDK 1.6+</Trans>,
      <Trans>WebView2 Runtime (Evergreen — pre-installed with Microsoft Edge)</Trans>,
      <Trans>Application must set {'<UseWinUI>true</UseWinUI>'} in the project file</Trans>,
    ],
  },
  {
    heading: <Trans>Installation</Trans>,
    body: [<Trans>Add a PackageReference to your application project file:</Trans>],
    code: `<ItemGroup>
  <PackageReference Include="Xid.Windows" Version="0.1.0" />
</ItemGroup>`,
  },
  {
    heading: <Trans>Quick start</Trans>,
    code: `using Xid.Windows;

// 1. Configure in App.xaml.cs OnLaunched
XidClient.Shared.Configure(new XidConfiguration
{
    Issuer      = new Uri("https://xid.dev"),
    ClientId    = "your_client_id",
    RedirectUri = "com.example.myapp://auth/callback",
    // Scopes default: openid profile email offline_access
});

// 2. Sign in (opens embedded WebView2 window)
XidSession session = await XidClient.Shared.SignInAsync();
Console.WriteLine($"Signed in: {session.User.Email}");

// 3. Get a valid access token (auto-refresh)
string? token = await XidClient.Shared.GetAccessToken();

// 4. Get current session
XidSession? current = await XidClient.Shared.GetSession();

// 5. Sign out
await XidClient.Shared.SignOut();`,
  },
  {
    heading: <Trans>Custom URI scheme callback (optional)</Trans>,
    body: [
      <Trans>
        If using a custom URI scheme redirect rather than the WebView2 embedded window, forward the
        protocol activation URI to <code>HandleRedirectAsync</code>:
      </Trans>,
    ],
    code: `// App.xaml.cs
protected override void OnActivated(IActivatedEventArgs args)
{
    if (args.Kind == ActivationKind.Protocol)
    {
        var protocolArgs = (ProtocolActivatedEventArgs)args;
        await XidClient.Shared.HandleRedirectAsync(protocolArgs.Uri);
    }
}`,
  },
  {
    heading: <Trans>Core API</Trans>,
    table: {
      headers: [<Trans>Method</Trans>, <Trans>Description</Trans>],
      rows: [
        [
          <code key="m">Configure(XidConfiguration)</code>,
          <Trans>Initialize SDK. Call once at application startup.</Trans>,
        ],
        [
          <code key="m">SignInAsync(options?, ct)</code>,
          <Trans>
            Open an embedded WebView2 authorization window with PKCE S256. Returns XidSession on
            completion.
          </Trans>,
        ],
        [
          <code key="m">HandleRedirectAsync(Uri, ct)</code>,
          <Trans>Process a custom URI scheme callback and exchange the authorization code.</Trans>,
        ],
        [
          <code key="m">GetSession(ct)</code>,
          <Trans>Return the current session, refreshing automatically if near expiry.</Trans>,
        ],
        [
          <code key="m">GetAccessToken(options?, ct)</code>,
          <Trans>Return a valid access token string, triggering refresh if needed.</Trans>,
        ],
        [
          <code key="m">SignOut(ct)</code>,
          <Trans>Clear local session tokens from DPAPI-protected IsolatedStorage.</Trans>,
        ],
        [
          <code key="m">SetTokenStorage(ITokenStorage)</code>,
          <Trans>
            Replace the default DpapiTokenStorage with a custom ITokenStorage implementation.
          </Trans>,
        ],
      ],
    },
  },
  {
    heading: <Trans>Storage adapter</Trans>,
    body: [
      <Trans>
        The default storage encrypts tokens with DPAPI (CurrentUser scope) and persists them in
        IsolatedStorage. Implement <code>ITokenStorage</code> to use Windows Hello or Credential
        Manager:
      </Trans>,
    ],
    code: `public sealed class MyCustomStorage : ITokenStorage
{
    public Task SaveAsync(StoredTokenSet tokens, CancellationToken ct = default) { ... }
    public Task<StoredTokenSet?> LoadAsync(CancellationToken ct = default) { ... }
    public Task ClearAsync(CancellationToken ct = default) { ... }
}
XidClient.Shared.SetTokenStorage(new MyCustomStorage());`,
  },
  {
    heading: <Trans>Dependencies</Trans>,
    table: {
      headers: [<Trans>Package</Trans>, <Trans>Version</Trans>, <Trans>Purpose</Trans>],
      rows: [
        [
          <code key="p">Microsoft.WindowsAppSDK</code>,
          <Trans>1.6.250228002</Trans>,
          <Trans>WinUI 3 host and WebView2 embedding</Trans>,
        ],
        [
          <code key="p">Microsoft.Web.WebView2</code>,
          <Trans>1.0.3065.39</Trans>,
          <Trans>Chromium-based embedded authorization window</Trans>,
        ],
        [
          <code key="p">System.Security.Cryptography.ProtectedData</code>,
          <Trans>8.0.0</Trans>,
          <Trans>DPAPI token encryption at rest</Trans>,
        ],
      ],
    },
  },
  {
    heading: <Trans>Security</Trans>,
    bullets: [
      <Trans>Public client — no client secret stored or transmitted.</Trans>,
      <Trans>PKCE S256 only. Server rejects plain challenge method.</Trans>,
      <Trans>
        Tokens encrypted with DPAPI (CurrentUser scope) and stored in IsolatedStorage. Not
        accessible to other Windows user accounts.
      </Trans>,
      <Trans>OAuth state generated per request; validated on redirect to prevent CSRF.</Trans>,
    ],
  },
  {
    heading: <Trans>Known limitations</Trans>,
    bullets: [
      <Trans>
        WebView2 Runtime must be present. WebAuthenticationBroker support as a fallback is planned
        but not yet implemented.
      </Trans>,
      <Trans>
        JWKS-backed ID token verification and end_session sign-out are implemented and locally
        tested. Real Windows WebView2, DPAPI, and IdP round-trip validation is still required before
        L4 support.
      </Trans>,
      <Trans>
        DpapiTokenStorage does not run on non-Windows platforms. Use a different ITokenStorage
        implementation when cross-compiling.
      </Trans>,
    ],
  },
]

export const WINDOWS_DOC = defineSdkDoc({
  slug: 'sdks/windows',
  packageName: 'sdk/windows',
  summary: (
    <Trans>
      C# / .NET SDK for WinUI 3 applications using WebView2 for authorization, PKCE S256, and
      DPAPI-protected IsolatedStorage for token persistence.
    </Trans>
  ),
  sections,
})
