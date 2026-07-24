# XID

[English](README.md) | [简体中文](README.zh-Hans.md) | 日本語 | [한국어](README.ko.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Español](README.es.md) | [Português (BR)](README.pt-BR.md)

単一の Cloudflare Worker として動作する edge-native な identity platform である。一つの codebase が
OIDC/OAuth Identity Provider、マルチテナント RBAC レイヤ、エンタープライズ SSO federation エンドポイント
(SAML と SCIM)、そして passkey を第一とするホスト型認証 UI を兼ねる。

[![CI](https://img.shields.io/github/actions/workflow/status/StringKe/xid/ci.yml?branch=main&label=CI)](https://github.com/StringKe/xid/actions/workflows/ci.yml) [![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE) [![Runtime](https://img.shields.io/badge/runtime-Cloudflare%20Workers-orange)](https://developers.cloudflare.com/workers/)

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

**プロトコル面**

- OIDC および OAuth 2.x の authorization server: discovery、JWKS、`/authorize`、`/token`、`/userinfo`、
  `/introspect`、`/revoke`、`/end_session`、`/device_authorization`、`/par`、動的クライアント登録
  (RFC 7591/7592)、CIBA backchannel authentication。
- PKCE S256 を必須とする authorization code、client credentials、device code、family 単位の replay 失効を
  伴う refresh rotation、RFC 8693 token exchange。DPoP と mTLS による sender-constrained token、署名付き
  request object (JAR) と署名付き authorization response (JARM)。
- 双方向のエンタープライズ SSO: inbound の SAML 2.0 SP と OIDC RP federation、下流 SaaS 向け outbound の
  SAML 2.0 IdP、さらに LDAP direct bind、WS-Federation、SWA password vaulting、header ベース SSO。
- SCIM 2.0 Service Provider (Users、Groups、PATCH、filter、sort、bulk、ETag/If-Match) と、下流 SaaS
  ターゲットへの outbound provisioning。

**認証**

- 主要な credential としての passkey/WebAuthn: discoverable credential、必須の user verification、
  sign-count によるクローン検出。
- Workers Secrets に置くサーバー側 pepper を併用した Argon2id によるパスワードハッシュ、magic link、
  email/SMS/WhatsApp 経由のワンタイムコード、relying party としての social OAuth。
- TOTP、SMS、第二要素としての passkey、単回限りの backup code による MFA。

**プラットフォーム**

- organization、membership、role、permission、招待、ドメイン検証。
- `/v1/*` 配下の Management API、`/v1/me/*` 配下のセルフサービス account portal、`/v1/platform/*` 配下の
  instance 運用者 API。
- SHA-256 の連鎖ハッシュを持つ append-only 監査ログ、dead-letter queue 付きの署名済み webhook、
  feature flag、使用量メータリング。
- 8 ロケール (en, zh-Hans, ja, ko, fr, de, es, pt-BR) の Hosted UI。catalog は全訳済み。

## クイックスタート

### アプリケーションへの組み込み

`@xid-kit/*` package は **npm に公開していない**。workspace package なので、現時点でこれらを自分の
アプリケーションで使うには、ソースを vendoring するか、このリポジトリを自分の workspace に追加する
ことになる。以下の API が現在の公開インターフェースである。`@xid-kit/react` から:

```tsx
import { XidProvider, SignedIn, SignedOut, SignInButton, UserButton } from '@xid-kit/react'

function App() {
  return (
    <XidProvider publishableKey="pk_test_..." apiUrl="https://auth.example.com">
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

# create the resources this Worker binds to
cd apps/server
npx wrangler d1 create xid-db
npx wrangler kv namespace create CACHE
npx wrangler r2 bucket create xid-storage
for q in xid-email xid-whatsapp xid-sms xid-audit xid-webhook xid-metering xid-dlq; do
  npx wrangler queues create "$q"
done
```

続いて `apps/server/wrangler.jsonc` を編集し、`account_id`、D1 の `database_id`、KV namespace の `id`、
`routes` の各項目を自分のものに置き換える。このファイルは今も upstream プロジェクトの値を持ったままで、
コピー用のテンプレートも存在せず、**未編集のままでは deploy できない**。8 つの Durable Object binding、
Analytics Engine dataset、`send_email` binding、2 つの cron trigger はすでに宣言済みで、変更は要らない。

secret を設定し、migrate、deploy、初期化を行う。`KEK` を失えばすべての署名鍵と保存済み provider 資格情報が
復号不能になり、`PEPPER` を失えばすべてのパスワードハッシュが無効になる。まず両方を Cloudflare の外に
バックアップすること。

```bash
openssl rand -base64 32 | npx wrangler secret put KEK
openssl rand -base64 32 | npx wrangler secret put PEPPER
npx wrangler secret put BOOTSTRAP_TOKEN   # strongly recommended before first bootstrap

npx wrangler d1 migrations apply DB --remote
npx wrangler deploy

curl -X POST https://<your-domain>/admin/bootstrap \
  -H 'content-type: application/json' \
  -H 'X-Bootstrap-Token: <BOOTSTRAP_TOKEN>' \
  --data '{"primaryDomain":"<your-domain>","mode":"multi_tenant","adminEmail":"<you@example.com>"}'
```

bootstrap は instance、既定の organization、instance の ES256 署名鍵、そして最初の `instance_manager`
ユーザーを作成する。二度目の実行は拒否される。ローカルでの D1 migration と seeding を含む完全な手順は
[`docs/deployment.md`](docs/deployment.md) にある。

### 開発

```bash
pnpm --filter @xid-kit/server dev   # Vite dev server: Worker and SPA together
pnpm test                           # Vitest across the workspace
pnpm run check                      # typecheck, lint, i18n, protocol and coverage gates
pnpm run build                      # all packages plus the server
```

`pnpm run check` は 2 回の coverage 実行を含む完全なゲートであって、手軽な lint ではない。内部で
`native:verify` を呼ぶが、`XID_NATIVE_SDK_PLATFORM` が未設定なら CI workflow の契約を検証するだけなので、
native toolchain は要らない。GitHub Actions は検証のみを行い、deploy は一切しない。production への配備は
リポジトリ所有者のアカウント上の Cloudflare Workers Builds から実行される。領域ごとのワークフローは
[`CONTRIBUTING.md`](CONTRIBUTING.md) を参照。

## アーキテクチャ

Worker 一つがすべてを抱える。Hono が protocol エンドポイントと management エンドポイントを提供し、
React 19 の SPA は Workers Assets として配信され、API 以外のパスはそこへフォールバックする。よって
Hosted UI、account portal、二つの console は token エンドポイントと一体で deploy される。状態は一貫性の
要件で分割している。関係データは D1、直列化が要るもの (WebAuthn challenge、OAuth state、PAR、device flow、
session 失効、レート制限、監査 sequence、メータリング) は Durable Objects、キャッシュ読み取りは KV、
blob は R2、ログインパスから外すべき処理は Queues に置く。

```
apps/server/       The Worker
  worker/          Hono routes, Durable Objects, queue consumers, cron handlers
  src/             React SPA: 12 auth pages, 5 account pages, 6 shared console pages,
                   16 organization console pages, 7 platform console pages
packages/          22 workspace packages: 7 kernel libraries + 15 TypeScript SDKs
sdk/               13 native SDKs
docs/              Design chapters, protocol matrices, SDK matrix, deployment guide
tests/             Cross-workspace gates: protocol source map, native SDK contract, smoke suites
```

kernel library である `protocol`、`crypto`、`webauthn`、`saml`、`db`、`i18n`、`types` は Worker の内部専用で
ある。暗号プリミティブは常に Web Crypto から取り、XML-DSig は `xmldsigjs` に委譲する。その間にある
protocol とビジネスロジックはここで実装している。

## プロトコルサポート

各行は [`docs/protocols/source-map.md`](docs/protocols/source-map.md) のファイルとテストに対応する。

| 領域 | サポート | 最上位の証跡 | 備考 |
| --- | --- | --- | --- |
| OAuth 2.x コア (code、PKCE S256、client credentials、refresh rotation) | 実装済み | ローカル protocol client | implicit と password grant は拒否し、negative test を用意している |
| OIDC コア (ID token、userinfo、logout、session management、hybrid) | 実装済み | ローカル protocol client | front-channel と back-channel の logout プロファイルを含む |
| PAR、DPoP、device flow | 実装済み | ローカル protocol client | DPoP の nonce challenge は未実装 |
| JAR、JARM、RAR、mTLS、token exchange、DCR、CIBA、OpenID Federation | 実装済み | Workers runtime 統合テスト | JWE、リモートからの request object 取得、`form_post.jwt` は対象外 |
| SAML 2.0 SP (inbound) と IdP (outbound) | 実装済み | ローカルの fake IdP と fake SaaS SP | Okta、Entra ID、Google Workspace に対しては未検証 |
| SCIM 2.0 Service Provider と outbound provisioning | 実装済み | ローカルの fake SaaS SCIM | 実在のディレクトリや SaaS ターゲットに対しては未検証 |
| WebAuthn / passkey | 実装済み | Workers runtime 統合テスト | バイパス経路のない四段階検証 |
| LDAP direct bind、WS-Federation、SWA、header ベース SSO | 実装済み | ローカル harness | Kerberos はドキュメントのみ |
| social OAuth relying party (Google、GitHub、Microsoft、Apple) | 実装済み | ローカルの fake provider | 実在の provider secret や callback では未検証 |
| Shared Signals、CAEP、RISC | 計画中 | unit test | エンドポイントは 501 を返し、stream を作らない |
| GNAP、UMA、HEART、OID4VP、OID4VCI | スタブ | Workers runtime 統合テスト | 501 かプレースホルダオブジェクトを返す route stub であり、protocol の実装ではない |

## SDK

`packages/` 配下の TypeScript package が 15 個。`core` と `backend`、そして React、Next.js、Remix、Astro、
Vue、Nuxt、Svelte、Solid、Angular、React Native、Expo、Electron、Tauri 向けの framework binding である。
いずれも workspace 内部限定で、**npm には公開していない**。

`sdk/` 配下のネイティブ SDK が 13 個。Go、Rust、Python、Ruby、PHP、Java、.NET、Windows、iOS、macOS、
Linux、Android、Flutter である。**crates.io、PyPI、Maven Central、RubyGems、Packagist、NuGet、CocoaPods、
pub.dev のいずれにも公開しておらず**、リリースパイプラインも存在しない。ソースから直接利用する形である。
代わりに CI が正しさを担保する。6 つの `native-*` job (うち 3 つは matrix 展開で、13 プラットフォームすべてを
カバーする) が `tests/native-sdk-contract.test.mjs` の契約に従って各言語自身のテストスイートを実行する。
pull request では `dorny/paths-filter` の job が、ブランチが触れた SDK ディレクトリと `ci.yml`、契約ファイル
自体へと対象を絞る。`main` への push では毎回 13 プラットフォームすべてを実行する。ローカルで一つだけ
走らせるなら `XID_NATIVE_SDK_PLATFORM=go pnpm run native:verify`。プラットフォームごとの成熟度は
[`docs/sdks/platform-matrix.md`](docs/sdks/platform-matrix.md) にある。

## ドキュメント

まず [`docs/README.md`](docs/README.md) から入るとよい。読者別に振り分けている。設計と運用のドキュメントは
大半が中国語で、protocol マトリクスといくつかの SDK リファレンスページは英語である。

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
