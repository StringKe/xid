// sdk/linux 参考页。API 真相源:sdk/linux/src/ + sdk/linux/README.md + Cargo.toml。
// 状态措辞按 docs/sdks/platform-matrix.md:Implemented · verified locally。

import { Trans } from '@lingui/react/macro'
import { defineSdkDoc } from './shared'
import type { SdkDocSection } from './shared'

const sections: readonly SdkDocSection[] = [
  {
    heading: <Trans>Status</Trans>,
    body: [
      <Trans>
        Package status is <strong>Implemented · verified locally</strong>. cargo test passes 24
        cases. Secret Service D-Bus storage and the full browser redirect flow require gnome-keyring
        or kwallet running on a desktop Linux system. Real IdP round-trip is pending manual
        verification. This page documents implemented behavior; it is not a production-readiness
        claim.
      </Trans>,
    ],
  },
  {
    heading: <Trans>Requirements</Trans>,
    bullets: [
      <Trans>Rust (stable, 2021 edition)</Trans>,
      <Trans>tokio async runtime</Trans>,
      <Trans>
        Desktop Linux with xdg-open (xdg-utils) for system browser launch and a running D-Bus
        session with gnome-keyring or kwallet for Secret Service storage
      </Trans>,
      <Trans>
        Headless / CI environments: use the in-memory-storage feature or inject InMemoryStorage
        directly
      </Trans>,
    ],
  },
  {
    heading: <Trans>Installation</Trans>,
    body: [<Trans>Add xid-linux to Cargo.toml:</Trans>],
    code: `[dependencies]
xid-linux = { path = "../sdk/linux" }   # local development
# published release:
# xid-linux = "0.1"
tokio = { version = "1", features = ["full"] }`,
  },
  {
    heading: <Trans>Quick start</Trans>,
    code: `use xid_linux::{XidClient, XidConfigBuilder};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // 1. Build config
    let config = XidConfigBuilder::new()
        .issuer("https://xid.dev")
        .client_id("your_client_id")
        .redirect_uri("http://127.0.0.1:51234/callback")
        .redirect_port(51234)
        .build()?;

    // 2. Create client (default: Secret Service storage)
    let client = XidClient::configure(config)?;

    // 3. Sign in — opens xdg-open browser, loopback TCP receives callback
    let session = client.sign_in(None).await?;
    println!("user: {}", session.user.sub);

    // 4. Get access token (auto-refresh)
    let token = client.get_access_token(None).await?;

    // 5. Sign out (revokes refresh token + clears storage)
    client.sign_out().await?;
    Ok(())
}`,
  },
  {
    heading: <Trans>Headless / CI usage</Trans>,
    body: [
      <Trans>
        When no D-Bus Secret Service daemon is available, pass InMemoryStorage to avoid a runtime
        error:
      </Trans>,
    ],
    code: `use xid_linux::{XidClient, XidConfigBuilder};
use xid_linux::storage::InMemoryStorage;
use std::sync::Arc;

let config = XidConfigBuilder::new()
    .issuer("https://xid.dev")
    .client_id("your_client_id")
    .redirect_uri("http://127.0.0.1:51234/callback")
    .build()?;

let client = XidClient::configure_with_storage(config, Arc::new(InMemoryStorage::new()))?;`,
  },
  {
    heading: <Trans>Core API</Trans>,
    table: {
      headers: [<Trans>Method</Trans>, <Trans>Description</Trans>],
      rows: [
        [
          <code key="m">XidConfigBuilder::new()</code>,
          <Trans>
            Builder for XidConfig. Required fields: issuer, client_id, redirect_uri. Optional:
            scopes, redirect_port (default 51234), http_timeout_secs (default 30).
          </Trans>,
        ],
        [
          <code key="m">XidClient::configure(config)</code>,
          <Trans>Create client with default SecretServiceStorage.</Trans>,
        ],
        [
          <code key="m">XidClient::configure_with_storage(config, adapter)</code>,
          <Trans>Create client with a custom StorageAdapter (e.g. InMemoryStorage).</Trans>,
        ],
        [
          <code key="m">sign_in(options) async</code>,
          <Trans>
            Open xdg-open browser, start loopback TCP listener on redirect_port, wait for the
            authorization code callback, exchange it, store tokens, and return a Session.
          </Trans>,
        ],
        [
          <code key="m">get_session() async</code>,
          <Trans>
            Return the stored session with automatic refresh token rotation if near expiry.
          </Trans>,
        ],
        [
          <code key="m">get_access_token(options) async</code>,
          <Trans>Return a valid access token string, refreshing automatically if needed.</Trans>,
        ],
        [
          <code key="m">sign_out() async</code>,
          <Trans>
            Revoke the refresh token at the /revocation endpoint and clear local storage.
          </Trans>,
        ],
        [
          <code key="m">set_token_storage(adapter)</code>,
          <Trans>Replace the storage adapter after construction.</Trans>,
        ],
      ],
    },
  },
  {
    heading: <Trans>Storage adapters</Trans>,
    table: {
      headers: [<Trans>Adapter</Trans>, <Trans>Description</Trans>],
      rows: [
        [
          <code key="a">SecretServiceStorage</code>,
          <Trans>
            Default. Stores tokens in the freedesktop.org Secret Service (gnome-keyring or kwallet)
            via D-Bus. Requires a running desktop session.
          </Trans>,
        ],
        [
          <code key="a">InMemoryStorage</code>,
          <Trans>
            In-process memory only. Tokens are lost on process exit. Use for testing or CI
            environments without a Secret Service.
          </Trans>,
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
        OAuth state validated on the loopback callback to prevent CSRF (RFC 8252 loopback redirect).
      </Trans>,
      <Trans>
        Secret Service encrypts tokens at rest via the desktop keyring daemon — the app does not
        manage encryption keys directly.
      </Trans>,
      <Trans>
        Refresh tokens are rotated on every use by the XID server; the SDK saves the new token after
        each refresh call.
      </Trans>,
    ],
  },
  {
    heading: <Trans>Known limitations</Trans>,
    bullets: [
      <Trans>
        JWKS-backed ID token verification and cache refresh are implemented and locally tested. A
        desktop Secret Service and real IdP round-trip are still required before L4 support.
      </Trans>,
      <Trans>
        The redirect port is fixed and must match the redirect_uri registered in the XID console.
        Dynamic port randomization (RFC 8252) requires dynamic client registration support.
      </Trans>,
      <Trans>
        System browser redirect and Secret Service storage require desktop environment evidence.
      </Trans>,
    ],
  },
]

export const LINUX_DOC = defineSdkDoc({
  slug: 'sdks/linux',
  packageName: 'sdk/linux',
  summary: (
    <Trans>
      Rust SDK for Linux desktop using xdg-open for browser launch, loopback TCP for the
      authorization callback, PKCE S256, and freedesktop.org Secret Service token storage.
    </Trans>
  ),
  sections,
})
