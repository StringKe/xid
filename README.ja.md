# XID

[English](README.md) | [简体中文](README.zh-Hans.md) | 日本語 | [한국어](README.ko.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Español](README.es.md) | [Português (BR)](README.pt-BR.md)

一つの codebase から 3 つの Cloudflare Workers として deploy する edge-native な identity platform
である。Core Worker は OIDC/OAuth、マルチテナント RBAC、enterprise SSO federation、Hosted Auth、
account ページを提供し、Nimbus Site Worker は apex ルートの完全な多言語ドキュメント、分離された Console
Worker は management UI を提供する。

[![CI](https://img.shields.io/github/actions/workflow/status/StringKe/xid/ci.yml?branch=main&label=CI)](https://github.com/StringKe/xid/actions/workflows/ci.yml) [![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE) [![Runtime](https://img.shields.io/badge/runtime-Cloudflare%20Workers-orange)](https://developers.cloudflare.com/workers/) [![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/StringKe/xid/badge)](https://securityscorecards.dev/viewer/?uri=github.com/StringKe/xid) [![OpenSSF Best Practices](https://www.bestpractices.dev/projects/13783/badge)](https://www.bestpractices.dev/projects/13783)

<a href="https://www.producthunt.com/products/xid?embed=true&amp;utm_source=badge-featured&amp;utm_medium=badge&amp;utm_campaign=badge-xid" target="_blank" rel="noopener noreferrer"><img alt="XID - Edge-native identity platform on Cloudflare Workers | Product Hunt" width="250" height="54" src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1217874&amp;theme=light&amp;t=1786263008879"></a>

## プロジェクトの状態

**1.0 未満。まだ production で動かしてはならない。** 以下に挙げる機能はすべてローカルの証跡のみに
裏付けられている。すなわち unit test、Workers runtime 上の integration test、そしてローカルビルドに
対する browser または protocol client の smoke test である。実在する外部 identity provider、実在する
下流 SaaS アプリケーション、実在する social OAuth provider、実際の SMS/WhatsApp 配信に対して
end-to-end で検証したものは一つもない。証跡の階層(L0 から L4)と機能ごとのサポートレベルは
[`docs/protocols/README.md`](docs/protocols/README.md) に定義されており、ここに書いた要約よりも
そちらが正となる。インターフェース、データベース schema、package API は非推奨期間を置かずに
変更されうる。

## なぜ XID か

認証リクエストは latency に厳しく、かつ世界中に分散しているにもかかわらず、多くの identity platform は
単一リージョンからそれに応答している。XID は authorization server 全体を Cloudflare のエッジに載せる。
token の署名は isolate 内の Web Crypto で走り、session の失効は中央データベースではなくユーザー単位の
Durable Object が直列化し、JWKS は KV にキャッシュされるので relying party は往復通信なしに token を
検証できる。マルチテナントも後付けではない。issuer、署名鍵、WebAuthn RP ID、ポリシーはいずれも
単一の `TenantContext` から解決されるため、同じソースツリーがビルドフラグではなく設定によって、
ゼロコンフィグの単一テナント配備にも、マルチテナント instance にもなる。

## 機能

**プロトコルとフェデレーション**

- OIDC/OAuth 2.x authorization server は discovery、JWKS、protected-resource metadata、
  `/authorize`、`/token`、`/userinfo`、`/introspect`、`/revoke`、`/end_session`、PAR、Device Flow、
  Dynamic Client Registration、CIBA、hybrid response、front-channel、back-channel、
  session-management logout を提供する。
- PKCE S256 必須の authorization code、client credentials、family replay を検知して失効する refresh token
  rotation、RFC 8693 token exchange を実装している。Resource Indicators、DPoP、mTLS、JAR、JARM、
  RAR、ローカルの Browser-Based Apps および FAPI 2.0 policy profile も実装済みである。
- 双方向の enterprise SSO として、inbound SAML 2.0 SP と OIDC RP federation、下流 SaaS 向け outbound
  SAML 2.0 IdP と OIDC application、LDAP direct bind、WS-Federation、SWA password vaulting、
  header-based SSO、directory connector framework を備える。
- SCIM 2.0 Service Provider は Users、Groups、PATCH、filter、projection、sort、bulk、ETag/If-Match を
  提供し、下流 SaaS ターゲットへの Users/Groups outbound provisioning も実装する。
- OpenID Federation は最小限の entity metadata と registration boundary のみである。Trust-chain
  resolution、trust anchor、authority-hint traversal、production interoperability は未実装である。

**認証とアカウントライフサイクル**

- 主要 credential は passkey/WebAuthn であり、discoverable credential、必須 user verification、
  ES256/RS256/EdDSA 検証、sign-count clone detection、policy-driven packed enterprise attestation
  検証を備える。
- Password は Workers Secrets の server-side pepper と Argon2id を使う。Passwordless sign-in は
  magic link と email/SMS/WhatsApp の one-time code、social OAuth relying-party flow は Google、
  GitHub、Microsoft account、Apple をサポートする。
- MFA は TOTP、SMS、passkey challenge、single-use backup code、現在の session に結び付いた OIDC
  AAL2 step-up を提供する。AAL3 のサポートは主張しない。
- Guest sign-in は Firebase-style lazy reuse と `sub` を維持する one-click in-place passkey upgrade を
  提供する。Browser client は hidden-iframe `prompt=none` silent re-authentication と top-level redirect
  fallback も利用できる。
- Hosted Auth と account portal は invitation acceptance、email verification、top-level Tenant
  onboarding、active Organization selection、session management、self-service credential management
  を実装する。

**組織と認可**

- Instance、Organization、一階層の SubOrg、membership、Project、Application、role、permission、
  user grant と cross-Organization grant、invitation、domain verification を備える。
- OrgUnit tree は Organization 内の部門と team を表し、primary/secondary placement、最大深度 8、
  subtree move と archive、reporting line に沿った manager resolution を提供する。OrgUnit は tenant
  boundary にも token claim にもならない。
- 各 Project は `open`、`restricted`、`approval_required` のいずれかに設定できる。同じ Organization
  からの authorization はその policy を強制し、user は access を申請できる。Approver は OrgUnit
  reporting line と management fallback から解決され、承認時に期限付き `user_grant` を作成できる。

**運用と配信**

- `/v1/*` の Management API、`/v1/me/*` の self-service account portal、独立して guard された
  `/v1/platform/*` の instance-operator API を提供する。
- Append-only audit event は tenant ごとの SHA-256 hash chain を使い、保存前に機密 metadata を redact
  する。8 本の async pipeline は独立した dead-letter と quarantine path、lease-based replay を持ち、
  metering failure は D1 outbox に fallback する。
- Signed webhook は encrypted secret、rotation、retry、idempotent message ID、dead-letter snapshot を
  サポートする。Self-service privacy flow は private R2 export と取消可能な delayed erasure を提供し、
  sole Organization owner と last instance manager を保護する。
- Feature flag、branding、usage metering、announcement、compliance artifact、8 ロケール
  (en, zh-Hans, ja, ko, fr, de, es, pt-BR) の Hosted UI を同じ codebase から管理する。

## クイックスタート

### アプリケーションへの組み込み

18 個の `@xid-kit/*` TypeScript package は publishable に設定され、clean なローカル tarball consumer
gate (`pnpm run sdk:distribution:verify`) を通過している。外部 registry の現在の状態を示す release
evidence はリポジトリ内にないため、npm 公開状態は `UNKNOWN` である。registry を別途確認しない限り、
workspace またはローカル生成 tarball を使う。以下の API が現在の公開インターフェースである。
`@xid-kit/react` から:

```tsx
import { XidProvider, SignedIn, SignedOut, SignInButton, UserButton } from '@xid-kit/react'

function App() {
  return (
    <XidProvider
      mode="oidc"
      issuer="https://auth.example.com"
      clientId="client_abc123"
      redirectUri="https://app.example.com/auth/callback"
    >
      <SignedOut>
        <SignInButton />
      </SignedOut>
      <SignedIn>
        <UserButton />
      </SignedIn>
    </XidProvider>
  )
}
```

provider の内側では、`useUser()` が `isLoaded` と `isSignedIn` による判別可能 union を返し、`useAuth()` が
`getToken` と `signOut` を公開する。organization、session、API key の hook も同じ形をとる。サーバー側では
`@xid-kit/backend` の `verifyToken` が networkless であり、すでに手元にある JWKS を渡せば isolate の外へは
何も出ない。

```ts
import { verifyToken } from '@xid-kit/backend'

const result = await verifyToken(accessToken, {
  jwtKey: jwks, // a JWK, a JWKS, or an imported CryptoKey
  issuer: 'https://auth.example.com',
  authorizedParties: ['app_123'],
})

if (!result.ok) {
  return new Response('unauthorized', { status: 401 }) // result.error names the failed check
}
const userId = result.value.sub
```

`authenticateRequest(request, options)` は同じ検査を `Request` 全体に対して行うラッパーであり、
`verifyWebhook(request, options)` は受信 webhook の署名を検証する。

### セルフホスティング

Node >= 22.12 と pnpm 10.33.4 が必要である。D1、KV、Queues、SQLite ベースの Durable Objects はいずれも
Workers Free の枠を持つが、`send_email` binding で任意の宛先にメールを送るには Workers Paid が要る。
したがって検証メール、magic link、ワンタイムコードを実際に配信する配備には有料プランが必要となる。

```bash
git clone https://github.com/StringKe/xid.git
cd xid && pnpm install

# create the resources the Core Worker binds to
cd apps/server
npx wrangler d1 create xid-db
npx wrangler kv namespace create CACHE
npx wrangler r2 bucket create xid-storage
pnpm --dir ../.. run cloudflare:queues:create
```

Queue script は `apps/server/wrangler.jsonc` から必要な 24 resource を導出する。内訳は source Queue
8 個、source ごとの dead-letter Queue 8 個、persistence failure quarantine Queue 8 個である。
廃止済みの共有 `xid-dlq` は作成しない。

続いて `apps/server/wrangler.jsonc`、`apps/console/wrangler.jsonc`、
`apps/site/wrangler.jsonc` の upstream account と route の値を自分のものに置き換え、
`apps/site/astro.config.ts` の canonical public origin を自分の HTTPS apex URL に設定する。Core の
設定には D1 の `database_id` と KV namespace の `id` も必要である。self-host 用テンプレートはなく、
**upstream の値を残したままでは 3 Worker は正しく deploy できない**。11 個の Durable Object binding、
Analytics Engine dataset、`send_email` binding、2 つの cron trigger は Core だけに属し、すでに宣言済みである。

secret を設定し、ローカルで検証し、Workers Builds を接続する。3 つの production build が成功してから
初期化を行う。`KEK` を失えばすべての署名鍵と保存済み provider 資格情報が復号不能になり、`PEPPER` を
失えばすべてのパスワードハッシュが無効になる。まず両方を Cloudflare の外にバックアップすること。

```bash
openssl rand -base64 32 | npx wrangler secret put KEK
openssl rand -base64 32 | npx wrangler secret put PEPPER
npx wrangler secret put BOOTSTRAP_TOKEN   # strongly recommended before first bootstrap

cd ../..
pnpm check
pnpm test
pnpm run build
pnpm smoke:three-workers
```

`xid`、`xid-console`、`xid-site` を、この Git repository に接続する 3 つの Cloudflare Workers
Builds project として構成する。Production branch は `main`、non-production branch build と Worker
Preview URLs は無効にし、[`docs/deployment.md`](docs/deployment.md) の root、build、deploy command を
使う。review 済みかつ署名済みの commit を `main` に merge すると、Workers Builds が remote D1
migration を適用して 3 Worker を deploy する。build がすべて成功した後:

```bash
curl -X POST https://<your-domain>/admin/bootstrap \
  -H 'content-type: application/json' \
  -H 'X-Bootstrap-Token: <BOOTSTRAP_TOKEN>' \
  --data '{"primaryDomain":"<your-domain>","mode":"multi_tenant","adminEmail":"<you@example.com>"}'
```

bootstrap は instance、既定の organization、instance の ES256 署名鍵、そして最初の `instance_manager`
ユーザーを作成する。二度目の実行は拒否される。ローカルでの D1 migration、seeding、3 Worker の release
順序と rollback を含む完全な手順は [`docs/deployment.md`](docs/deployment.md) にある。self-host release
では Core、Console、Site をすべて deploy する。Site は apex、8 locale docs、SEO、Pagefind、agent
surfaces、`www` 308 を、Console は `/console` と `/console/*` を担当する。

### 開発

```bash
pnpm run dev                   # Core, Console, and Nimbus Site development servers
pnpm test                      # Vitest across the workspace
pnpm run check                 # typecheck, lint, i18n, protocol and coverage gates
pnpm run build                 # all packages and all three Workers
pnpm smoke:three-workers       # local route ownership and cross-Worker smoke test
```

`pnpm run check` は 2 回の coverage 実行を含む完全なゲートであって、手軽な lint ではない。内部で
`native:verify` を呼ぶが、`XID_NATIVE_SDK_PLATFORM` が未設定ならネイティブ SDK の契約マトリクスを
検証するだけなので、native toolchain は要らない。GitHub Actions は検証のみを行い、deploy は一切しない。
production への配備はリポジトリ所有者のアカウント上の Cloudflare Workers Builds から実行される。
領域ごとのワークフローは [`CONTRIBUTING.md`](CONTRIBUTING.md) を参照。

## アーキテクチャ

3 つの Worker は一つの hostname を共有するが、runtime binding は共有しない。Nimbus Site は apex
documentation hub、8 locale の docs tree、SEO、Pagefind、Markdown と MDX twins、LLM indexes、`www` から
apex への 308 を担当する。Console は binding を持たない静的 Worker で、apex と tenant host の
`/console` と `/console/*` を担当する。Core は Hosted Auth、account ページ、protocol と API route、
`/_core/*` を担当し、D1、Durable Objects、KV、R2、Queues、email、Analytics Engine、cron binding を
持つ唯一の Worker である。

Core の状態は一貫性の要件で分割している。関係データは D1、直列化が要るもの (WebAuthn challenge、
OAuth state、PAR、device flow、session 失効、レート制限、監査 sequence、メータリング) は Durable
Objects、キャッシュ読み取りは KV、blob は R2、ログインパスから外すべき処理は Queues に置く。

```
apps/site/         Nimbus docs Site: apex hub, localized docs, SEO, Pagefind, agent surfaces, www 308
apps/console/      Binding-free static management UI for /console and /console/*
apps/server/       Identity Core Worker
  worker/          Hono routes, Durable Objects, queue consumers, cron handlers
  src/             React SPA for Hosted Auth and account pages
packages/          23 workspace packages: 15 TypeScript SDKs + 3 public runtime kernels + 5 private implementation packages
sdk/               13 native SDKs
docs/              Design chapters, protocol matrices, SDK matrix, deployment guide
tests/             Cross-workspace gates: protocol source map, native SDK contract, smoke suites
```

public runtime kernel は `protocol`、`crypto`、`types` である。private implementation package は
`webauthn`、`saml`、`db`、`i18n`、`web-ui` である。暗号プリミティブは常に Web Crypto から取り、
XML-DSig は `xmldsigjs` に委譲する。その間にある protocol とビジネスロジックはここで実装している。

## プロトコルサポート

各行は [`docs/protocols/source-map.md`](docs/protocols/source-map.md) のファイルとテストに対応する。

| 領域                                                                   | サポート | 最上位の証跡                        | 備考                                                              |
| ---------------------------------------------------------------------- | -------- | ----------------------------------- | ----------------------------------------------------------------- |
| OAuth 2.x コア (code、PKCE S256、client credentials、refresh rotation) | 実装済み | ローカル protocol client            | implicit と password grant は拒否し、negative test を用意している |
| OIDC コア (ID token、userinfo、logout、session management、hybrid)     | 実装済み | ローカル protocol client            | front-channel と back-channel の logout profile を含む            |
| PAR、DPoP、Device Flow                                                 | 実装済み | ローカル protocol client            | DPoP nonce challenge は未実装                                     |
| Browser-Based Apps と FAPI 2.0 enforcement profile                     | 実装済み | Workers runtime 統合テスト          | ローカル policy 証跡のみ。production conformance は主張しない     |
| JAR、JARM、RAR、mTLS、token exchange、DCR、CIBA                        | 実装済み | Workers runtime 統合テスト          | JWE、remote request-object fetch、`form_post.jwt` は対象外        |
| OpenID Federation                                                      | 実装済み | Workers runtime 統合テスト          | 最小 metadata と registration boundary のみ。trust chain は未実装 |
| SAML 2.0 SP (inbound) と IdP (outbound)                                | 実装済み | ローカルの fake IdP と fake SaaS SP | Okta、Entra ID、Google Workspace に対しては未検証                 |
| SCIM 2.0 Service Provider と outbound provisioning                     | 実装済み | ローカルの fake SaaS SCIM           | 実在の directory や SaaS target に対しては未検証                  |
| WebAuthn、passkey、passkey MFA、AAL2 step-up                           | 実装済み | Workers runtime 統合テスト          | ローカルで EdDSA と packed attestation を含む。AAL3 は未サポート  |
| LDAP direct bind、WS-Federation、SWA、header-based SSO                 | 実装済み | ローカル harness                    | Kerberos はドキュメントのみ                                       |
| social OAuth relying party (Google、GitHub、Microsoft、Apple)          | 実装済み | ローカルの fake provider            | 実在の provider secret や callback では未検証                     |
| Shared Signals、CAEP、RISC                                             | 計画中   | negative route test                 | endpoint は 501 を返し、stream を作らない                         |
| GNAP、UMA、HEART、OID4VP、OID4VCI                                      | 計画中   | negative route test                 | 予約 route は 501 を返し、protocol の実装ではない                 |

## SDK

`packages/` 配下の TypeScript SDK package は 15 個。`core` と `backend`、そして React、Next.js、
Remix、Astro、Vue、Nuxt、Svelte、Solid、Angular、React Native、Expo、Electron、Tauri 向けの framework
binding である。public runtime kernel 3 個 (`crypto`、`protocol`、`types`) と合わせた 18 package が
publishable に設定され、clean なローカル tarball installation test を通過している。残る 5 個
(`db`、`i18n`、`saml`、`web-ui`、`webauthn`) は private implementation package である。外部 npm
registry の公開状態は `UNKNOWN` のままであり、ローカル distribution evidence は registry release
の証明ではない。

`sdk/` 配下のネイティブ SDK が 13 個。Go、Rust、Python、Ruby、PHP、Java、.NET、Windows、iOS、macOS、
Linux、Android、Flutter である。**crates.io、PyPI、Maven Central、RubyGems、Packagist、NuGet、CocoaPods、
pub.dev のいずれにも公開しておらず**、リリースパイプラインも存在しない。ソースから直接利用する形である。
CI は言語ツールチェーンを一切インストールせず、これらのテストスイートも実行しない。CI が検証するのは
`tests/native-sdk-contract.test.mjs` の契約マトリクスである。`pnpm check` が `check` job の中で
`native:verify` を呼び、マトリクス内の各プラットフォーム項目が実在するディレクトリを指していることを
assert する。特定プラットフォームの実際のツールチェーンを動かすのはローカルでの opt-in 操作であり、
`XID_NATIVE_SDK_PLATFORM=go pnpm run native:verify` を使う。プラットフォームごとの成熟度は
[`docs/sdks/platform-matrix.md`](docs/sdks/platform-matrix.md) にある。

## ドキュメント

まず [`docs/README.md`](docs/README.md) から入るとよい。読者別に振り分けている。`docs/` 配下はすべて
英語で書かれており、英語版が正典である。簡体字中国語のミラーが [`docs/zh-Hans/`](docs/zh-Hans/README.md)
にあるが、入口ドキュメントと設計章だけを対象としている。**日本語版のドキュメントは存在しない。**

- プロダクト設計、全 9 章: [`docs/design/`](docs/design/README.md)
- プロトコルマトリクスとギャップ監査: [`docs/protocols/`](docs/protocols/README.md)
- HTTP エンドポイントの契約: [`docs/api-contracts.md`](docs/api-contracts.md)
- セルフホスティング: [`docs/deployment.md`](docs/deployment.md)
- 標準仕様の正典 URL: [`docs/standards-sources.md`](docs/standards-sources.md)

## コントリビュート、セキュリティ、ライセンス

pull request を出す前に [`CONTRIBUTING.md`](CONTRIBUTING.md) を読むこと。toolchain、必須のゲート、
Developer Certificate of Origin の sign-off について書いてある。参加にあたっては
[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) が適用され、コード変更以外の質問は
[`SUPPORT.md`](SUPPORT.md) が扱う。脆弱性について public issue を立ててはならない。報告経路、スコープ、
開示までのタイムラインは [`SECURITY.md`](SECURITY.md) にある。

XID は MIT License の下で提供される。[`LICENSE`](LICENSE) を参照。著作権表示とライセンス本文を保持する
限り、商用利用やクローズドソース製品への組み込みを含め、使用、改変、再配布ができる。
